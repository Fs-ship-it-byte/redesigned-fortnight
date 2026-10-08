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

const day = () => new Date().toISOString().slice(0, 10);
let today = day();
const bytesToday = new Map();   // acct -> bytes de hoy (incluye lo ya volcado)
const pending = new Map();      // acct -> bytes aún sin volcar
let globalToday = 0;
const viewers = new Map();      // acct -> Map("ip|canal" -> { t, win })
let blocked = new Set();        // cuentas suspendidas/revocadas (las manda el gateway)
let lastFlush = 0;

function rollDay() {
  const d = day();
  if (d !== today) { today = d; bytesToday.clear(); pending.clear(); globalToday = 0; }
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
  const now = Date.now();
  const key = `${ip}|${channel}`;
  const win = kind === 'd' ? DIRECT_WINDOW_MS : PLAYLIST_WINDOW_MS;
  let m = viewers.get(acct);
  if (!m) { m = new Map(); viewers.set(acct, m); }
  const cur = m.get(key);
  if (cur && now - cur.t <= cur.win) { cur.t = now; cur.win = Math.max(cur.win, win); return true; }
  if (freshKeys(acct, now).length >= Math.max(1, max)) return false;
  m.set(key, { t: now, win });
  return true;
}

// ¿Ya está al límite este cliente? (para avisar antes, en /stream)
function atLimit(acct, ip, max) {
  const now = Date.now();
  const keys = freshKeys(acct, now);
  if (keys.some((k) => k.startsWith(ip + '|'))) return false; // ya es uno de los suyos
  return keys.length >= Math.max(1, max);
}
function activeCount(acct) { return freshKeys(acct, Date.now()).length; }

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
  if (!force && !pending.size && now - lastFlush < 30 * 60000) return;
  const deltas = Object.fromEntries(pending);
  try {
    const r = await fetch(`${GATEWAY_URL}/internal/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Secret': GATEWAY_SECRET },
      body: JSON.stringify({ day: today, deltas }),
      timeout: 8000,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    for (const a of Object.keys(deltas)) pending.set(a, (pending.get(a) || 0) - deltas[a]);
    for (const [a, v] of [...pending]) if (v <= 0) pending.delete(a);
    blocked = new Set(Array.isArray(j.blocked) ? j.blocked : []);
    if (j.totals && j.day === today) {
      // el gateway manda el total de hoy; nos quedamos con el mayor (por si reiniciamos)
      for (const [a, v] of Object.entries(j.totals)) {
        if (v > (bytesToday.get(a) || 0)) bytesToday.set(a, v);
      }
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

module.exports = { touchViewer, atLimit, activeCount, overQuota, addBytes, isBlocked, flush, start, shutdown };
