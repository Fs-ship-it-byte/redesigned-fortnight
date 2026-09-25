const fetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('./http');

// ==========================================
// PROXY DE HLS (m3u8 + segmentos) -- "liviano"
// ==========================================
// Objetivo: gastar la MÍNIMA banda propia posible en Render. El master.m3u8
// de LA18HD (CDN fubo18.com) trae un token atado al Referer/Origin/UA que lo
// negoció, así que ese archivo sí tiene que pasar por nuestro server (es
// texto, pesa KB). Pero los segmentos .ts (el video real, GB) van DIRECTO al
// CDN -- confirmado que el CDN responde con "Access-Control-Allow-Origin: *",
// o sea es alcanzable cross-origin sin pasar por nosotros. El Referer que
// necesitan lo manda el propio cliente de Stremio vía behaviorHints.
// proxyHeaders (ver src/index.js), no nuestro servidor.

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

// USE_PROXY=1 -> proxy completo: TAMBIÉN los segmentos .ts pasan por
//   nuestro server (máxima compatibilidad, máximo gasto de banda). Usar
//   solo como red de contención si algún canal puntual corta y se
//   confirma que el problema es que el cliente no está mandando bien el
//   proxyHeaders (por ejemplo, un bug conocido en algunos builds de
//   Stremio Android).
// Default (sin setear) -> proxy liviano: solo el manifest pasa por acá,
//   los segmentos van directo al CDN.
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
      // Sub-playlist: sigue pasando por nuestro proxy (liviano, es texto).
      const token = encodeProxyToken(absUrl, headers);
      return `${publicUrl()}/hlsproxy/playlist/${token}/sub.m3u8`;
    }

    // Segmento real: directo al CDN por default. El Referer/Origin/UA que
    // necesita los manda el cliente de Stremio (proxyHeaders), no nosotros.
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
    return `${publicUrl()}/hlsproxy/playlist/${token}/master.m3u8`;
  },
  buildProxyDirectUrl: (targetUrl, headers) => {
    const token = encodeProxyToken(targetUrl, headers);
    return `${publicUrl()}/hlsproxy/direct/${token}/file`;
  },
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
};
