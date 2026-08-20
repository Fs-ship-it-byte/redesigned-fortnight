const { resolveM3u8ViaBrowser } = require('../extractors/browser');

const MAIN_URL = 'https://la18hd.su'; // revisar si cambia el dominio
const PREFIX = 'la18hd';

// Lista curada de slugs confirmados por el usuario + variantes numeradas
// típicas de este tipo de sitio (canal, canal2, canal3...). Si falta o
// sobra alguno, se ajusta acá — ver README.
const CHANNELS = [
  { slug: 'espn', name: 'ESPN' },
  { slug: 'espn2', name: 'ESPN 2' },
  { slug: 'espn3', name: 'ESPN 3' },
  { slug: 'espn4', name: 'ESPN 4' },
  { slug: 'espnpremium', name: 'ESPN Premium' },
  { slug: 'dsports', name: 'DSports' },
  { slug: 'dsports2', name: 'DSports 2' },
  { slug: 'dsportsplus', name: 'DSports Plus' },
  { slug: 'tudn', name: 'TUDN' },
  { slug: 'foxsports', name: 'Fox Sports' },
  { slug: 'foxsports2', name: 'Fox Sports 2' },
  { slug: 'foxsports3', name: 'Fox Sports 3' },
  { slug: 'tycsports', name: 'TyC Sports' },
  { slug: 'golperu', name: 'Gol Perú' },
  { slug: 'goltv', name: 'Gol TV' },
  { slug: 'tntsports', name: 'TNT Sports' },
  { slug: 'beinlaliga', name: 'Bein La Liga' },
  { slug: 'movistardeportes', name: 'Movistar Deportes' },
  { slug: 'wwe', name: 'WWE' },
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
