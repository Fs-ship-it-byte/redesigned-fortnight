const cheerio = require('cheerio');
const nodeFetch = require('node-fetch');
const { getHtml, DEFAULT_HEADERS } = require('../http');
const { isPacked, unpack } = require('./unpacker');

function decodeBase64UntilUnchanged(str) {
  let decoded = str;
  let prev = '';
  while (decoded !== prev) {
    prev = decoded;
    try {
      decoded = Buffer.from(decoded, 'base64').toString('utf8');
    } catch (e) {
      break;
    }
  }
  return decoded;
}

// Los mismos 4 patrones de siempre para esta familia de sitios (comparten
// plantilla: CablevisionHd, DeporTV, LA18HD).
function extractPlaybackUrls(html) {
  const $ = cheerio.load(html);
  const urls = [];

  $('script').each((_, s) => {
    const script = $(s).html() || '';
    const trimmed = script.trim();

    if (script.includes('function(p,a,c,k,e,d)') && isPacked(script)) {
      const unpacked = unpack(script);
      if (unpacked) {
        const m = unpacked.match(/MARIOCSCryptOld\("(.*?)"\)/);
        if (m) {
          const url = decodeBase64UntilUnchanged(m[1]);
          if (url) urls.push(url);
        }
      }
      return;
    }

    if (trimmed.includes('var playbackURL')) {
      const m = script.match(/var playbackURL\s*=\s*"([^"]+)"/) || script.match(/atob\("([^"]+)"\)/);
      if (m) {
        const url = decodeBase64UntilUnchanged(m[1]);
        if (url) urls.push(url);
      }
      return;
    }

    if (trimmed.startsWith("jwplayer.key = '")) {
      const url = script.split('setupPlayer("')[1]?.split('");')[0];
      if (url) urls.push(url);
      return;
    }

    if (trimmed.startsWith('var src = "')) {
      const url = script
        .split('var src = "')[1]
        ?.split('";')[0]
        ?.replace(/\\\//g, '/')
        ?.replace(/\\:/g, ':');
      if (url) urls.push(url);
    }
  });

  return urls;
}

/**
 * Resuelve una página tipo ".../canales.php?stream=XXX" o
 * ".../canal.php?stream=XXX": hay un <iframe> intermedio que hay que
 * seguir, y recién en esa página final aparece el link real (JS
 * empacado/var playbackURL/etc, ver extractPlaybackUrls).
 */
async function resolveCanalesPhp(pageUrl) {
  const html = await getHtml(pageUrl, { headers: { Referer: pageUrl } });
  const $ = cheerio.load(html);
  let iframeSrc = $('iframe').first().attr('src');
  if (!iframeSrc) return [];
  if (!iframeSrc.startsWith('http')) {
    iframeSrc = `https://${new URL(pageUrl).host}${iframeSrc}`;
  }
  const finalHtml = await getHtml(iframeSrc, { headers: { Referer: pageUrl } });
  return extractPlaybackUrls(finalHtml);
}

/** Variante para ".../global1.php?..." / ".../global2.php?...": sin salto de iframe. */
async function resolveGlobalPhp(pageUrl) {
  const res = await nodeFetch(pageUrl, {
    headers: { ...DEFAULT_HEADERS, 'Sec-Fetch-Dest': 'iframe' },
  });
  const html = await res.text();
  return extractPlaybackUrls(html);
}

module.exports = { resolveCanalesPhp, resolveGlobalPhp, extractPlaybackUrls, decodeBase64UntilUnchanged };
