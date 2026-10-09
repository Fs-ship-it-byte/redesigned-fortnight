// ---------------------------------------------------------------------------
// Controles propios del full proxy en vivo: espectadores simultáneos, banda
// diaria y volcado periódico al gateway. Todo en memoria (el gateway guarda
// los totales en D1, así el addon no depende del disco de Render).
// ---------------------------------------------------------------------------
const fetch = require('node-fetch');

const GATEWAY_SECRET = process.env.GATEWAY_SECRET || '';
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/+$/, '');
const GLOBAL_DAILY_BYTES = Math.max(0, parseFloat(process.env.GLOBAL_DAILY_GB || '0')) * 1e9;
const FLUSH_MS = Math.max(60000, parseInt(process.env.FLUSH_INTERVAL_MS || '600000', 10));
const PLAYLIST_WINDOW_MS = 30000;   // activo = visto en los últimos 30 s
const DIRECT_WINDOW_MS = 90000;     // mp4 directo: el player puede pausar la descarga

// IPv6: se agrupa por /64 (una misma casa rota direcciones dentro de su prefijo).
function normIp(ip) {
  ip = String(ip || 'unknown').toLowerCase();
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}
const day = () => new Date().toISOString().slice(0, 10);
let today = day();
const watchToday = new Map();   // acct -> segundos de hoy con al menos un espectador activo
const pendingWatch = new Map(); // acct -> segundos sin volcar
const lastTick = new Map();     // acct -> última actividad (ms)
const bytesToday = new Map();   // acct -> bytes de hoy (incluye lo ya volcado)
const pending = new Map();      // acct -> bytes aún sin volcar
let globalToday = 0;
const viewers = new Map();      // acct -> Map("ip|canal" -> { t, win })
let blocked = new Set();        // cuentas suspendidas/revocadas (las manda el gateway)
let lastFlush = 0;

function rollDay() {
  const d = day();
  if (d !== today) { today = d; bytesToday.clear(); pending.clear(); watchToday.clear(); pendingWatch.clear(); lastTick.clear(); globalToday = 0; }
}

function isBlocked(acct) { return blocked.has(acct); }

// --- Espectadores -----------------------------------------------------------
function freshKeys(acct, now) {
  const m = viewers.get(acct);
  if (!m) return [];
  const out = [];
  for (const [k, v] of m) {
    if (now - v.t <= v.win) out.push(k); else if (now - v.t > 300000) m.delete(k);
  }
  return out;
}

// Registra/renueva el latido. Devuelve false si ya hay `max` espectadores
// distintos (ip+canal) y este no es uno de ellos.
function touchViewer(acct, ip, channel, max, kind) {
  ip = normIp(ip);
  const now = Date.now();
  const key = `${ip}|${channel}`;
  const win = kind === 'd' ? DIRECT_WINDOW_MS : PLAYLIST_WINDOW_MS;
  let m = viewers.get(acct);
  if (!m) { m = new Map(); viewers.set(acct, m); }
  const cur = m.get(key);
  if (cur && now - cur.t <= cur.win) { cur.t = now; cur.win = Math.max(cur.win, win); tick(acct, now); return 'renew'; }
  if (freshKeys(acct, now).length >= Math.max(1, max)) return false;
  m.set(key, { t: now, win });
  tick(acct, now);
  return 'new';
}

// Tiempo de visualización: segundos de reloj con al menos un espectador activo (no suma dispositivos).
// Cada actividad suma el hueco desde la anterior de la cuenta, siempre que sea de <= 30 s (si no, hubo pausa).
function tick(acct, now) {
  rollDay();
  const last = lastTick.get(acct);
  lastTick.set(acct, now);
  if (!last) return;
  const gap = (now - last) / 1000;
  if (gap > 0 && gap <= 30) {
    watchToday.set(acct, (watchToday.get(acct) || 0) + gap);
    pendingWatch.set(acct, (pendingWatch.get(acct) || 0) + gap);
  }
}
function overWatch(acct, limitSec) {
  rollDay();
  return limitSec > 0 && (watchToday.get(acct) || 0) >= limitSec;
}

// ¿Ya está al límite este cliente? (para avisar antes, en /stream)
function atLimit(acct, ip, max) {
  ip = normIp(ip);
  const now = Date.now();
  const keys = freshKeys(acct, now);
  if (keys.some((k) => k.startsWith(ip + '|'))) return false; // ya es uno de los suyos
  return keys.length >= Math.max(1, max);
}
function activeCount(acct) { return freshKeys(acct, Date.now()).length; }
// { cuenta: espectadores activos ahora } (solo cuentas con al menos uno)
function snapshot() {
  const out = {};
  for (const a of viewers.keys()) { const n = activeCount(a); if (n > 0) out[a] = n; }
  return out;
}
// Para diagnóstico: canal y antigüedad de cada espectador activo (sin IPs).
function detail() {
  const now = Date.now(), out = {};
  for (const [a, m] of viewers) {
    const list = [];
    for (const [k, v] of m) if (now - v.t <= v.win) list.push({ canal: k.slice(k.indexOf('|') + 1), hace_s: Math.round((now - v.t) / 1000) });
    if (list.length) out[a] = list;
  }
  return out;
}

// --- Banda ------------------------------------------------------------------
function overQuota(acct, limitBytes) {
  rollDay();
  if (GLOBAL_DAILY_BYTES && globalToday >= GLOBAL_DAILY_BYTES) return 'global';
  if (limitBytes > 0 && (bytesToday.get(acct) || 0) >= limitBytes) return 'cuenta';
  return null;
}
function addBytes(acct, n) {
  if (!n) return;
  rollDay();
  bytesToday.set(acct, (bytesToday.get(acct) || 0) + n);
  pending.set(acct, (pending.get(acct) || 0) + n);
  globalToday += n;
}

// --- Volcado al gateway -----------------------------------------------------
async function flush(force) {
  if (!GATEWAY_URL) return;
  rollDay();
  const now = Date.now();
  if (!force && !pending.size && !pendingWatch.size && now - lastFlush < 30 * 60000) return;
  const deltas = Object.fromEntries(pending);
  const watch = Object.fromEntries([...pendingWatch].map(([a, v]) => [a, Math.round(v)]).filter(([, v]) => v > 0));
  try {
    const r = await fetch(`${GATEWAY_URL}/internal/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Secret': GATEWAY_SECRET },
      body: JSON.stringify({ day: today, deltas, watch }),
      timeout: 8000,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    for (const a of Object.keys(deltas)) pending.set(a, (pending.get(a) || 0) - deltas[a]);
    for (const [a, v] of [...pending]) if (v <= 0) pending.delete(a);
    for (const [a, v] of Object.entries(watch)) pendingWatch.set(a, Math.max(0, (pendingWatch.get(a) || 0) - v));
    for (const [a, v] of [...pendingWatch]) if (v < 1) pendingWatch.delete(a);
    blocked = new Set(Array.isArray(j.blocked) ? j.blocked : []);
    if (j.totals && j.day === today) {
      // el gateway manda el total de hoy; nos quedamos con el mayor (por si reiniciamos)
      for (const [a, v] of Object.entries(j.totals)) {
        if (v > (bytesToday.get(a) || 0)) bytesToday.set(a, v);
      }
      if (j.watchTotals) for (const [a, v] of Object.entries(j.watchTotals)) if (v > (watchToday.get(a) || 0)) watchToday.set(a, v);
      globalToday = Math.max(globalToday, Object.values(j.totals).reduce((s, v) => s + v, 0));
    }
    lastFlush = now;
  } catch (e) {
    console.log(`[live] volcado al gateway falló: ${e.message}`);
  }
}

function start() {
  flush(true); // al arrancar: recupera los totales de hoy y la lista de bloqueados
  setInterval(() => flush(false), FLUSH_MS).unref();
  setInterval(() => { for (const a of viewers.keys()) freshKeys(a, Date.now()); }, 120000).unref();
}
async function shutdown() {
  await Promise.race([flush(true), new Promise((r) => setTimeout(r, 4000))]);
}

module.exports = { touchViewer, atLimit, activeCount, snapshot, detail, normIp, overWatch, overQuota, addBytes, isBlocked, flush, start, shutdown };
