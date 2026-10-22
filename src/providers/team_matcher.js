// ==========================================================
// MATCHER GENÉRICO POR NOMBRES DE EQUIPO -- compartido entre todos
// los puentes (StremVerse, Sports Streams, el que se agregue después).
// No depende de ningún addon en particular: solo sabe comparar
// "texto de un catálogo externo" contra los partidos ya deduplicados
// de la18hd_eventos.js.
// ==========================================================

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
  // clubes con abreviaturas comunes en las agendas
  ['paris saint germain', 'psg', 'paris sg', 'paris saint-germain'],
  ['manchester united', 'man united', 'man utd', 'manchester utd'],
  ['manchester city', 'man city'],
  ['atletico madrid', 'atl madrid', 'atletico de madrid'],
  ['sporting cristal', 'sporting cristal lima'],
  // ciudades: el mismo nombre en inglés/español y en el idioma local
  ['prague', 'praha', 'praga'],
  ['vienna', 'wien', 'viena'],
  ['cologne', 'koln', 'colonia'],
  ['munich', 'munchen', 'munich'],
  ['copenhagen', 'kobenhavn', 'copenhague'],
  ['bucharest', 'bucuresti', 'bucarest'],
  ['belgrade', 'beograd', 'belgrado'],
  ['warsaw', 'warszawa', 'varsovia'],
  ['kyiv', 'kiev', 'kyev'],
  ['antwerp', 'antwerpen', 'anvers', 'amberes'],
  ['bruges', 'brugge', 'brujas'],
  ['seville', 'sevilla'],
  ['milan', 'milano'],
  ['lisbon', 'lisboa'],
  ['athens', 'athina', 'atenas'],
  ['moscow', 'moskva', 'moscu'],
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
  // etiquetas de club de otros países ("FK Sabah", "Sabah FA", "SK Slavia", "SV Werder", "BK Häcken")
  'fa', 'fk', 'sk', 'nk', 'hnk', 'ofk', 'kf', 'ks', 'ik', 'bk', 'sv', 'vfl', 'vfb', 'tsg', 'fsv',
  'de', 'del', 'la', 'el', 'los', 'las', 'the', 'of', 'and', 'y', 'vs', 'v',
]);

// Abreviaturas que las agendas usan como prefijo ("Atl. Madrid", "Dep. La Coruña", "Univ. Católica").
// Se expanden como palabra completa, así "Atl." y "Atlético" terminan siendo el mismo token.
const ABBREVIATIONS = {
  atl: 'atletico', ath: 'athletic', dep: 'deportivo', depor: 'deportivo', depto: 'deportivo',
  univ: 'universidad', unev: 'universidad', man: 'manchester', utd: 'united', intl: 'internacional',
  nac: 'nacional', st: 'saint', sta: 'santa', sto: 'santo', cia: 'compania', sp: 'sporting',
};

function canonizeText(text) {
  let t = normalize(text);
  for (const [rx, canon] of ALIAS_REGEXES) t = t.replace(rx, canon);
  // abreviaturas: palabra suelta (ya sin punto) -> forma completa
  t = t.split(' ').map((w) => ABBREVIATIONS[w] || w).join(' ');
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

// ¿"UTC" son las iniciales de "Universidad Técnica de Cajamarca"?
function isAcronymOf(shortToks, longToks) {
  if (shortToks.length !== 1) return false;
  const a = shortToks[0];
  if (a.length < 2 || a.length > 5 || longToks.length < 2) return false;
  return longToks.map((t) => t[0]).join('') === a;
}

// Similitud entre DOS nombres de equipo (uno de cada lado), tolerando que una
// fuente use el nombre corto y la otra el largo ("Vitória" / "Vitória Guimarães")
// y las siglas ("UTC" / "Universidad Técnica de Cajamarca").
function teamSim(nameA, nameB) {
  const ta = tokens(nameA);
  const tb = tokens(nameB);
  if (!ta.length || !tb.length) return 0;
  const cover = (x, y) => {
    const ys = new Set(y);
    return x.reduce((acc, t) => acc + tokenPresence(t, ys), 0) / x.length;
  };
  const ab = cover(ta, tb);
  const ba = cover(tb, ta);
  let sim = Math.min(ab, ba);                       // mismos nombres
  const contained = Math.max(ab, ba);               // uno contenido en el otro
  if (contained >= 1) sim = Math.max(sim, 0.85);    // un poco menos que igualdad exacta
  if (isAcronymOf(ta, tb) || isAcronymOf(tb, ta)) sim = Math.max(sim, 0.9);
  return sim;
}

function scoreEventWithTeams(group, teamA, teamB) {
  const teams = extractTeams(group.title);
  if (!teams) return 0;
  // se prueban los dos órdenes (a veces un lado lista local/visitante al revés)
  const direct = [teamSim(teams[0], teamA), teamSim(teams[1], teamB)];
  const swapped = [teamSim(teams[0], teamB), teamSim(teams[1], teamA)];
  const best = Math.min(...direct) >= Math.min(...swapped) ? direct : swapped;
  if (Math.min(...best) < MIN_TEAM_SCORE) return 0;
  return (best[0] + best[1]) / 2;
}

function scoreEvent(group, svText) {
  const teams = extractTeams(group.title);
  if (!teams) return 0;
  const svTokens = new Set(tokens(svText));
  const a = teamScore(teams[0], svTokens);
  const b = teamScore(teams[1], svTokens);
  if (a < MIN_TEAM_SCORE || b < MIN_TEAM_SCORE) return 0;
  return (a + b) / 2;
}

// Con texto libre ("Troyes vs Marseille") se intenta primero separar los dos equipos y compararlos
// uno a uno (tolera "Troyes" / "Estac Troyes", siglas y abreviaturas). Si no se puede separar
// (ej. "Liga Portugal Betclic"), o si el método anterior puntúa más alto, se conserva el anterior.
function rankMatches(groups, svText) {
  // las horas ("14:45") confundirían al separador de competición ":" de extractTeams
  const sides = extractTeams(String(svText || '').replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\s+/g, ' '));
  return groups
    .map((g) => ({
      event: g,
      score: Math.max(scoreEvent(g, svText), sides ? scoreEventWithTeams(g, sides[0], sides[1]) : 0),
    }))
    .filter((m) => m.score > 0)
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      // a igual puntaje: preferir "en vivo" > "pronto" > "finalizado"
      return (STATUS_RANK[x.event.statusKey] ?? 3) - (STATUS_RANK[y.event.statusKey] ?? 3);
    });
}

function rankMatchesByTeams(groups, teamA, teamB) {
  return groups
    .map((g) => ({ event: g, score: scoreEventWithTeams(g, teamA, teamB) }))
    .filter((m) => m.score > 0)
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      return (STATUS_RANK[x.event.statusKey] ?? 3) - (STATUS_RANK[y.event.statusKey] ?? 3);
    });
}

function bestMatch(groups, svText) {
  const ranked = rankMatches(groups, svText);
  return ranked.length && ranked[0].score >= MIN_EVENT_SCORE ? ranked[0] : null;
}

// ---------- ANCLA ÚNICA ----------
// Si el emparejamiento normal falla (un equipo se escribe muy distinto en cada lado), se acepta el
// partido cuando UNO de los equipos coincide casi exacto con un solo partido de la agenda de hoy.
// Para no mezclar partidos distintos solo se usa cuando:
//   - se conoce la hora del partido (viene en el id) y es de hoy (±14 h);
//   - la coincidencia es exacta (mismas palabras, o sigla), no "contenido en";
//   - ese equipo aparece en UN solo partido de la agenda (si el club tiene dos, no se acepta nada);
//   - si el OTRO equipo también ancla, ancla en el MISMO partido (si apuntan a partidos distintos, se rechaza).
const ANCHOR_SCORE = 0.76;      // justo por encima de MIN_EVENT_SCORE
const ANCHOR_WINDOW_MS = 14 * 3600 * 1000;

function strongAnchor(name, other) {
  const sim = teamSim(name, other);
  if (sim < 0.9) return false;
  const toks = tokens(name);
  const isAcr = isAcronymOf(toks, tokens(other)) || isAcronymOf(tokens(other), toks);
  return isAcr || toks.join('').length >= 5;
}

function anchorMatch(groups, teamA, teamB, opts = {}) {
  const ts = Number(opts.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;                   // sin hora no se arriesga
  if (Math.abs(Date.now() - ts) > ANCHOR_WINDOW_MS) return null;      // otro día: probablemente un resumen/repetición
  const hitsFor = (sv) => groups.filter((g) => {
    const teams = extractTeams(g.title);
    return teams && teams.some((t) => strongAnchor(t, sv));
  });
  const a = hitsFor(teamA);
  const b = hitsFor(teamB);
  if (a.length > 1 || b.length > 1) return null;                      // el club juega en dos partidos
  if (a.length === 1 && b.length === 1 && a[0] !== b[0]) return null; // cada equipo apunta a un partido distinto
  const hit = a[0] || b[0];
  return hit ? { event: hit, score: ANCHOR_SCORE, anchor: true } : null;
}

function bestMatchByTeams(groups, teamA, teamB, opts) {
  const ranked = rankMatchesByTeams(groups, teamA, teamB);
  if (ranked.length && ranked[0].score >= MIN_EVENT_SCORE) return ranked[0];
  return anchorMatch(groups, teamA, teamB, opts);
}


module.exports = {
  normalize,
  tokens,
  extractTeams,
  teamScore,
  MIN_TEAM_SCORE,
  MIN_EVENT_SCORE,
  scoreEvent,
  scoreEventWithTeams,
  rankMatches,
  rankMatchesByTeams,
  bestMatch,
  bestMatchByTeams,
  anchorMatch,
  teamSim,
};
