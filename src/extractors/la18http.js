// ==========================================
// Resolver canales de LA18HD SIN navegador (un par de GET normales).
//
// Hay dos páginas que devuelven el m3u8 directamente si se piden con el encabezado
// "Sec-Fetch-Dest: iframe" (hacen pasar la petición por la de un <iframe>):
//   - espejo:  https://tvf90.com/5.php?stream=<slug>          -> ... playbackURL = "<m3u8>"
//   - oficial: https://la18hd.su/vivo/canal.php?stream=<slug> -> ... "src":"<m3u8>"
// Antes de devolver la URL se comprueba que la lista HLS responda (#EXTM3U): si el canal no tiene
// señal se descarta y el que llama cae al navegador, igual que antes.
//
// Variables de entorno (opcionales):
//   LA18_HTTP=0              desactiva este camino (se usa solo el navegador)
//   LA18_TVF90_URL / LA18_MAIN_URL   cambian los dominios (si LA18HD cambia de dirección)
// ==========================================
const { DEFAULT_HEADERS } = require('../http');
const { fetchSafe } = require('../hlsproxy');

const TIMEOUT_MS = 5000;
const SLUG_RE = /^[A-Za-z0-9_-]{1,40}$/;

const mirrorBase = () => (process.env.LA18_TVF90_URL || 'https://tvf90.com').replace(/\/+$/, '');
const mainBase = () => (process.env.LA18_MAIN_URL || 'https://la18hd.su').replace(/\/+$/, '');
const unslash = (s) => String(s).replace(/\\\//g, '/');

async function getText(url, headers) {
  const r = await fetchSafe(url, { 'User-Agent': DEFAULT_HEADERS['User-Agent'], 'Accept-Language': 'es-419,es;q=0.9', ...headers }, TIMEOUT_MS);
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

// "playbackURL = "..."" puede traer la URL en claro o en base64 (atob). Se decodifica solo mientras
// no parezca una URL (máx. 3 veces) para no estropear una URL que ya está bien.
function pickUrl(raw) {
  let u = unslash(raw);
  for (let i = 0; i < 3 && !/^https?:\/\//i.test(u); i++) {
    try { u = Buffer.from(u, 'base64').toString('utf8'); } catch (e) { return ''; }
  }
  return /^https?:\/\/\S+$/i.test(u) ? u : '';
}

async function viaMirror(slug) {
  const r = await getText(`${mirrorBase()}/5.php?stream=${encodeURIComponent(slug)}`, {
    Referer: `${mirrorBase()}/`,
    'Sec-Fetch-Dest': 'iframe',
  });
  const m = r.ok && /playbackURL\s*=\s*(?:atob\()?"([^"]+)"/.exec(r.text);
  return m ? pickUrl(m[1]) : '';
}

async function viaOfficial(slug) {
  const r = await getText(`${mainBase()}/vivo/canal.php?stream=${encodeURIComponent(slug)}`, {
    'Sec-Fetch-Dest': 'iframe',
  });
  const m = r.ok && /"src"\s*:\s*"([^"]+)"/.exec(r.text);
  return m ? pickUrl(m[1]) : '';
}

// true = lista HLS viva · false = el servidor dice que no hay señal · null = no se pudo comprobar
async function isLive(url, headers) {
  try {
    const r = await fetchSafe(url, headers, TIMEOUT_MS);
    const body = await r.text();
    if (r.status >= 400) return false;
    return /^\s*#EXTM3U/.test(body);
  } catch (e) {
    return null;
  }
}

/**
 * @returns {Promise<{url:string, headers:object, via:string}|null>}
 */
async function resolveLa18Http(slug) {
  if (process.env.LA18_HTTP === '0' || !SLUG_RE.test(String(slug || ''))) return null;

  for (const [via, fn] of [['tvf90', viaMirror], ['la18hd', viaOfficial]]) {
    try {
      let url = await fn(slug);
      if (!url) continue;
      if (url.includes('/mono.m3u8')) url = url.replace('/mono.m3u8', '/index.m3u8'); // misma regla que el camino del navegador
      const headers = { Referer: `${mainBase()}/`, Origin: new URL(url).origin, 'User-Agent': DEFAULT_HEADERS['User-Agent'] };
      const live = await isLive(url, headers);
      if (live === false) {
        console.log(`[la18http] ${slug} (${via}): sin señal`);
        continue;
      }
      return { url, headers, via };
    } catch (e) {
      console.log(`[la18http] ${slug} (${via}): ${e.message}`);
    }
  }
  return null;
}

module.exports = { resolveLa18Http };
