const nodeFetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('../http');
const la18hdEventos = require('./la18hd_eventos');
const matcher = require('./team_matcher');

// ==========================================
// PUENTE CON SPORTS STREAMS (sportsfree-us2.highfly.dev)
// ==========================================
// Mismo concepto que stremverse_bridge.js, pero para otro addon con
// catálogo propio: "Sports Streams" no vive en la pestaña de TV de
// Stremio, es type "sport" (aparece en la pestaña "Sports" / Discover).
// Sus ids usan varios prefijos según de qué mini-fuente interna vienen
// ("streamed", "sf", "recap", "leaf"), no un único prefijo fijo.
//
// A diferencia de StremVerse, no encontramos evidencia de que sus ids
// traigan los equipos codificados adentro -- así que acá se depende del
// nombre que devuelve su propio endpoint de meta. Si en el futuro se
// confirma un esquema de id parecido al de StremVerse, agregar acá un
// decodeTeamsFromId() análogo (ver stremverse_bridge.js).
// ==========================================

const SF_BASE = (process.env.SPORTSFREE_BASE || 'https://sportsfree-us2.highfly.dev').replace(/\/+$/, '');
const SF_TYPE = 'sport';
const SF_ID_PREFIXES = ['streamed', 'sf', 'recap', 'leaf'];

async function fetchJson(url) {
  const res = await nodeFetch(url, {
    headers: { ...DEFAULT_HEADERS, Accept: 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

const META_TTL_MS = 10 * 60 * 1000;
const _metaCache = new Map();

async function getSportsFreeText(id) {
  const cached = _metaCache.get(id);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.text;

  const candidates = [id];
  if (id.includes(':')) candidates.push(id.slice(0, id.lastIndexOf(':')));

  let lastErr;
  for (const cid of candidates) {
    try {
      const data = await fetchJson(`${SF_BASE}/meta/${SF_TYPE}/${encodeURIComponent(cid)}.json`);
      const meta = data && data.meta;
      if (!meta) throw new Error('respuesta sin "meta"');
      let text = meta.name || '';
      if (Array.isArray(meta.videos)) {
        const v = meta.videos.find((x) => x && x.id === id);
        if (v && v.title) text += ` ${v.title}`;
      }
      if (!text.trim()) throw new Error('meta sin nombre');
      _metaCache.set(id, { text, at: Date.now() });
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no se pudo leer el meta de Sports Streams');
}

async function getStreamsForSportsFreeId(id) {
  let text;
  try {
    text = await getSportsFreeText(id);
  } catch (e) {
    console.log(`[sportsfree] no se pudo obtener el meta de ${id}: ${e.message}`);
    return [];
  }

  const groups = await la18hdEventos.getGroupedEvents();
  const match = matcher.bestMatch(groups, text);

  if (!match) {
    console.log(`[sportsfree] sin match en LA18HD para "${text}"`);
    return [];
  }

  console.log(
    `[sportsfree] "${text}" -> "${match.event.title}" (score ${match.score.toFixed(2)}, ${match.event.sources.length} fuente(s))`
  );
  return la18hdEventos.getStreamsForGroup(match.event);
}

module.exports = {
  SF_BASE,
  SF_TYPE,
  SF_ID_PREFIXES,
  extractTeams: matcher.extractTeams,
  rankMatches: matcher.rankMatches,
  bestMatch: matcher.bestMatch,
  fetchJson,
  getSportsFreeText,
  getStreamsForSportsFreeId,
};
