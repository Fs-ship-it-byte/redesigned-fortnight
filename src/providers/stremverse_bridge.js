const nodeFetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('../http');
const la18hdEventos = require('./la18hd_eventos');
const matcher = require('./team_matcher');

// ==========================================
// PUENTE CON STREMVERSE
// ==========================================
// En vez de mostrar un catálogo propio (sin imágenes), este addon se
// declara proveedor de STREAMS para los eventos del catálogo de
// StremVerse (que ya trae posters). Cuando el usuario abre un evento de
// StremVerse, Stremio le pide streams a todos los addons instalados que
// declaren ese prefijo de id ("stremevent_"), incluido éste:
//
//   1. se le pide a StremVerse el meta de ese evento (nombre, ej.
//      "Israel vs Republic of Ireland")
//   2. se empareja por nombres de equipos con la agenda deduplicada de
//      LA18HD (que está en español: "Israel vs República de Irlanda")
//   3. se devuelven TODAS las fuentes de ese partido juntas
//
// El emparejamiento es determinístico (tabla de países ES<->EN + tokens
// + tolerancia a typos), sin depender de ninguna API externa.
// ==========================================

const SV_BASE = (process.env.STREMVERSE_BASE || 'https://stremverse1.alwaysdata.net').replace(/\/+$/, '');
const SV_PREFIX = 'stremevent_';

// ==========================================
// DECODIFICACIÓN DIRECTA DEL ID -- para muchas entradas "merged"
// (nombre genérico tipo "CONCACAF Nations League", "UEFA Nations
// League"), el nombre visible no trae los equipos, pero el propio id sí
// los tiene adentro, en base64 anidado dos veces:
//
//   stremevent_merged_<base64url([[k,v],...])>
//   donde cada v con forma "pro/<base64url>" decodifica a un slug tipo
//   "Competencia-EquipoA-vs-EquipoB<timestamp_unix_ms>"
//
// Ejemplo real:
//   id "stremevent_merged_W1sicyIs..." decodifica a
//   ["CONCACAF Nations League-Guatemala-vs-El Salvador1790580935653", ...]
//   -> equipos: "Guatemala" vs "El Salvador"
//
// Esto evita depender de StremVerse para el nombre del partido: podemos
// sacar los equipos sin red, directo del id que ya tenemos.
// ==========================================
const SV_ID_PREFIXES = [
  'stremevent_playztv_',
  'stremevent_playfy_',
  'stremevent_sktech_',
  'stremevent_xtra2_',
  'stremevent_merged_',
  'stremevent_',
  'highlight_',
  'replay_',
  'ttv:direct_',
].sort((a, b) => b.length - a.length); // más específicos primero

function stripKnownPrefix(id) {
  for (const p of SV_ID_PREFIXES) {
    if (id.startsWith(p)) return id.slice(p.length);
  }
  return null;
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

// "Competencia-EquipoA-vs-EquipoB1790580935653" -> ["EquipoA", "EquipoB"]
function parseSlugTeams(slug) {
  const m = slug.match(/-vs-/i);
  if (!m) return null;
  const left = slug.slice(0, m.index);
  const right = slug.slice(m.index + m[0].length);

  const lastDash = left.lastIndexOf('-');
  const teamA = lastDash === -1 ? left : left.slice(lastDash + 1);

  const teamB = right.replace(/\d{6,}\s*$/, '').trim(); // saca el timestamp pegado al final

  return teamA && teamB ? [teamA.trim(), teamB] : null;
}

function decodeTeamsFromId(id) {
  const body = stripKnownPrefix(id);
  if (!body) return null;

  let arr;
  try {
    arr = JSON.parse(b64urlDecode(body));
  } catch (e) {
    return null; // no todos los ids tienen esta forma (ej. ids simples sin estructura)
  }
  if (!Array.isArray(arr)) return null;

  for (const pair of arr) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const v = pair[1];
    if (typeof v !== 'string' || !v.startsWith('pro/')) continue;
    let slug;
    try {
      slug = b64urlDecode(v.slice(4));
    } catch (e) {
      continue;
    }
    const teams = parseSlugTeams(slug);
    if (teams) return teams;
  }
  return null;
}

// ---------- acceso a StremVerse ----------
async function fetchJson(url) {
  const res = await nodeFetch(url, {
    headers: { ...DEFAULT_HEADERS, Accept: 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

const META_TTL_MS = 10 * 60 * 1000;
const _metaCache = new Map(); // id -> { text, at }

// Devuelve el texto contra el que se empareja (nombre del evento y, si
// el meta trae "videos", el título del video con ese id).
async function getStremverseText(id) {
  const cached = _metaCache.get(id);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.text;

  // Por si Stremio pide un id de "video" (meta_id:algo), probamos también
  // sin el último segmento.
  const candidates = [id];
  if (id.includes(':')) candidates.push(id.slice(0, id.lastIndexOf(':')));

  let lastErr;
  for (const cid of candidates) {
    try {
      const data = await fetchJson(`${SV_BASE}/meta/tv/${encodeURIComponent(cid)}.json`);
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
  throw lastErr || new Error('no se pudo leer el meta de StremVerse');
}

async function getStreamsForStremverseId(id) {
  const groups = await la18hdEventos.getGroupedEvents();

  // Paso 1 (sin red, preferido): los equipos suelen venir codificados
  // adentro del propio id, aunque el "name" que muestra StremVerse sea
  // genérico ("CONCACAF Nations League"). Si esto funciona, ni hace
  // falta pedirle nada a StremVerse.
  const idTeams = decodeTeamsFromId(id);
  if (idTeams) {
    const match = matcher.bestMatchByTeams(groups, idTeams[0], idTeams[1]);
    if (match) {
      console.log(
        `[stremverse] id -> "${idTeams[0]} vs ${idTeams[1]}" -> "${match.event.title}" (score ${match.score.toFixed(2)}, ${match.event.sources.length} fuente(s))`
      );
      return la18hdEventos.getStreamsForGroup(match.event);
    }
    console.log(`[stremverse] id decodificado a "${idTeams[0]} vs ${idTeams[1]}" pero sin match en LA18HD`);
    // seguimos igual al paso 2 por si el nombre público da mejor pista
  }

  // Paso 2 (fallback, con red): pedirle el nombre a StremVerse. Cubre
  // ids que no tienen la estructura de "merged" (ids simples) o casos
  // raros donde decodeTeamsFromId no encontró nada útil.
  let svText;
  try {
    svText = await getStremverseText(id);
  } catch (e) {
    console.log(`[stremverse] no se pudo obtener el meta de ${id}: ${e.message}`);
    return [];
  }

  const match = matcher.bestMatch(groups, svText);
  if (!match) {
    console.log(`[stremverse] sin match en LA18HD para "${svText}"`);
    return [];
  }

  console.log(
    `[stremverse] "${svText}" -> "${match.event.title}" (score ${match.score.toFixed(2)}, ${match.event.sources.length} fuente(s))`
  );
  return la18hdEventos.getStreamsForGroup(match.event);
}

module.exports = {
  SV_BASE,
  SV_PREFIX,
  SV_ID_PREFIXES,
  decodeTeamsFromId,
  // re-exportados desde team_matcher para no romper index.js
  extractTeams: matcher.extractTeams,
  rankMatches: matcher.rankMatches,
  rankMatchesByTeams: matcher.rankMatchesByTeams,
  bestMatch: matcher.bestMatch,
  bestMatchByTeams: matcher.bestMatchByTeams,
  fetchJson,
  getStremverseText,
  getStreamsForStremverseId,
};
