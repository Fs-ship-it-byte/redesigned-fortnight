const cheerio = require('cheerio');
const { getHtml, DEFAULT_HEADERS } = require('../http');
const { resolveCanalesPhp, resolveGlobalPhp } = require('../extractors/canalesphp');
const { resolveGenericEmbed } = require('../extractors/generic');

const PREFIX = 'la18ev';
const MAIN_URL = 'https://la18hd.su';
const EVENTOS_URL = `${MAIN_URL}/eventos/`;

// ==========================================
// SCRAPING DIRECTO DEL HTML -- no es una SPA con API JSON como se
// asumió al principio: /eventos/ devuelve el HTML ya armado con toda la
// data adentro. Estructura real (confirmada por el usuario):
//
// <div class="event" data-category="futbol">
//   <p class="event-name">14:45 - UEFA Nations League: Israel vs Irlanda</p>
//   <div class="iframe-container">
//     <input class="iframe-link" value="https://.../canales.php?stream=disney12">
//     <p class="language_text"></p>
//   </div>
//   <div class="buttons_container">
//     <a class="copy-button" href="...">Ver</a>
//     <button class="status-button status-live">En vivo</button>
//   </div>
// </div>
//
// El MISMO partido aparece repetido como varios <div class="event">
// idénticos en título/hora, cada uno con un link distinto -- eso es
// justo lo que hay que deduplicar.
// ==========================================

const STATUS_LABELS = {
  'status-live': 'En vivo',
  'status-next': 'Pronto',
  'status-finished': 'Finalizado',
};
const STATUS_ORDER = { 'status-live': 0, 'status-next': 1, 'status-finished': 2 };

function parseEventName(text) {
  // "14:45 - UEFA Nations League: Israel vs República de Irlanda"
  const m = (text || '').trim().match(/^(\d{1,2}:\d{2})\s*-\s*(.+)$/);
  if (m) return { time: m[1], title: m[2].trim() };
  return { time: '', title: (text || '').trim() };
}

function statusKeyFromClass(classAttr) {
  const cls = classAttr || '';
  if (cls.includes('status-live')) return 'status-live';
  if (cls.includes('status-next')) return 'status-next';
  if (cls.includes('status-finished')) return 'status-finished';
  return 'status-next';
}

async function fetchEventsFromHtml() {
  const html = await getHtml(EVENTOS_URL, { headers: { Referer: MAIN_URL } });
  const $ = cheerio.load(html);
  const events = [];

  $('.event').each((_, el) => {
    const $el = $(el);
    const category = $el.attr('data-category') || '';
    const { time, title } = parseEventName($el.find('.event-name').first().text());
    if (!title) return;

    let link = $el.find('.iframe-link').first().attr('value') || $el.find('a.copy-button').first().attr('href') || '';
    link = link.trim();
    if (!link) return;

    const language = $el.find('.language_text').first().text().trim();
    const statusKey = statusKeyFromClass($el.find('.status-button').first().attr('class'));

    events.push({
      category,
      title,
      time,
      status: STATUS_LABELS[statusKey],
      statusKey,
      language,
      link,
    });
  });

  console.log(`[la18hd-eventos] ${events.length} fila(s) crudas extraídas de /eventos/`);
  return events;
}

// ==========================================
// DEDUPLICACIÓN POR PARTIDO -- el mismo partido, varias filas (una por
// link/servidor), colapsan a UN SOLO item de catálogo con todas sus
// fuentes agrupadas adentro.
// ==========================================
function normalizeTitle(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventKey(ev) {
  return `${ev.category}|${ev.time}|${normalizeTitle(ev.title)}`;
}

async function getGroupedEvents() {
  const raw = await fetchEventsFromHtml();
  const groups = new Map();

  for (const ev of raw) {
    const key = eventKey(ev);

    if (!groups.has(key)) {
      groups.set(key, {
        title: ev.title,
        time: ev.time,
        category: ev.category,
        status: ev.status,
        statusKey: ev.statusKey,
        sources: [],
      });
    }

    const group = groups.get(key);
    // Si alguna de las filas del mismo partido está "en vivo" mientras
    // otra ya figura "finalizado" (desincronización entre servidores),
    // preferimos mostrar el estado más "vivo" del grupo.
    if (STATUS_ORDER[ev.statusKey] < STATUS_ORDER[group.statusKey]) {
      group.status = ev.status;
      group.statusKey = ev.statusKey;
    }

    if (!group.sources.some((s) => s.link === ev.link)) {
      group.sources.push({ link: ev.link, language: ev.language || '' });
    }
  }

  const groupList = [...groups.values()];
  // En vivo primero, después próximos, después finalizados; dentro de
  // cada grupo, por hora.
  groupList.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.statusKey] - STATUS_ORDER[b.statusKey];
    if (byStatus !== 0) return byStatus;
    return (a.time || '').localeCompare(b.time || '');
  });

  console.log(`[la18hd-eventos] ${raw.length} fila(s) -> ${groupList.length} partido(s) tras deduplicar`);
  return groupList;
}

function toId(group) {
  const payload = {
    title: group.title,
    time: group.time,
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
  const bits = [];
  if (group.time) bits.push(group.time);
  bits.push(group.title);
  if (group.sources.length > 1) bits.push(`(${group.sources.length} fuentes)`);
  return bits.join(' · ');
}

async function getCatalog() {
  const groups = await getGroupedEvents();
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
  };
}

// Mismos patrones que depotv.js (misma familia de sitios): canales.php
// con salto de iframe intermedio, global1/2.php sin salto, y como último
// recurso el extractor genérico (cubre casos como
// "tarjetarojita.xyz/sw3.html?get=..." que no son de la18hd.su en sí).
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
  EVENTOS_URL,
  getCatalog,
  search,
  getMeta,
  getStreams,
  fetchEventsFromHtml, // expuesta para el endpoint de debug en index.js
};
