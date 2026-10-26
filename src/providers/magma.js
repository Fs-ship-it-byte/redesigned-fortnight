const fs = require('fs');
const path = require('path');

// ==========================================
// MAGMA -- lista de canales m3u8 directos (src/data/magma.m3u).
//
// No se resuelve nada con Chromium: cada canal ya es un .m3u8. Lo que hace
// este módulo es EMPAREJAR: dado el canal que LA18HD dice para una fuente
// (ej. "ESPN 2 (México)"), buscar en la lista el mismo canal (ej.
// "ESPN 2 | Mexico") y devolverlo como una opción de stream más.
//
// Variables de entorno (todas opcionales):
//   DISABLE_MAGMA=1       apaga esta fuente por completo
//   MAGMA_CHANNELS=0      no añadir MAGMA en el catálogo de canales (solo en eventos)
//   MAGMA_PER_SOURCE=5    máximo de opciones MAGMA por cada fuente de LA18HD
//   MAGMA_PER_REGION=2    máximo de opciones por región cuando LA18HD no dice región (ej. "ESPN")
//   MAGMA_MAX_STREAMS=8   máximo total de opciones MAGMA por evento
//   MAGMA_M3U_FILE=ruta   otra ubicación para la lista
//
// En la lista, un canal puede llevar región forzada: #EXTINF:-1 region="base",ESPN 2 HD
//   region="base"  -> es el canal predeterminado: solo lo usa quien NO indica región (ej. "ESPN 2"),
//                    nunca "ESPN 2 (México)" ni "ESPN 2 (USA)".
//   region="mexico" (u otra) -> fuerza esa región aunque el nombre no la diga.
// ==========================================

const DISABLED = process.env.DISABLE_MAGMA === '1';
const FILE = process.env.MAGMA_M3U_FILE || path.join(__dirname, '..', 'data', 'magma.m3u');
const PER_SOURCE = Math.max(1, parseInt(process.env.MAGMA_PER_SOURCE || '5', 10));
const PER_REGION = Math.max(1, parseInt(process.env.MAGMA_PER_REGION || '2', 10));
const MAX_TOTAL = Math.max(1, parseInt(process.env.MAGMA_MAX_STREAMS || '8', 10));

// ---------- normalización de nombres ----------
// Regiones conocidas -> código. "sur" = señal Sur de Latinoamérica (Argentina/Chile/Uruguay/Paraguay).
const REGIONS = {
  sur: 'sur', argentina: 'argentina', chile: 'chile', colombia: 'colombia', mexico: 'mx', mx: 'mx',
  peru: 'peru', usa: 'usa', eeuu: 'usa', espana: 'es', es: 'es', ecuador: 'ecuador', bolivia: 'bolivia',
  paraguay: 'paraguay', uruguay: 'uruguay', brasil: 'br', brazil: 'br', honduras: 'honduras',
  guatemala: 'guatemala', costarica: 'costarica',
};
// Regiones que comparten señal (argentina <-> sur, etc.)
const SUR_GROUP = new Set(['sur', 'argentina', 'chile', 'uruguay', 'paraguay']);

function fold(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\+/g, ' plus ')
    .replace(/\bop\.?\s*\d+/g, ' ')                 // "op. 2" (opción 2)
    .replace(/\b(hd|fhd|uhd|4k)\b/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')               // espn2 -> espn 2
    .replace(/(\d)([a-z])/g, '$1 $2');              // 2mx -> 2 mx
}
function regionOf(text) {
  const key = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  return REGIONS[key] || '';
}

// "ESPN 2 (México)" -> { brand: 'espn', num: '2', region: 'mx' }
function parseName(name) {
  let s = fold(name);
  let region = '';
  s = s.replace(/\(([^)]*)\)/g, (m, g) => { const r = regionOf(g); if (r) region = r; return ' '; });
  const bar = s.split('|');
  s = bar[0];
  if (bar[1]) { const r = regionOf(bar[1]); if (r) region = r; }
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  if (!region && tokens.length > 1) {
    const r = regionOf(tokens[tokens.length - 1]);
    if (r) { region = r; tokens.pop(); }
  }
  let num = '1';
  if (tokens.length > 1 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) num = tokens.pop();
  return { brand: tokens.join(''), num, region };
}

// ---------- carga de la lista ----------
let _entries = null;
function load() {
  if (_entries) return _entries;
  _entries = [];
  if (DISABLED) return _entries;
  let text = '';
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    console.log(`[magma] no se pudo leer ${FILE}: ${e.message}`);
    return _entries;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([^,]*),(.*)$/);
    if (!m) continue;
    const name = m[2].trim();
    const forced = (m[1].match(/region="([^"]*)"/i) || [])[1]; // opcional: fuerza la región de ese canal
    const url = (lines[i + 1] || '').trim();
    if (!name || !/^https?:\/\//i.test(url)) continue;
    if (/ahorro/i.test(name)) continue; // versión de calidad reducida
    const parsed = parseName(name);
    if (forced) parsed.region = forced.toLowerCase() === 'base' ? 'base' : (regionOf(forced) || forced.toLowerCase());
    _entries.push({ name, url, ...parsed, order: _entries.length });
  }
  console.log(`[magma] ${_entries.length} canal(es) cargados de ${path.basename(FILE)}`);
  return _entries;
}

// Puntaje de un candidato frente al canal buscado (0 = descartado).
function score(want, cand) {
  if (want.brand !== cand.brand || want.num !== cand.num) return 0;
  // Canal marcado region="base" en la lista: es el predeterminado de ese canal. Solo se ofrece cuando
  // LA18HD NO dice región (ej. "ESPN 2"); si dice una región (México, USA...) no es esa señal.
  if (cand.region === 'base') return want.region ? 0 : 2.5;
  if (want.region) {
    if (!cand.region) return 1;                       // la lista no distingue región: vale
    if (cand.region === want.region) return 3;        // misma región
    if (SUR_GROUP.has(want.region) && SUR_GROUP.has(cand.region)) return 2; // misma señal sur
    return 0;                                         // otra región: es otra señal
  }
  // LA18HD no dice región: por defecto es la señal Sur
  if (!cand.region) return 2;
  if (SUR_GROUP.has(cand.region)) return cand.region === 'sur' ? 2 : 1.5;
  if (cand.region === 'colombia') return 1.4; // alternativa de ESPN sin región, detrás del Sur y Argentina
  return 0;
}

// Devuelve hasta `max` canales de la lista que equivalen a `channelName`.
function findByChannelName(channelName, max = PER_SOURCE) {
  const entries = load();
  if (!entries.length) return [];
  const want = parseName(channelName);
  if (!want.brand) return [];
  let list = entries
    .map((e) => ({ e, s: score(want, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.order - b.e.order);
  // Canal SIN región (ej. "ESPN"): se reparten las opciones entre señales (Sur, Argentina, Colombia...)
  // con un máximo de PER_REGION por región, para que muchas fuentes de una región no tapen a las demás.
  if (!want.region) {
    const count = {};
    list = list.filter((x) => {
      const r = x.e.region;
      if (!r || r === 'base') return true;
      count[r] = (count[r] || 0) + 1;
      return count[r] <= PER_REGION;
    });
  }
  return list.slice(0, max).map((x) => x.e);
}

// ---------- slug / link de LA18HD -> nombre de canal ----------
// Slugs que LA18HD usa en sus eventos y que no están en CHANNELS (o no se parecen al nombre).
// Se pueden ampliar sin tocar código en src/data/magma_aliases.json: { "slug": "Nombre del canal" }.
const SLUG_ALIASES = {
  liga1ma: 'Liga 1 Max (Perú)',
  liga1max: 'Liga 1 Max (Perú)',
  ecdf: 'El Canal del Futbol (ECDF)',
  ecdf_ligapro: 'El Canal del Futbol (ECDF)',
};
let _extraAliases = null;
function extraAliases() {
  if (_extraAliases) return _extraAliases;
  _extraAliases = {};
  try {
    const f = path.join(path.dirname(FILE), 'magma_aliases.json');
    if (fs.existsSync(f)) _extraAliases = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (e) {
    console.log(`[magma] magma_aliases.json inválido: ${e.message}`);
  }
  return _extraAliases;
}

function hasAlias(slug) {
  const key = String(slug || '').toLowerCase();
  return !!(extraAliases()[key] || SLUG_ALIASES[key]);
}

function channelNameForSlug(slug) {
  if (!slug) return '';
  const key = String(slug).toLowerCase();
  if (extraAliases()[key]) return extraAliases()[key];
  if (SLUG_ALIASES[key]) return SLUG_ALIASES[key];
  try {
    const { CHANNELS } = require('./la18hd'); // require tardío: evita dependencia circular
    const c = CHANNELS.find((x) => x.slug === slug);
    if (c) return c.name;
  } catch (e) { /* sigue con el slug crudo */ }
  return slug; // "espn2mx", "foxsports1_usa"... también se interpreta
}
function slugFromLink(link) {
  try {
    const u = new URL(link);
    const stream = u.searchParams.get('stream');
    if (stream) return stream.trim();
    const get = u.searchParams.get('get');
    if (get) return new URL(get).pathname.split('/').filter(Boolean).pop().replace(/\.[a-z0-9]+$/i, '');
  } catch (e) { /* link raro */ }
  return '';
}

function toStream(entry) {
  return {
    name: 'MAGMA',
    title: entry.name,
    url: entry.url,
    type: 'hls',
    headers: {},
    direct: true, // .m3u8 directo: index.js no lo pasa por el proxy (salvo MAGMA_PROXY=1)
    behaviorHints: { notWebReady: true },
  };
}

// Si dos canales de la lista se llaman igual (ej. dos "ESPN 1 | Argentina"), se numeran para distinguirlos.
function numberDuplicates(streams) {
  const total = {};
  streams.forEach((s) => { total[s.title] = (total[s.title] || 0) + 1; });
  const seen = {};
  return streams.map((s) => {
    if (total[s.title] < 2) return s;
    seen[s.title] = (seen[s.title] || 0) + 1;
    return { ...s, title: `${s.title} (${seen[s.title]})` };
  });
}

// Opciones MAGMA para UNA fuente de un evento de LA18HD ({ link, language }).
// `seen` (Set de urls) evita repetir el mismo canal si dos fuentes apuntan a él.
function streamsForSource(source, seen = new Set()) {
  if (DISABLED || !source) return [];
  const slug = slugFromLink(source.link);
  const name = channelNameForSlug(slug);
  if (!name) return [];
  const all = findByChannelName(name);
  if (!all.length) {
    console.log(`[magma] sin equivalente para la fuente "${slug}"`);
    return [];
  }
  const found = all.filter((e) => !seen.has(e.url)); // ya añadidos por otra fuente del mismo evento
  found.forEach((e) => seen.add(e.url));
  return numberDuplicates(found.map(toStream));
}

// Opciones MAGMA para un canal del catálogo ({ slug, name }).
function streamsForChannel(slug, name) {
  if (DISABLED || process.env.MAGMA_CHANNELS === '0') return [];
  const aliased = hasAlias(slug) ? channelNameForSlug(slug) : '';
  return numberDuplicates(findByChannelName(aliased || name || channelNameForSlug(slug)).map(toStream));
}

module.exports = {
  DISABLED, MAX_TOTAL,
  load, parseName, findByChannelName, streamsForSource, streamsForChannel, slugFromLink, channelNameForSlug,
};
