const puppeteer = require('puppeteer');

// ==========================================
// RESOLUCIÓN VÍA NAVEGADOR HEADLESS (Puppeteer)
// ==========================================
// Por qué hace falta esto: sitios como LA18HD no ponen la URL del .m3u8 en
// ningún <script> estático — se arma vía JS ejecutado en el navegador
// (fetch/XHR del propio reproductor) recién después de que el usuario le
// da play, y de paso el sitio abre popups/pestañas de publicidad. axios/
// fetch normal nunca "ve" nada de eso porque no ejecuta JavaScript. La
// única forma confiable es abrir la página en un Chromium real headless,
// cerrar cualquier popup que se abra (el "adbloker"), simular el click de
// play, e interceptar la petición de red hacia el .m3u8 cuando el propio
// player la dispare.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let _browserInstance = null;
async function getBrowser() {
  if (_browserInstance && _browserInstance.isConnected()) return _browserInstance;
  _browserInstance = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return _browserInstance;
}

/**
 * Abre embedUrl en un navegador headless, cierra cualquier popup de
 * publicidad que se abra, simula clicks de play, e intercepta la
 * respuesta de red hacia un .m3u8 (por URL o por content-type). Devuelve
 * { url, headers } o null si no encontró nada dentro del timeout.
 */
async function resolveM3u8ViaBrowser(embedUrl, { timeoutMs = 20000, trace = null } = {}) {
  let browser;
  let page;
  let onTargetCreated;
  const tStart = Date.now();
  const t = (msg) => {
    if (trace) trace.push(`[${Date.now() - tStart}ms] ${msg}`);
    console.log(`[browser] ${msg}`);
  };

  try {
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    let resolved = null;
    let lastRefererByUrl = 'https://www.google.com/';

    // El "adbloker": cualquier pestaña nueva que el sitio intente abrir
    // (popup/pop-under de publicidad) se cierra al instante, sin dejarla
    // interferir con la página principal.
    onTargetCreated = async (target) => {
      try {
        if (target.opener() === page.target()) {
          t('se abrió un popup (ad), cerrándolo');
          const popup = await target.page();
          if (popup) await popup.close();
        }
      } catch (e) {
        /* noop */
      }
    };
    browser.on('targetcreated', onTargetCreated);

    page.on('request', (req) => {
      const url = req.url();
      const type = req.resourceType();
      // No abortamos 'media': el propio <video> puede pedir el .m3u8
      // directo con ese resourceType, y si lo cortamos nunca lo vemos.
      if (type === 'image' || type === 'font') {
        req.abort();
        return;
      }
      if (!resolved && /\.m3u8(\?|$)/i.test(url)) {
        resolved = {
          url,
          headers: {
            Referer: req.headers()['referer'] || lastRefererByUrl,
            Origin: new URL(url).origin,
            'User-Agent': UA,
          },
        };
        t(`¡match! m3u8 capturado por URL: ${url}`);
      }
      req.continue();
    });

    page.on('response', async (resp) => {
      if (resolved) return;
      try {
        const ct = resp.headers()['content-type'] || '';
        if (/mpegurl|vnd\.apple\.mpegurl/i.test(ct)) {
          const rUrl = resp.url();
          resolved = {
            url: rUrl,
            headers: {
              Referer: resp.request().headers()['referer'] || lastRefererByUrl,
              Origin: new URL(rUrl).origin,
              'User-Agent': UA,
            },
          };
          t(`¡match! manifest detectado por content-type "${ct}": ${rUrl}`);
        }
      } catch (e) {
        /* noop */
      }
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        lastRefererByUrl = frame.url();
      }
    });

    t(`goto ${embedUrl}`);
    try {
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs, referer: 'https://www.google.com/' });
    } catch (e) {
      t(`goto falló/timeout: ${e.message}`);
    }

    const viewport = page.viewport() || { width: 1280, height: 720 };
    const centerX = Math.floor(viewport.width / 2);
    const centerY = Math.floor(viewport.height / 2);

    const start = Date.now();
    let lastClickAt = 0;
    while (!resolved && Date.now() - start < timeoutMs) {
      if (Date.now() - lastClickAt > 2000) {
        lastClickAt = Date.now();
        try {
          await page.mouse.click(centerX, centerY);
        } catch (e) {
          /* noop */
        }
        try {
          await page.evaluate(() => {
            const el = document.querySelector(
              'video, .jw-icon-playback, .vjs-big-play-button, .play-button, #player, .plyr__control--overlaid'
            );
            if (el) el.click();
          });
        } catch (e) {
          /* noop */
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!resolved) t('no se encontró ningún .m3u8 dentro del timeout');
    return resolved;
  } catch (e) {
    t(`error general: ${e.message}`);
    return null;
  } finally {
    if (browser && onTargetCreated) {
      try {
        browser.off('targetcreated', onTargetCreated);
      } catch (e) {
        /* noop */
      }
    }
    if (page) {
      try {
        await page.close();
      } catch (e) {
        /* noop */
      }
    }
  }
}

module.exports = { resolveM3u8ViaBrowser, getBrowser };
