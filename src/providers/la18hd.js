const { resolveM3u8ViaBrowser } = require('../extractors/browser');

const MAIN_URL = 'https://la18hd.su'; // revisar si cambia el dominio
const PREFIX = 'la18hd';

// Lista curada de slugs confirmados por el usuario + variantes numeradas
// típicas de este tipo de sitio (canal, canal2, canal3...). Si falta o
// sobra alguno, se ajusta acá — ver README.
const CHANNELS = [
  // ESPN
  { slug: 'espn', name: 'ESPN' },
  { slug: 'espn2', name: 'ESPN 2' },
  { slug: 'espn3', name: 'ESPN 3' },
  { slug: 'espn4', name: 'ESPN 4' },
  { slug: 'espn5', name: 'ESPN 5' },
  { slug: 'espn6', name: 'ESPN 6' },
  { slug: 'espn7', name: 'ESPN 7' },
  { slug: 'espnpremium', name: 'ESPN Premium (Argentina)' },
  { slug: 'espnmx', name: 'ESPN (México)' },
  { slug: 'espn2mx', name: 'ESPN 2 (México)' },
  { slug: 'espn3mx', name: 'ESPN 3 (México)' },
  { slug: 'espn4mx', name: 'ESPN 4 (México)' },
  { slug: 'espndeportes', name: 'ESPN Deportes (USA)' },
  { slug: 'espn_usa', name: 'ESPN (USA)' },
  { slug: 'espn2_usa', name: 'ESPN 2 (USA)' },
  { slug: 'espnu', name: 'ESPN U (USA)' },
  // DSports
  { slug: 'dsports', name: 'DSports' },
  { slug: 'dsports2', name: 'DSports 2' },
  { slug: 'dsportsplus', name: 'DSports Plus' },
  // Fox Sports
  { slug: 'foxsports', name: 'Fox Sports (Argentina)' },
  { slug: 'foxsports2', name: 'Fox Sports 2 (Argentina)' },
  { slug: 'foxsports3', name: 'Fox Sports 3 (Argentina)' },
  { slug: 'foxsportsmx', name: 'Fox Sports (México)' },
  { slug: 'foxsports2mx', name: 'Fox Sports 2 (México)' },
  { slug: 'foxsports3mx', name: 'Fox Sports 3 (México)' },
  { slug: 'foxsportspremium', name: 'Fox Sports Premium (México)' },
  { slug: 'foxdeportes', name: 'Fox Deportes (USA)' },
  { slug: 'foxsports1_usa', name: 'Fox Sports 1 (USA)' },
  { slug: 'foxsports2_usa', name: 'Fox Sports 2 (USA)' },
  // TyC Sports
  { slug: 'tycsports', name: 'TyC Sports (Argentina)' },
  { slug: 'tycinternacional', name: 'TyC Internacional (USA)' },
  // TNT Sports
  { slug: 'tntsports', name: 'TNT Sports (Argentina)' },
  { slug: 'tntsportschile', name: 'TNT Sports (Chile)' },
  // Otros
  { slug: 'ecdf_ligapro', name: 'ECDF LigaPro (Ecuador)' },
  { slug: 'goltv', name: 'GolTV' },
  { slug: 'golperu', name: 'Gol Perú' },
  { slug: 'liga1max', name: 'Liga 1 Max (Perú)' },
  { slug: 'movistar', name: 'Movistar Deportes (Perú)' },
  { slug: 'winsports', name: 'Win Sports (Colombia)' },
  { slug: 'winsports2', name: 'Win Sports 2 (Colombia)' },
  { slug: 'winsportsplus', name: 'Win Sports Plus (Colombia)' },
  { slug: 'tudn_mx', name: 'TUDN (México)' },
  { slug: 'tudn', name: 'TUDN (USA)' },
  { slug: 'beinsportes', name: 'Bein Sports (USA)' },
  { slug: 'beinsport_xtra_espanol', name: 'Bein Sports Xtra Español (USA)' },
  { slug: 'sky_sports_laliga', name: 'Sky Sports La Liga (España)' },
  { slug: 'calientetv', name: 'Caliente TV (México)' },
  { slug: 'azteca7', name: 'Azteca 7 (México)' },
  { slug: 'azteca_deportes', name: 'Azteca Deportes (México)' },
  { slug: 'canal5', name: 'Canal 5 (México)' },
  { slug: 'telefe', name: 'Telefe (Argentina)' },
  { slug: 'tvpublica', name: 'TV Pública (Argentina)' },
  { slug: 'premiere1', name: 'Premiere 1 (Brasil)' },
  { slug: 'premiere2', name: 'Premiere 2 (Brasil)' },
  { slug: 'sportv', name: 'SporTV (Brasil)' },
  { slug: 'sportv2', name: 'SporTV 2 (Brasil)' },
  { slug: 'disney', name: 'Evento Disney+' },
  { slug: 'disney2', name: 'Evento Disney+ 2' },
  { slug: 'disney3', name: 'Evento Disney+ 3' },
  { slug: 'disney4', name: 'Evento Disney+ 4' },
  { slug: 'disney5', name: 'Evento Disney+ 5' },
  { slug: 'disney6', name: 'Evento Disney+ 6' },
  { slug: 'eventos13', name: 'Eventos 13 (¿TNT Sports Chile?)' },
];

function toId(slug, name) {
  return `${PREFIX}:${Buffer.from(JSON.stringify({ slug, name })).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function getCatalog() {
  return CHANNELS.map((c) => ({ id: toId(c.slug, c.name), type: 'tv', name: c.name }));
}

async function search(query) {
  const q = slugify(query);
  const found = CHANNELS.filter((c) => slugify(c.name).includes(q) || c.slug.includes(q));
  if (found.length > 0) {
    return found.map((c) => ({ id: toId(c.slug, c.name), type: 'tv', name: c.name }));
  }
  return [{ id: toId(q, query), type: 'tv', name: `${query} (no confirmado)` }];
}

async function getMeta(id) {
  const { name } = fromId(id);
  return { id, type: 'tv', name };
}

async function getStreams(id) {
  const { slug, name } = fromId(id);
  const pageUrl = `${MAIN_URL}/vivo/canales.php?stream=${slug}`;

  console.log(`[la18hd] resolviendo vía navegador headless: ${pageUrl}`);
  const resolved = await resolveM3u8ViaBrowser(pageUrl, { timeoutMs: 20000 });

  if (!resolved) {
    console.log(`[la18hd] no se encontró ningún m3u8 para ${slug}`);
    return [];
  }

  const streams = [
    {
      name: 'LA18HD',
      title: `${name} (index)`,
      url: resolved.url.includes('/mono.m3u8')
        ? resolved.url.replace('/mono.m3u8', '/index.m3u8')
        : resolved.url,
      type: 'hls',
      headers: resolved.headers,
      behaviorHints: { notWebReady: true },
    },
  ];

  // Si el link capturado ya era /mono.m3u8, agregamos ese también como
  // respaldo por si /index.m3u8 no estuviera disponible para este canal.
  if (resolved.url.includes('/mono.m3u8')) {
    streams.push({
      name: 'LA18HD',
      title: `${name} (mono - respaldo)`,
      url: resolved.url,
      type: 'hls',
      headers: resolved.headers,
      behaviorHints: { notWebReady: true },
    });
  }

  console.log(`[la18hd] streams devueltos: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, CHANNELS, getCatalog, search, getMeta, getStreams };
