const fetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('./http');

// ==========================================
// PROXY DE HLS -- SOLO EL MANIFEST (liviano)
// ==========================================
// Confirmado: el manifest (.m3u8, texto, KB) pasa por acá para reescribirlo
// y aplicar headers server-side de forma confiable. Los segmentos .ts (el
// video real, los MB pesados) van DIRECTO al CDN de LA18HD (fubo18.com) --
// confirmado que funciona reproduciendo INTERNO en Stremio Android, gracias
// a que el stream lleva behaviorHints.proxyHeaders (ver src/index.js), que
// hace que el propio cliente mande el Referer/Origin/UA al pedir cada
// segmento. Cero bytes de video pasan por Render.

function publicUrl() {
  return (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 7000}`).replace(
    /\/$/,
    ''
  );
}

function encodeProxyToken(url, headers) {
  return Buffer.from(JSON.stringify({ url, headers: headers || {} }), 'utf8').toString(
    'base64url'
  );
}

function decodeProxyToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function makeAbsolute(url, base) {
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

function isM3u8Url(u) {
  return /\.m3u8(\?|#|$)/i.test(u);
}

// USE_PROXY=1 -> proxy completo (segmentos también por Render). Dejar
//   SOLO como red de contención puntual si algún canal falla -- gasta
//   banda propia, no usar como default.
// Default (sin setear) -> proxy liviano CONFIRMADO: solo el manifest pasa
//   por acá, los segmentos van directo al CDN con proxyHeaders.
const USE_PROXY = process.env.USE_PROXY === '1';

function rewriteM3u8(playlistText, baseUrl, headers) {
  const lines = playlistText.split(/\r?\n/);
  let nextIsPlaylist = false;
  const base = baseUrl.replace(/\/[^/]*$/, '');

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      const upper = trimmed.toUpperCase();

      if (upper.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
        return line.replace(/URI="([^"]+)"/i, (m, uri) => {
          const abs = makeAbsolute(uri, base);
          const token = encodeProxyToken(abs, headers);
          return `URI="${publicUrl()}/hlsproxy/playlist/${token}/sub.m3u8"`;
        });
      }

      const rewritten = line.replace(/URI="([^"]+)"/i, (m, uri) => {
        const abs = makeAbsolute(uri, base);
        const token = encodeProxyToken(abs, headers);
        return `URI="${publicUrl()}/hlsproxy/segment/${token}/seg"`;
      });

      nextIsPlaylist = upper.startsWith('#EXT-X-STREAM-INF');
      return rewritten;
    }

    const absUrl = /^https?:\/\//i.test(trimmed) ? trimmed : makeAbsolute(trimmed, base);
    const isPlaylist = nextIsPlaylist || isM3u8Url(absUrl);
    nextIsPlaylist = false;

    if (isPlaylist) {
      const token = encodeProxyToken(absUrl, headers);
      return `${publicUrl()}/hlsproxy/playlist/${token}/sub.m3u8`;
    }

    if (USE_PROXY) {
      const token = encodeProxyToken(absUrl, headers);
      return `${publicUrl()}/hlsproxy/segment/${token}/seg`;
    }
    return absUrl;
  });

  return out.join('\n');
}

async function handlePlaylistProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: { 'User-Agent': DEFAULT_HEADERS['User-Agent'], ...data.headers },
    });
    if (!upstream.ok) {
      console.log(`[hlsproxy] playlist ${data.url} -> HTTP ${upstream.status}`);
      return res.status(upstream.status).send('No se pudo obtener el playlist');
    }
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, data.url, data.headers);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewritten);
  } catch (e) {
    console.log('[hlsproxy] playlist error', data.url, e.message);
    res.status(502).send('No se pudo obtener el playlist');
  }
}

async function handleSegmentProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        ...data.headers,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    res.status(upstream.status);
    res.set('Access-Control-Allow-Origin', '*');
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) res.set('Content-Length', cl);
    upstream.body.pipe(res);
  } catch (e) {
    res.status(502).send('No se pudo obtener el segmento');
  }
}

async function handleDirectProxy(req, res) {
  const data = decodeProxyToken(req.params.token);
  if (!data) return res.status(400).send('Token inválido');

  try {
    const upstream = await fetch(data.url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        ...data.headers,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      redirect: 'follow',
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        return;
      }
      res.setHeader(key, value);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.body.pipe(res);
  } catch (e) {
    res.status(502).send(`proxy error: ${e.message}`);
  }
}

module.exports = {
  buildProxyPlaylistUrl: (targetUrl, headers) => {
    const token = encodeProxyToken(targetUrl, headers);
    return `${publicUrl()}/hlsproxy/playlist/${token}/index.m3u8`;
  },
  buildProxyDirectUrl: (targetUrl, headers) => {
    const token = encodeProxyToken(targetUrl, headers);
    return `${publicUrl()}/hlsproxy/direct/${token}/file`;
  },
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
};
