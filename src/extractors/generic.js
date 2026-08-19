const { getHtml } = require('../http');
const { isPacked, unpack } = require('./unpacker');
const { resolveMutantHls } = require('./hls');

// Mismos reemplazos que fixHostsLinks() en el CuevanaProvider original de CS3.
function fixHostsLinks(url) {
  return url
    .replace('https://hglink.to', 'https://streamwish.to')
    .replace('https://swdyu.com', 'https://streamwish.to')
    .replace('https://cybervynx.com', 'https://streamwish.to')
    .replace('https://dumbalag.com', 'https://streamwish.to')
    .replace('https://mivalyo.com', 'https://vidhidepro.com')
    .replace('https://dinisglows.com', 'https://vidhidepro.com')
    .replace('https://dhtpre.com', 'https://vidhidepro.com')
    .replace('https://filemoon.link', 'https://filemoon.sx')
    .replace('https://sblona.com', 'https://watchsb.com')
    .replace('https://lulu.st', 'https://lulustream.com')
    .replace('https://uqload.io', 'https://uqload.com')
    .replace('https://do7go.com', 'https://dood.la');
}

const FILE_REGEX = /(?:file|source)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i;
const SOURCES_ARRAY_REGEX = /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i;

/**
 * Intenta resolver un embed genérico (streamwish/vidhidepro/filemoon/etc)
 * a un link directo reproducible.
 *
 * Estrategia en 2 pasos:
 *  1. resolveMutantHls: sigue redirecciones client-side (JS/meta-refresh)
 *     hasta 4 saltos y desempaqueta TODOS los bloques eval() del HTML,
 *     usando el parser de objeto JS más tolerante — cubre la mayoría de
 *     los casos reales de streamwish/vidhidepro/filemoon y sus clones.
 *  2. Si eso falla, un regex simple como último recurso por si el sitio
 *     no usa ninguno de esos patrones.
 *
 * Devuelve { url, type, headers } — headers ya viene listo para pasarle
 * al proxy (Referer/Origin correctos), no solo un string de referer.
 */
async function resolveGenericEmbed(rawUrl, fallbackReferer) {
  const url = fixHostsLinks(rawUrl);

  const viaMutant = await resolveMutantHls(url);
  if (viaMutant) {
    return {
      url: viaMutant.url,
      type: viaMutant.url.includes('.m3u8') ? 'hls' : 'mp4',
      headers: viaMutant.headers,
    };
  }

  // Respaldo: intento simple de una sola página, sin seguir redirecciones.
  let html;
  try {
    html = await getHtml(url, { headers: { Referer: fallbackReferer || url } });
  } catch (e) {
    return null;
  }

  let workingHtml = html;
  if (isPacked(html)) {
    const unpacked = unpack(html);
    if (unpacked) workingHtml = `${unpacked}\n${html}`;
  }

  const m = workingHtml.match(FILE_REGEX) || workingHtml.match(SOURCES_ARRAY_REGEX);
  if (!m) return null;

  const fileUrl = m[1].replace(/\\\//g, '/');
  const isM3u8 = fileUrl.includes('.m3u8');

  return {
    url: fileUrl,
    type: isM3u8 ? 'hls' : 'mp4',
    headers: { Referer: url },
  };
}

module.exports = { resolveGenericEmbed, fixHostsLinks };
