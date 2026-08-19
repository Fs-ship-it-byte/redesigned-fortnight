const { getHtml } = require('../http');

// Portado del addon de referencia (poseidonhd2): extractor genérico de HLS
// mucho más tolerante que un regex simple de "file:'...m3u8'", porque cubre
// el patrón común de "var xxx = { algo: 'url.m3u8' }; sources: xxx.algo || ..."
// que usan streamwish/vidhide/filemoon y sus clones/dominios "mutantes".

function unpackJsVh(p, a, c, k) {
  while (c--) {
    if (k[c]) p = p.replace(new RegExp(`\\b${c.toString(a)}\\b`, 'g'), k[c]);
  }
  return p;
}

function makeAbsoluteVh(url, base) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) {
    try {
      return new URL(base).origin + url;
    } catch (e) {
      return base + url;
    }
  }
  return `${base}/${url}`;
}

function parseJsObjVh(str) {
  try {
    const clean = str
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ':"$1"')
      .replace(/,\s*\}/g, '}');
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

function extractM3u8FromObjVh(obj, base) {
  if (!obj) return null;
  const keys = Object.keys(obj);
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'string' && v.includes('master.m3u8')) return makeAbsoluteVh(v, base);
  }
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'string' && v.includes('.m3u8')) return makeAbsoluteVh(v, base);
  }
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'string' && v.includes('/hls/')) return makeAbsoluteVh(v, base);
  }
  return null;
}

function extractHlsFromPlayerCode(code, base) {
  const sourceRefM = code.match(
    /(?:sources?|file)\s*:\s*(?:\[?\s*\{[^}]*(?:file|src)\s*:\s*)?([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*\.\s*([a-zA-Z0-9_]+)\s*\|\|\s*\1\s*\.\s*([a-zA-Z0-9_]+)(?:\s*\|\|\s*\1\s*\.\s*([a-zA-Z0-9_]+))?/i
  );
  if (sourceRefM) {
    const varName = sourceRefM[1];
    const keys = [sourceRefM[2], sourceRefM[3]];
    if (sourceRefM[4]) keys.push(sourceRefM[4]);
    const varRe = new RegExp(`var\\s+${varName.replace('$', '\\$')}\\s*=\\s*(\\{[\\s\\S]{1,800}?\\})`, 'i');
    const vm = code.match(varRe);
    if (vm) {
      const vo = parseJsObjVh(vm[1]);
      if (vo) {
        for (const k of keys) {
          const kv = vo[k];
          if (kv && kv.includes('.m3u8')) return makeAbsoluteVh(kv, base);
        }
        const fb = extractM3u8FromObjVh(vo, base);
        if (fb) return fb;
      }
    }
  }

  const anyVarM = code.match(/var\s+([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*=\s*(\{[^{}]{10,800}\})/g);
  if (anyVarM) {
    for (const raw of anyVarM) {
      const vm2 = raw.match(/var\s+([a-zA-Z_$][a-zA-Z0-9_$]{0,4})\s*=\s*(\{[^{}]{10,800}\})/);
      if (!vm2) continue;
      if (!vm2[2].includes('m3u8') && !vm2[2].includes('/hls/')) continue;
      const vo2 = parseJsObjVh(vm2[2]);
      if (!vo2) continue;
      const found = extractM3u8FromObjVh(vo2, base);
      if (found) return found;
    }
  }

  const fm = code.match(/(?:file)\s*:\s*["']([^"']+\.(?:m3u8|txt)[^"']*?)["']/i);
  if (fm) return makeAbsoluteVh(fm[1], base);
  const am = code.match(/(https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)/i);
  if (am) return am[1];
  return null;
}

// Extrae y desempaqueta TODOS los bloques eval(function(p,a,c,k,e,d)...) del HTML
// (a veces hay más de uno, o el video real está en un bloque distinto del primero).
function unpackEvalBlocks(html) {
  const evalRegex = /eval\(\s*function\s*\(p,a,c,k,e,[rd]\)[\s\S]*?\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/g;
  let match;
  let unpacked = '';
  while ((match = evalRegex.exec(html)) !== null) {
    const p = match[1];
    const a = parseInt(match[2], 10);
    const c = parseInt(match[3], 10);
    const k = match[4].split('|');
    unpacked += `\n${unpackJsVh(p, a, c, k)}`;
  }
  return unpacked;
}

// Detecta si un embed hace una redirección client-side (JS o meta refresh)
// hacia otro dominio "mutante" (ej: streamwish.to/e/ID -> otroDominio.com/e/ID),
// algo muy común en esta familia de hosts para esquivar bloqueos.
function findMutantRedirect(html, base) {
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
    /location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
    /<meta[^>]+http-equiv\s*=\s*['"]refresh['"][^>]+content\s*=\s*['"][^'">\s]+url=([^'">\s]+)/i,
    /<iframe[^>]+src\s*=\s*['"]([^'"]+\/(?:e|embed)\/[a-zA-Z0-9]+[^'"]*)['"]/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return makeAbsoluteVh(m[1], base);
  }
  return null;
}

/**
 * Resuelve un embed tipo streamwish/vidhide/filemoon/clones: sigue hasta 4
 * saltos de redirección client-side hasta encontrar un .m3u8 real. Devuelve
 * { url, headers } o null si no lo pudo resolver por este camino.
 */
async function resolveMutantHls(embedUrl) {
  const visited = new Set();
  let currentUrl = embedUrl;
  let refererOrigin = 'https://www.google.com/';

  for (let hop = 0; hop < 4; hop++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    let html;
    let finalUrl = currentUrl;
    try {
      html = await getHtml(currentUrl, { headers: { Referer: refererOrigin } });
    } catch (e) {
      return null;
    }

    let origin;
    try {
      origin = new URL(finalUrl).origin;
    } catch (e) {
      return null;
    }

    const unpacked = unpackEvalBlocks(html);
    const hlsUrl = extractHlsFromPlayerCode(`${unpacked}\n${html}`, origin);
    if (hlsUrl) {
      return {
        url: hlsUrl,
        headers: {
          Referer: `${origin}/`,
          Origin: origin,
        },
      };
    }

    const nextUrl = findMutantRedirect(html, origin);
    if (!nextUrl || nextUrl === currentUrl) return null;

    currentUrl = nextUrl;
    refererOrigin = `${origin}/`;
  }
  return null;
}

module.exports = { resolveMutantHls, extractHlsFromPlayerCode, unpackEvalBlocks };
