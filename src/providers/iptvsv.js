const crypto = require('crypto');
const fetch = require('node-fetch');

// ==========================================================================
// IPTV-SV -- lista M3U pública (github.com/JMigue85/IPTV-SV) leída en vivo.
//
// No se copia nada al repo: la lista se descarga de GitHub y se guarda en
// memoria IPTVSV_TTL_SECONDS (600 por defecto). Si GitHub falla, se sigue
// usando la última copia buena. Cuando el autor actualiza la lista, aquí se
// refleja sola (como mucho tras el TTL).
//
// Las entradas "Canal X [Opc.2]", "[Opc.3]" se agrupan en un solo canal con
// varias opciones de stream.
//
// Los streams se entregan SIEMPRE directos (la URL de la lista tal cual, con las
// cabeceras User-Agent/Referer como proxyHeaders para Stremio). No usa el proxy
// HLS de Render ni sus topes.
//
// Variables de entorno (todas opcionales):
//   DISABLE_IPTVSV=1         no publica el catálogo ni resuelve streams
//   IPTVSV_M3U_URL=...       otra lista (URL raw)
//   IPTVSV_TTL_SECONDS=600   cuánto se reutiliza la lista antes de volver a bajarla
// ==========================================================================

const PREFIX = 'iptvsv';
const DISABLED = process.env.DISABLE_IPTVSV === '1';
const M3U_URL = process.env.IPTVSV_M3U_URL || 'https://raw.githubusercontent.com/JMigue85/IPTV-SV/main/IPTVSV.m3u';
const TTL_MS = Math.max(30, parseInt(process.env.IPTVSV_TTL_SECONDS || '600', 10)) * 1000;
const PAGE = 100;

// Categorías conocidas (solo para el desplegable del manifest; el catálogo
// acepta cualquier categoría aunque no esté aquí).
const GENRES = ["El Salvador - TCS","El Salvador","Guatemala","Honduras","Costa Rica","México","Colombia","Ecuador","Perú","Chile","Argentina","Paraguay","República Dominicana","Venezuela","Bolivia","España","Anime","Doramas / Asia","Fashion","Cine / Películas","Cine / Películas Premium","Entretenimiento Premium","Entretenimiento / Cine / Series","Telemundo Noticias","Tecnología","Documentales y Cultura","Informativos","Infantiles","Música","FIFA+","Sky Sports","Tigo Sports / Fox","Deportes","DSports","FOX Sports","Win Sports","Movistar Deportes","ESPN","Religiosos","TV Chichicasteca","Canela TV","FreeTV","Sony Channels","Rakuten TV","LG Channels","RUN:TIME TV"];

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---------- descarga + parseo ----------
function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const byKey = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('#EXTINF')) continue;
    const attr = (k) => (l.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
    const cut = l.lastIndexOf('",');
    const rawName = l.slice(cut >= 0 ? cut + 2 : l.indexOf(',') + 1).trim();
    const headers = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith('#EXTVLCOPT:http-user-agent=')) headers['User-Agent'] = t.split('=').slice(1).join('=');
      else if (t.startsWith('#EXTVLCOPT:http-referrer=')) headers['Referer'] = t.split('=').slice(1).join('=');
      else if (t.startsWith('#')) continue;
      else break;
    }
    const url = (lines[j] || '').trim();
    i = Math.max(i, j);
    if (!rawName || !/^https?:\/\//i.test(url)) continue;

    const optMatch = rawName.match(/\s*\[Opc\.?\s*(\d+)\]\s*$/i);
    const name = rawName.replace(/\s*\[Opc\.?\s*\d+\]\s*$/i, '').trim();
    const group = attr('group-title') || 'Otros';
    const key = group + '|' + name;
    let ch = byKey.get(key);
    if (!ch) {
      ch = { id: PREFIX + ':' + sha(key), name, group, logo: attr('tvg-logo'), options: [] };
      byKey.set(key, ch);
    }
    if (!ch.logo) ch.logo = attr('tvg-logo');
    ch.options.push({ label: optMatch ? 'Opc. ' + optMatch[1] : '', url, headers });
  }
  return [...byKey.values()];
}

let _cache = { at: 0, list: [], byId: new Map() };
let _inflight = null;
async function loadChannels() {
  if (DISABLED) return [];
  if (_cache.list.length && Date.now() - _cache.at < TTL_MS) return _cache.list;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await fetch(M3U_URL, { timeout: 15000 });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = parseM3u(await r.text());
      if (!list.length) throw new Error('lista vacía');
      _cache = { at: Date.now(), list, byId: new Map(list.map((c) => [c.id, c])) };
      console.log('[iptvsv] ' + list.length + ' canales cargados');
    } catch (e) {
      console.log('[iptvsv] no se pudo actualizar la lista (' + e.message + '); se usa la copia anterior (' + _cache.list.length + ')');
      _cache.at = Date.now() - TTL_MS + 60000; // reintenta en 1 minuto
    } finally {
      _inflight = null;
    }
    return _cache.list;
  })();
  return _inflight;
}

// ---------- catálogo ----------
const poster = (c) =>
  c.logo || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(c.name) + '&size=256&background=0EA5E9&color=fff&bold=true&format=png&length=3';

const toMeta = (c) => ({
  id: c.id,
  type: 'tv',
  name: c.name,
  poster: poster(c),
  posterShape: 'square',
  logo: poster(c),
  genres: [c.group],
});

async function getCatalog(extra = {}) {
  let list = await loadChannels();
  if (extra.genre) list = list.filter((c) => c.group === extra.genre);
  const skip = Math.max(0, parseInt(extra.skip || '0', 10) || 0);
  return list.slice(skip, skip + PAGE).map(toMeta);
}

async function search(query) {
  const q = fold(query);
  if (!q) return [];
  const list = await loadChannels();
  return list.filter((c) => fold(c.name).includes(q)).slice(0, PAGE).map(toMeta);
}

async function getMeta(id) {
  await loadChannels();
  const c = _cache.byId.get(id);
  return c ? toMeta(c) : null;
}

// ---------- streams (siempre directos) ----------
async function getStreams(id) {
  await loadChannels();
  const c = _cache.byId.get(id);
  if (!c) return [];
  return c.options.map((o) => {
    const hasHeaders = Object.keys(o.headers).length > 0;
    const hints = {};
    if (hasHeaders) hints.proxyHeaders = { request: o.headers };
    if (hasHeaders || !/^https:/i.test(o.url)) hints.notWebReady = true;
    return {
      name: 'IPTV-SV' + (o.label ? ' ' + o.label : ''),
      title: c.name,
      url: o.url,
      behaviorHints: hints,
    };
  });
}

module.exports = { PREFIX, GENRES, getCatalog, search, getMeta, getStreams, parseM3u };
