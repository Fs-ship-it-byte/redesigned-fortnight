const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('./http');
const live = require('./live');

// ---------------------------------------------------------------------------
// Configuración. El servidor NO arranca si falta algo (ver assertConfig).
// ---------------------------------------------------------------------------
const PROXY_SIGNING_KEY = process.env.PROXY_SIGNING_KEY || '';
const PROXY_SIGNING_KEY_PREV = process.env.PROXY_SIGNING_KEY_PREV || ''; // rotación: acepta ambas al verificar
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
const TEST_MODE = process.env.NODE_ENV === 'test'; // solo para pruebas locales

function assertConfig() {
  const p = [];
  if (PROXY_SIGNING_KEY.length < 16) p.push('PROXY_SIGNING_KEY (mínimo 16 caracteres)');
  if (!/^https?:\/\/[^/]+$/.test(MEDIA_BASE_URL) || (!TEST_MODE && !MEDIA_BASE_URL.startsWith('https://')))
    p.push('MEDIA_BASE_URL (https://<tu-servicio>, sin barra final)');
  if (p.length) { console.error('Configuración inválida o incompleta: ' + p.join(', ')); process.exit(1); }
}

// ---------------------------------------------------------------------------
// SSRF: nunca conectar a localhost / IPs privadas, ni por DNS engañoso ni
// tras redirects. La validación DNS va en el `lookup` del agente, así que se
// comprueba la IP REAL a la que se conecta (sin ventana de DNS rebinding).
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('ff')) return true;
    const m4 = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m4) return isPrivateIp(m4[1]);
    const mh = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mh) {
      const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true;
}
function assertPublicTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { throw new Error('URL inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Protocolo no permitido');
  if (TEST_MODE) return;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('Destino no permitido');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('Destino no permitido');
}
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!TEST_MODE && (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))) return cb(new Error('Destino no permitido'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, lookup: safeLookup }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, lookup: safeLookup }),
};

// fetch con redirects a mano (máx. 3, revalidando cada destino).
async function fetchSafe(url, headers, timeoutMs) {
  let cur = url;
  for (let i = 0; i <= 3; i++) {
    assertPublicTarget(cur);
    const proto = new URL(cur).protocol;
    const r = await fetch(cur, { headers, redirect: 'manual', timeout: timeoutMs, agent: AGENTS[proto] });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      r.body.destroy();
      cur = new URL(r.headers.get('location'), cur).toString();
      continue;
    }
    return r;
  }
  throw new Error('Demasiados redirects');
}

// ---------------------------------------------------------------------------
// Tokens firmados: base64url(JSON) + "." + HMAC-SHA256. Llevan url, headers,
// tipo (p=playlist, s=segmento, d=directo), cuenta, canal y los límites de la
// cuenta (ms=espectadores, bl=bytes diarios) que fijó el gateway en /stream.
// Expiración: playlists y directo 12 h; segmentos 1 h (se re-firman en cada
// refresco). Los exp se redondean a tramos de 15 min para que la URL de un
// mismo segmento sea estable entre refrescos del playlist.
// ---------------------------------------------------------------------------
const TTL = { p: 12 * 3600, s: 3600, d: 12 * 3600 };
function hmac(key, body) { return crypto.createHmac('sha256', key).update(body).digest('base64url'); }
function encodeProxyToken(url, headers, kind, meta) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { u: url, h: headers || {}, k: kind, exp: (Math.floor(now / 900) + 1) * 900 + TTL[kind] };
  if (meta) {
    if (meta.acct) payload.a = String(meta.acct);
    if (meta.ch) payload.ch = String(meta.ch).slice(0, 80);
    if (meta.ms) payload.ms = meta.ms;
    if (meta.bl) payload.bl = meta.bl;
    if (meta.wl) payload.wl = meta.wl;
    if (meta.ip) payload.i = String(meta.ip).slice(0, 64);   // IP real del cliente vista por el gateway
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return body + '.' + hmac(PROXY_SIGNING_KEY, body);
}
function decodeProxyToken(token, kind) {
  try {
    const t = String(token);
    const i = t.lastIndexOf('.');
    if (i < 1) return null;
    const body = t.slice(0, i);
    const given = Buffer.from(t.slice(i + 1));
    const keys = [PROXY_SIGNING_KEY, PROXY_SIGNING_KEY_PREV].filter((k) => k.length >= 16);
    const ok = keys.some((k) => {
      const exp = Buffer.from(hmac(k, body));
      return given.length === exp.length && crypto.timingSafeEqual(given, exp);
    });
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.u !== 'string' || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
    if (kind && p.k !== kind) return null;
    return p;
  } catch (e) { return null; }
}

function makeAbsolute(url, base) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) { try { return new URL(base).origin + url; } catch (e) { return base + url; } }
  return `${base}/${url}`;
}
function isM3u8Url(u) { return /\.m3u8(\?|#|$)/i.test(u); }

function buildProxyPlaylistUrl(targetUrl, headers, meta) {
  return `${MEDIA_BASE_URL}/hlsproxy/playlist/${encodeProxyToken(targetUrl, headers, 'p', meta)}/master.m3u8`;
}
function buildProxyDirectUrl(targetUrl, headers, meta) {
  return `${MEDIA_BASE_URL}/hlsproxy/direct/${encodeProxyToken(targetUrl, headers, 'd', meta)}/file`;
}

// Reescribe el playlist: sub-playlist => /playlist (tipo p); segmento/clave => /segment (tipo s).
function rewriteM3u8(text, baseUrl, headers, meta) {
  const base = baseUrl.replace(/\/[^/]*$/, '');
  const pl = (abs) => `${MEDIA_BASE_URL}/hlsproxy/playlist/${encodeProxyToken(abs, headers, 'p', meta)}/sub.m3u8`;
  const sg = (abs) => `${MEDIA_BASE_URL}/hlsproxy/segment/${encodeProxyToken(abs, headers, 's', meta)}/seg`;
  let nextIsPlaylist = false;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      const up = t.toUpperCase();
      if (up.startsWith('#EXT-X-I-FRAME-STREAM-INF'))
        return line.replace(/URI="([^"]+)"/i, (m, uri) => `URI="${pl(makeAbsolute(uri, base))}"`);
      const out = line.replace(/URI="([^"]+)"/i, (m, uri) => {
        const abs = makeAbsolute(uri, base);
        // #EXT-X-MEDIA (audio/subs alternativos) apunta a otra playlist; KEY/MAP a un archivo
        return `URI="${up.startsWith('#EXT-X-MEDIA') ? pl(abs) : sg(abs)}"`;
      });
      nextIsPlaylist = up.startsWith('#EXT-X-STREAM-INF');
      return out;
    }
    const abs = /^https?:\/\//i.test(t) ? t : makeAbsolute(t, base);
    const isPl = nextIsPlaylist || isM3u8Url(abs);
    nextIsPlaylist = false;
    return isPl ? pl(abs) : sg(abs);
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Handlers (rutas públicas: se protegen SOLO con la firma del token).
// ---------------------------------------------------------------------------
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

const DEBUG = process.env.ENABLE_DEBUG === '1';
// IP real del cliente en ESTA petición, como hace el gateway de VOD con CF-Connecting-IP.
// Render va detrás de Cloudflare: si reenvía esa cabecera, Cloudflare la pone y el cliente no puede falsearla.
// Si no llega, se usa la IP que firmó el gateway en /stream y, en último caso, la del socket.
function cfIp(req) { const v = String(req.headers['cf-connecting-ip'] || '').trim(); return net.isIP(v) ? v : ''; }
function clientIp(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }

// Comprobaciones comunes: cuenta bloqueada, espectadores y banda.
function gate(req, res, data, kind) {
  const acct = data.a || 'anon';
  if (live.isBlocked(acct)) { res.status(403).send('Cuenta suspendida'); return false; }
  // La IP que ve Render NO es fiable (cambia por servidor de Cloudflare o IPv4/IPv6): se usa la que firmó el gateway.
  if (data.ms) {
    const ip = cfIp(req) || data.i || clientIp(req);
    const r = live.touchViewer(acct, ip, data.ch || '-', data.ms, kind);
    if (!r) { res.status(403).send('Límite de reproducciones simultáneas alcanzado'); return false; }
    if (r === 'new' && DEBUG) // diagnóstico: qué IP llega por cada vía (sin tokens)
      console.log(`[viewer] nuevo ch=${data.ch} cf=${req.headers['cf-connecting-ip'] || '-'} xff=${req.headers['x-forwarded-for'] || '-'} req.ip=${req.ip} firmada=${data.i || '-'}`);
  }
  if (live.overQuota(acct, data.bl || 0)) { res.status(429).send('Tope diario de datos alcanzado'); return false; }
  if (live.overWatch(acct, data.wl || 0)) { res.status(429).send('Tope diario de horas alcanzado'); return false; }
  return true;
}

async function handlePlaylistProxy(req, res) {
  const data = decodeProxyToken(req.params.token, 'p');
  if (!data) return res.status(400).send('Token inválido');
  if (!gate(req, res, data, 'p')) return;
  try {
    const up = await fetchSafe(data.u, { 'User-Agent': DEFAULT_HEADERS['User-Agent'], ...data.h }, 15000);
    if (!up.ok) { up.body.destroy(); return res.status(up.status === 404 ? 404 : 502).send('No se pudo obtener el playlist'); }
    const text = await up.text();
    if (text.length > MAX_PLAYLIST_BYTES) return res.status(502).send('Playlist demasiado grande');
    const out = rewriteM3u8(text, data.u, data.h, { acct: data.a, ch: data.ch, ms: data.ms, bl: data.bl, wl: data.wl, ip: data.i });
    live.addBytes(data.a || 'anon', Buffer.byteLength(out));
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(out);
  } catch (e) {
    console.log('[hlsproxy] playlist error:', e.message);
    res.status(502).send('No se pudo obtener el playlist');
  }
}

// Reenvía el cuerpo contando bytes; si el cliente se va, destruye el upstream.
async function pipeCounted(req, res, data, kind, timeoutMs) {
  const acct = data.a || 'anon';
  const hdrs = { 'User-Agent': DEFAULT_HEADERS['User-Agent'], ...data.h, ...(req.headers.range ? { Range: req.headers.range } : {}) };
  const up = await fetchSafe(data.u, hdrs, timeoutMs);
  res.status(up.status);
  res.set('Access-Control-Allow-Origin', '*');
  for (const h of PASS_HEADERS) { const v = up.headers.get(h); if (v) res.set(h, v); }
  const body = up.body;
  const cleanup = () => { try { body.destroy(); } catch (e) {} };
  res.on('close', cleanup);
  body.on('error', (e) => { console.log(`[hlsproxy] ${kind} upstream error: ${e.message}`); res.destroy(); });
  body.on('data', (c) => live.addBytes(acct, c.length));
  body.pipe(res);
}

async function handleSegmentProxy(req, res) {
  const data = decodeProxyToken(req.params.token, 's');
  if (!data) return res.status(400).send('Token inválido');
  if (!gate(req, res, data, 's')) return;
  try { await pipeCounted(req, res, data, 'segmento', 20000); }
  catch (e) { if (!res.headersSent) res.status(502).send('No se pudo obtener el segmento'); else res.destroy(); }
}

async function handleDirectProxy(req, res) {
  const data = decodeProxyToken(req.params.token, 'd');
  if (!data) return res.status(400).send('Token inválido');
  if (!gate(req, res, data, 'd')) return;
  try { await pipeCounted(req, res, data, 'directo', 20000); }
  catch (e) { if (!res.headersSent) res.status(502).send('proxy error'); else res.destroy(); }
}

module.exports = {
  assertConfig, isPrivateIp, encodeProxyToken, decodeProxyToken, rewriteM3u8,
  buildProxyPlaylistUrl, buildProxyDirectUrl,
  handlePlaylistProxy, handleSegmentProxy, handleDirectProxy,
};
