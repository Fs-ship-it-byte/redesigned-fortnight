const { resolveCanalesPhp } = require('../extractors/canalesphp');

const MAIN_URL = 'https://la18hd.su'; // revisar si cambia el dominio
const PREFIX = 'la18hd';

// Lista curada de slugs conocidos (mismo patrón de nombres que
// CablevisionHd). No hay forma de auto-descubrirlos sin explorar el sitio
// a mano, así que si falta o sobra alguno, ajustar acá directamente —
// ver README para instrucciones de cómo sumar uno nuevo.
const CHANNELS = [
  { slug: 'espn', name: 'ESPN' },
  { slug: 'espn2', name: 'ESPN 2' },
  { slug: 'espn3', name: 'ESPN 3' },
  { slug: 'espn4', name: 'ESPN 4' },
  { slug: 'espnpremium', name: 'ESPN Premium' },
  { slug: 'foxsports', name: 'Fox Sports' },
  { slug: 'foxsports2', name: 'Fox Sports 2' },
  { slug: 'foxsports3', name: 'Fox Sports 3' },
  { slug: 'tudn', name: 'TUDN' },
  { slug: 'tycsports', name: 'TyC Sports' },
  { slug: 'directvsports', name: 'Directv Sports' },
  { slug: 'directvsports2', name: 'Directv Sports 2' },
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
  const found = CHANNELS.filter(
    (c) => slugify(c.name).includes(q) || c.slug.includes(q)
  );
  if (found.length > 0) {
    return found.map((c) => ({ id: toId(c.slug, c.name), type: 'tv', name: c.name }));
  }
  // No está en la lista curada: probamos igual con el texto tal cual como
  // slug — puede que exista en el sitio aunque no lo tengamos cargado acá.
  return [{ id: toId(q, query), type: 'tv', name: `${query} (no confirmado)` }];
}

async function getMeta(id) {
  const { name } = fromId(id);
  return { id, type: 'tv', name };
}

async function getStreams(id) {
  const { slug, name } = fromId(id);
  const pageUrl = `${MAIN_URL}/vivo/canales.php?stream=${slug}`;

  const urls = await resolveCanalesPhp(pageUrl);
  console.log(`[la18hd] ${pageUrl} -> ${urls.length} links crudos encontrados`);

  const streams = [];
  for (const url of urls) {
    // El pedido puntual: cuando el link final es del tipo
    // .../<canal>/mono.m3u8?token=..., existe una variante .../index.m3u8
    // con el mismo token que sirve el stream completo (mono es solo audio
    // o una variante reducida). Ofrecemos ambas por si "index" no
    // estuviera disponible para algún canal puntual.
    if (url.includes('/mono.m3u8')) {
      streams.push({
        name: 'LA18HD',
        title: `${name} (index)`,
        url: url.replace('/mono.m3u8', '/index.m3u8'),
        type: 'hls',
        headers: { Referer: `${MAIN_URL}/`, 'User-Agent': 'Mozilla/5.0' },
        behaviorHints: { notWebReady: true },
      });
      streams.push({
        name: 'LA18HD',
        title: `${name} (mono - respaldo)`,
        url,
        type: 'hls',
        headers: { Referer: `${MAIN_URL}/`, 'User-Agent': 'Mozilla/5.0' },
        behaviorHints: { notWebReady: true },
      });
    } else {
      streams.push({
        name: 'LA18HD',
        title: name,
        url,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        headers: { Referer: `${MAIN_URL}/`, 'User-Agent': 'Mozilla/5.0' },
        behaviorHints: { notWebReady: url.includes('.m3u8') },
      });
    }
  }

  console.log(`[la18hd] streams devueltos: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, CHANNELS, getCatalog, search, getMeta, getStreams };
