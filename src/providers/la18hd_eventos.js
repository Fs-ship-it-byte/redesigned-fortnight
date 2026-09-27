const nodeFetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('../http');
const { resolveCanalesPhp, resolveGlobalPhp } = require('../extractors/canalesphp');
const { resolveGenericEmbed } = require('../extractors/generic');

const PREFIX = 'la18ev';
const MAIN_URL = 'https://la18hd.su';

// ==========================================
// DESCUBRIMIENTO DEL ENDPOINT
// ==========================================
// La página /eventos/ es una SPA -- el HTML estático no trae ningún
// evento, se cargan por JS después. No pudimos inspeccionar el tráfico
// real (bloqueado el scraping automatizado desde donde se armó esto), así
// que probamos en cascada los patrones típicos de esta MISMA familia de
// sitios (ver depotv.js: streamx996.one usa /json/agenda550.json,
// streamtp99a.sbs usa /eventos.json). El primero que responda 200 con un
// array no vacío se cachea y se usa de ahí en más.
//
// Si NINGUNO de estos funciona, pegarle a /debug/la18hd-agenda-candidates
// en el server ya desplegado para ver el detalle de cada intento, y a
// /debug/la18hd-eventos-page para buscar la URL real del JSON dentro del
// HTML/JS de la página (grep de ".json"/"/api/").
const AGENDA_CANDIDATES = [
  '/json/agenda.json',
  '/json/eventos.json',
  '/eventos.json',
  '/json/agenda550.json',
  '/api/eventos',
  '/api/agenda',
  '/json/partidos.json',
];

let _cachedAgendaPath = null;

async function tryFetchAgenda(path) {
  const url = `${MAIN_URL}${path}${path.includes('?') ? '&' : '?'}nocache=${Date.now()}`;
  const res = await nodeFetch(url, {
    headers: { ...DEFAULT_HEADERS, Referer: `${MAIN_URL}/eventos/` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('la respuesta no es un array');
  return data;
}

async function fetchAgendaJson() {
  const paths = _cachedAgendaPath
    ? [_cachedAgendaPath, ...AGENDA_CANDIDATES.filter((p) => p !== _cachedAgendaPath)]
    : AGENDA_CANDIDATES;

  for (const path of paths) {
    try {
      const data = await tryFetchAgenda(path);
      _cachedAgendaPath = path;
      console.log(`[la18hd-eventos] agenda encontrada en ${path} (${data.length} entradas)`);
      return data;
    } catch (e) {
      console.log(`[la18hd-eventos] candidato ${path} falló: ${e.message}`);
    }
  }

  console.log('[la18hd-eventos] ningún endpoint candidato funcionó -- ver /debug/la18hd-agenda-candidates');
  return [];
}

// ==========================================
// DEDUPLICACIÓN POR PARTIDO
// ==========================================
// La agenda cruda trae UNA fila por cada link/servidor -- el mismo
// partido con 3 servidores son 3 filas con el mismo title/time/date pero
// distinto link. Acá se agrupan por la identidad del PARTIDO (no de la
// fuente) para que el catálogo muestre un solo ítem con múltiples
// streams adentro, en vez de 3 entradas idénticas repetidas.
function normalizeTitle(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventKey(ev) {
  return `${ev.category || ''}|${ev.date || ''}|${ev.time || ''}|${normalizeTitle(ev.title)}`;
}

async function getGroupedEvents() {
  const raw = await fetchAgendaJson();
  const groups = new Map();

  for (const ev of raw) {
    if (!ev || !ev.link || !ev.title) continue;
    const key = eventKey(ev);

    if (!groups.has(key)) {
      groups.set(key, {
        title: ev.title,
        time: ev.time || '',
        date: ev.date || '',
        category: ev.category || '',
        status: ev.status || '',
        sources: [],
      });
    }

    const group = groups.get(key);
    if (!group.sources.some((s) => s.link === ev.link)) {
      group.sources.push({ link: ev.link, language: ev.language || '' });
    }
  }

  return [...groups.values()];
}

function toId(group) {
  const payload = {
    title: group.title,
    time: group.time,
    date: group.date,
    category: group.category,
    sources: group.sources,
  };
  return `${PREFIX}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

function displayName(group) {
  const bits = [group.title];
  if (group.time) bits.push(`· ${group.time}`);
  if (group.sources.length > 1) bits.push(`(${group.sources.length} fuentes)`);
  return bits.join(' ');
}

async function getCatalog() {
  const groups = await getGroupedEvents();
  console.log(`[la18hd-eventos] ${groups.length} partido(s) tras deduplicar`);
  return groups.map((g) => ({
    id: toId(g),
    type: 'tv',
    name: displayName(g),
    description: [g.category, g.status].filter(Boolean).join(' · ') || undefined,
  }));
}

async function search(query) {
  const all = await getCatalog();
  const q = query.toLowerCase();
  return all.filter((ev) => ev.name.toLowerCase().includes(q));
}

async function getMeta(id) {
  const g = fromId(id);
  return {
    id,
    type: 'tv',
    name: displayName(g),
    description: [g.category, g.status].filter(Boolean).join(' · ') || undefined,
  };
}

// Mismos patrones de resolución que depotv.js (misma familia de sitios).
async function resolveLink(link) {
  try {
    if (link.includes('canales.php?stream=') || link.includes('canal.php?stream=')) {
      return await resolveCanalesPhp(link);
    }
    if (link.includes('global1.php?') || link.includes('global2.php?')) {
      return await resolveGlobalPhp(link);
    }
  } catch (e) {
    console.log(`[la18hd-eventos] resolveLink falló para ${link}: ${e.message}`);
    return [];
  }
  return [];
}

// Acá está la parte que pediste: un solo partido (un solo id/catálogo)
// puede traer varias "sources" (varios links/servidores) -- todas se
// resuelven y se devuelven como distintas opciones de stream dentro de la
// MISMA ficha, en vez de generar fichas de catálogo repetidas.
async function getStreams(id) {
  const g = fromId(id);
  const streams = [];

  for (const source of g.sources) {
    let urls = [];
    try {
      urls = await resolveLink(source.link);
    } catch (e) {
      console.log(`[la18hd-eventos] error resolviendo ${source.link}: ${e.message}`);
    }

    if (urls.length === 0) {
      const resolved = await resolveGenericEmbed(source.link, source.link).catch(() => null);
      if (resolved) {
        streams.push({
          name: 'LA18HD',
          title: source.language || `Fuente ${streams.length + 1}`,
          url: resolved.url,
          type: resolved.type,
          headers: resolved.headers,
          behaviorHints: { notWebReady: resolved.type === 'hls' },
        });
      }
      continue;
    }

    urls.forEach((url) => {
      streams.push({
        name: 'LA18HD',
        title: source.language || `Fuente ${streams.length + 1}`,
        url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        headers: { Referer: source.link, 'User-Agent': DEFAULT_HEADERS['User-Agent'] },
        behaviorHints: { notWebReady: url.includes('.m3u8') },
      });
    });
  }

  console.log(`[la18hd-eventos] streams resueltos: ${streams.length} de ${g.sources.length} fuente(s)`);
  return streams;
}

module.exports = {
  PREFIX,
  MAIN_URL,
  AGENDA_CANDIDATES,
  getCatalog,
  search,
  getMeta,
  getStreams,
  // expuestas para el endpoint de debug en index.js
  tryFetchAgenda,
};
