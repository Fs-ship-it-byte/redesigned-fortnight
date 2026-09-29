const nodeFetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('../http');
const la18hdEventos = require('./la18hd_eventos');

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

// ---------- normalización ----------
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Cada grupo: [forma canónica (inglés), ...variantes]. Sirve para que
// "República de Irlanda" (LA18HD) y "Republic of Ireland" (StremVerse)
// terminen siendo el mismo token: "ireland". Los clubes casi siempre se
// escriben igual en ambos idiomas, así que esto es sobre todo para
// selecciones nacionales.
const ALIAS_GROUPS = [
  ['germany', 'alemania'],
  ['greece', 'grecia'],
  ['norway', 'noruega'],
  ['northern ireland', 'irlanda del norte'],
  ['ireland', 'irlanda', 'republic of ireland', 'republica de irlanda', 'rep of ireland', 'eire'],
  ['spain', 'espana'],
  ['france', 'francia'],
  ['italy', 'italia'],
  ['england', 'inglaterra'],
  ['scotland', 'escocia'],
  ['wales', 'gales'],
  ['sweden', 'suecia'],
  ['denmark', 'dinamarca'],
  ['switzerland', 'suiza'],
  ['belgium', 'belgica'],
  ['croatia', 'croacia'],
  ['poland', 'polonia'],
  ['romania', 'rumania'],
  ['hungary', 'hungria'],
  ['turkey', 'turquia', 'turkiye'],
  ['russia', 'rusia'],
  ['ukraine', 'ucrania'],
  ['japan', 'japon'],
  ['morocco', 'marruecos'],
  ['egypt', 'egipto'],
  ['tunisia', 'tunez'],
  ['algeria', 'argelia'],
  ['cameroon', 'camerun'],
  ['brazil', 'brasil'],
  ['curacao', 'curazao'],
  ['usa', 'united states', 'united states of america', 'estados unidos', 'ee uu', 'eeuu'],
  ['dominican republic', 'republica dominicana'],
  ['trinidad and tobago', 'trinidad y tobago'],
  ['netherlands', 'holland', 'paises bajos', 'holanda'],
  ['south korea', 'corea del sur', 'korea republic'],
  ['saudi arabia', 'arabia saudita', 'arabia saudi'],
  ['new zealand', 'nueva zelanda'],
  ['ivory coast', 'costa de marfil', 'cote d ivoire'],
  ['south africa', 'sudafrica'],
  ['iceland', 'islandia'],
  ['finland', 'finlandia'],
  ['slovakia', 'eslovaquia'],
  ['slovenia', 'eslovenia'],
  ['czech republic', 'czechia', 'republica checa', 'chequia'],
  ['luxembourg', 'luxemburgo'],
  ['cyprus', 'chipre'],
  ['latvia', 'letonia'],
  ['lithuania', 'lituania'],
  ['moldova', 'moldavia'],
  ['belarus', 'bielorrusia'],
  ['north macedonia', 'macedonia del norte'],
  ['bosnia and herzegovina', 'bosnia y herzegovina', 'bosnia herzegovina'],
  ['kazakhstan', 'kazajistan'],
  ['qatar', 'catar'],
  ['iraq', 'irak'],
];

// variantes más largas primero, para que "irlanda del norte" gane a "irlanda"
const ALIAS_LIST = [];
for (const [canon, ...variants] of ALIAS_GROUPS) {
  for (const v of variants) ALIAS_LIST.push([normalize(v), canon]);
}
ALIAS_LIST.sort((a, b) => b[0].length - a[0].length);
const ALIAS_REGEXES = ALIAS_LIST.map(([variant, canon]) => [
  new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
  canon,
]);

// palabras que no ayudan a distinguir equipos
const STOPWORDS = new Set([
  'fc', 'cf', 'sc', 'ac', 'afc', 'cd', 'ud', 'sd', 'club',
  'de', 'del', 'la', 'el', 'los', 'las', 'the', 'of', 'and', 'y', 'vs', 'v',
]);

function canonizeText(text) {
  let t = normalize(text);
  for (const [rx, canon] of ALIAS_REGEXES) t = t.replace(rx, canon);
  return t;
}

function tokens(text) {
  return canonizeText(text)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

// ---------- similitud ----------
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let common = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      common++;
      counts.set(g, c - 1);
    }
  }
  return (2 * common) / (A.length + B.length);
}

function tokenPresence(tok, svTokens) {
  if (svTokens.has(tok)) return 1;
  // tolerancia a typos de la agenda ("Cardinls", "Dalla")
  if (tok.length >= 5) {
    for (const s of svTokens) {
      if (s.length >= 5 && dice(tok, s) >= 0.8) return 0.9;
    }
  }
  return 0;
}

function teamScore(teamName, svTokens) {
  const toks = tokens(teamName);
  if (!toks.length) return 0;
  return toks.reduce((acc, t) => acc + tokenPresence(t, svTokens), 0) / toks.length;
}

// "UEFA Nations League: Israel vs República de Irlanda" -> [Israel, República de Irlanda]
// "NFL – San Francisco 49ers vs. Arizona Cardinls"      -> [San Francisco 49ers, Arizona Cardinls]
function extractTeams(title) {
  let t = (title || '').trim();
  const colon = t.indexOf(':');
  if (colon !== -1) {
    t = t.slice(colon + 1);
  } else {
    const parts = t.split(/\s[–—]\s/);
    if (parts.length > 1) t = parts.slice(1).join(' ');
  }
  const sides = t.split(/\s+(?:vs\.?|v\.?)\s+/i);
  if (sides.length !== 2) return null;
  const a = sides[0].trim();
  const b = sides[1].trim();
  return a && b ? [a, b] : null;
}

const MIN_TEAM_SCORE = 0.6; // cada equipo debe coincidir al menos así
const MIN_EVENT_SCORE = 0.75; // y el promedio de los dos, al menos esto
const STATUS_RANK = { 'status-live': 0, 'status-next': 1, 'status-finished': 2 };

function scoreEvent(group, svText) {
  const teams = extractTeams(group.title);
  if (!teams) return 0;
  const svTokens = new Set(tokens(svText));
  const a = teamScore(teams[0], svTokens);
  const b = teamScore(teams[1], svTokens);
  if (a < MIN_TEAM_SCORE || b < MIN_TEAM_SCORE) return 0;
  return (a + b) / 2;
}

function rankMatches(groups, svText) {
  return groups
    .map((g) => ({ event: g, score: scoreEvent(g, svText) }))
    .filter((m) => m.score > 0)
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      // a igual puntaje: preferir "en vivo" > "pronto" > "finalizado"
      return (STATUS_RANK[x.event.statusKey] ?? 3) - (STATUS_RANK[y.event.statusKey] ?? 3);
    });
}

function bestMatch(groups, svText) {
  const ranked = rankMatches(groups, svText);
  return ranked.length && ranked[0].score >= MIN_EVENT_SCORE ? ranked[0] : null;
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
  let svText;
  try {
    svText = await getStremverseText(id);
  } catch (e) {
    console.log(`[stremverse] no se pudo obtener el meta de ${id}: ${e.message}`);
    return [];
  }

  const groups = await la18hdEventos.getGroupedEvents();
  const match = bestMatch(groups, svText);

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
  extractTeams,
  rankMatches,
  bestMatch,
  fetchJson,
  getStremverseText,
  getStreamsForStremverseId,
};
