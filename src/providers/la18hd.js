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
];

// Logos reales verificados en Wikimedia Commons (Special:FilePath sirve
// el archivo directo, es un link estable que no requiere que nuestro
// server descargue/reserve nada). Cubre los canales más comunes de la
// parrilla; el resto cae al generador de iniciales de más abajo. Para
// sumar uno nuevo: buscar el archivo en
// https://commons.wikimedia.org/wiki/Category:Logos_of_sports_television_channels
// (o el buscador de Commons) y agregar la entrada acá con el nombre EXACTO
// del archivo.
// Archivo original de Wikimedia, SIN pedirle una miniatura (?width=...) a
// MediaWiki. A propósito: MediaWiki tiene un bug conocido generando
// thumbnails para archivos cuyo nombre contiene "+" (ej. "Disney+ ....svg",
// "Win Sports+ logo.svg") — a veces la miniatura falla o queda cacheada
// rota, algo intermitente entre dispositivos/redes. Evitamos ese problema
// dejando que sea images.weserv.nl (más abajo) quien descargue el SVG
// ORIGINAL directamente y lo rasterice él mismo — no dependemos en
// absoluto del pipeline de miniaturas de Wikimedia.
function rawWikimediaFile(fileName) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/File:${encodeURIComponent(fileName)}`;
}

// Paso 2: la mayoría de estos logos son franjas MUY anchas (ej. el
// wordmark de ESPN es ~5:1). Si Stremio los mete en una tarjeta cuadrada
// con "cover" (recortar para llenar el cuadro), termina mostrando solo
// una tira vertical del medio del logo — ilegible. Para evitar eso,
// pasamos la imagen por images.weserv.nl (proxy de imágenes gratuito) y
// le pedimos que la ajuste COMPLETA dentro de un lienzo cuadrado con
// relleno alrededor (fit=contain), en vez de recortarla. bg= es el color
// de fondo del lienzo (mismo tono oscuro que el resto de la UI).
function fitToSquare(imageUrl) {
  const params = new URLSearchParams({
    url: imageUrl,
    w: '300',
    h: '300',
    fit: 'contain',
    bg: '1a1a2eff',
  });
  return `https://images.weserv.nl/?${params.toString()}`;
}

function wikimediaFile(fileName) {
  return fitToSquare(rawWikimediaFile(fileName));
}

const LOGO_MAP = {
  // ESPN
  espn: wikimediaFile('ESPN wordmark.svg'),
  espn_usa: wikimediaFile('ESPN wordmark.svg'),
  espnmx: wikimediaFile('ESPN wordmark.svg'),
  espndeportes: wikimediaFile('ESPN Deportes.svg'),
  espnu: wikimediaFile('ESPN U logo.svg'),
  espn2: wikimediaFile('ESPN2 logo.svg'),
  espn2mx: wikimediaFile('ESPN2 logo.svg'),
  espn2_usa: wikimediaFile('ESPN2 logo.svg'),
  espn3: wikimediaFile('ESPN3 logo.svg'),
  espn3mx: wikimediaFile('ESPN3 logo.svg'),
  espn4: wikimediaFile('ESPN 4 logo.svg'),
  espn4mx: wikimediaFile('ESPN 4 logo.svg'),
  espn5: wikimediaFile('ESPN 5 logo.svg'),
  espn6: wikimediaFile('ESPN 6 logo.svg'),
  espn7: wikimediaFile('ESPN 7 logo.svg'),
  espnpremium: wikimediaFile('ESPN Premium logo.svg'),
  // Fox Sports
  foxsports: wikimediaFile('FOX Sports logo.svg'),
  foxsportsmx: wikimediaFile('FOX Sports logo.svg'),
  foxdeportes: wikimediaFile('FOX Sports logo.svg'),
  foxsportspremium: wikimediaFile('FOX Sports logo.svg'),
  foxsports1_usa: wikimediaFile('Fox Sports 1 logo.svg'),
  foxsports2: wikimediaFile('Fox sports 2 logo.svg'),
  foxsports2mx: wikimediaFile('Fox sports 2 logo.svg'),
  foxsports2_usa: wikimediaFile('Fox sports 2 logo.svg'),
  foxsports3: wikimediaFile('Fox sports 3 logo.svg'),
  foxsports3mx: wikimediaFile('Fox sports 3 logo.svg'),
  // DSports / DirecTV Sports
  dsports: wikimediaFile('DSports.svg'),
  // DSports 2 y DSports+ no tienen un archivo propio confirmado en
  // Wikimedia Commons (solo aparecen en Logopedia/Fandom, que no es un
  // hotlink tan confiable) — quedan con el logo genérico de DSports como
  // mejor aproximación disponible por ahora.
  dsports2: wikimediaFile('DSports.svg'),
  dsportsplus: wikimediaFile('DSports.svg'),
  // TUDN
  tudn: wikimediaFile('TUDN Logo.svg'),
  tudn_mx: wikimediaFile('TUDN Logo.svg'),
  // TNT Sports
  tntsports: wikimediaFile('TNT Sports Logo.svg'),
  tntsportschile: wikimediaFile('TNT Sports Chile.svg'),
  // beIN Sports
  beinsportes: wikimediaFile('BeIN Sports.svg'),
  beinsport_xtra_espanol: wikimediaFile('BeIN Sports.svg'),
  // TyC Sports
  tycsports: wikimediaFile('TyC Sports logo.svg'),
  tycinternacional: wikimediaFile('TyC Sports logo.svg'),
  // Gol / Liga1 / Movistar (Perú)
  goltv: wikimediaFile('GolTV logo.svg'),
  golperu: wikimediaFile('Gol Perú 2019.svg'),
  liga1max: wikimediaFile('Liga1 (Perú) logo.png'),
  movistar: wikimediaFile('Movistar Deportes.svg'),
  // Win Sports (Colombia)
  winsports: wikimediaFile('Win Sports nuevo logo.svg'),
  winsports2: wikimediaFile('Win Sports nuevo logo.svg'),
  winsportsplus: wikimediaFile('Win Sports+ logo.svg'),
  // Sky Sports
  sky_sports_laliga: wikimediaFile('Sky Sports 2025.svg'),
  // Argentina
  telefe: wikimediaFile('Telefe-Logo.svg'),
  tvpublica: wikimediaFile('TVP - Televisión Pública (2021).svg'),
  // México
  azteca7: wikimediaFile('Logo de Azteca 7 2024 (cropped).png'),
  azteca_deportes: wikimediaFile('Aztecadeporteslogo.png'),
  // Brasil
  premiere1: wikimediaFile('Premiere FC logo.png'),
  premiere2: wikimediaFile('Premiere FC logo.png'),
  sportv: wikimediaFile('SporTV 2017 logo.svg'),
  sportv2: wikimediaFile('SporTV 2017 logo.svg'),
  // Otros (URLs directas pasadas por el usuario, no son de Wikimedia)
  ecdf_ligapro: fitToSquare('https://static.elcanaldelfutbol.com/static/images/ECDF512.jpg'),
  canal5: wikimediaFile('Canal 5 2016.svg'), // vía Special:FilePath para que se rasterice a PNG
  calientetv: fitToSquare('https://upload.wikimedia.org/wikipedia/commons/c/c8/Caliente_TV_Logo.png'),
  // Eventos Disney+ (logo pasado por el usuario)
  disney: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
  disney2: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
  disney3: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
  disney4: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
  disney5: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
  disney6: wikimediaFile('Disney+ 2024 (ESPN variant).svg'),
};

// Para el resto (sin logo confirmado todavía), generamos una tarjeta con
// las iniciales del canal vía un servicio público de avatares, para que
// al menos se vean distintos entre sí y se diferencien claramente de los
// pósters de película/serie de los otros addons. Color determinado por el
// nombre, para que cada canal tenga siempre el mismo color entre requests.
const CARD_COLORS = ['0EA5E9', 'DC2626', '16A34A', 'CA8A04', '7C3AED', 'DB2777', 'EA580C', '0891B2'];
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CARD_COLORS[hash % CARD_COLORS.length];
}
function generatedPoster(name) {
  const bg = colorForName(name);
  const label = name.replace(/\s*\([^)]*\)\s*$/, ''); // saca el "(País)" del final para el logo
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(label)}&size=256&background=${bg}&color=fff&bold=true&format=png&length=3`;
}

function posterFor(slugOrName, name) {
  // Se puede llamar con (slug, name) para consultar LOGO_MAP, o con
  // (name) solo para el caso "no confirmado" del buscador.
  if (name === undefined) return generatedPoster(slugOrName);
  return LOGO_MAP[slugOrName] || generatedPoster(name);
}

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
  return CHANNELS.map((c) => {
    const poster = posterFor(c.slug, c.name);
    return {
      id: toId(c.slug, c.name),
      type: 'tv',
      name: c.name,
      poster,
      posterShape: 'square',
      background: poster,
      logo: poster,
    };
  });
}

async function search(query) {
  const q = slugify(query);
  const found = CHANNELS.filter((c) => slugify(c.name).includes(q) || c.slug.includes(q));
  // Antes, si no encontraba nada en la parrilla curada, devolvía un
  // resultado "(no confirmado)" probando el texto como slug directo. Eso
  // hacía que CUALQUIER búsqueda en Stremio (aunque fuera de una película
  // o serie sin relación con canales de TV) mostrara un resultado falso
  // de este addon, ej. buscar "HBO" mostraba "HBO (no confirmado)". Ahora
  // simplemente no hay match: si no está en la lista curada, no aparece.
  return found.map((c) => {
    const poster = posterFor(c.slug, c.name);
    return {
      id: toId(c.slug, c.name),
      type: 'tv',
      name: c.name,
      poster,
      posterShape: 'square',
      background: poster,
      logo: poster,
    };
  });
}

async function getMeta(id) {
  const { slug, name } = fromId(id);
  const poster = posterFor(slug, name);
  return {
    id,
    type: 'tv',
    name,
    poster,
    posterShape: 'square',
    background: poster,
    logo: poster,
  };
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

  // Solo devolvemos "index" (no "mono"): pedido explícito para bajar el
  // consumo del server en Railway — cada stream extra que se resuelve
  // implica otra corrida de Puppeteer si el usuario lo prueba, así que no
  // vale la pena mantener una opción de respaldo que casi nunca hace falta.
  const finalUrl = resolved.url.includes('/mono.m3u8')
    ? resolved.url.replace('/mono.m3u8', '/index.m3u8')
    : resolved.url;

  const streams = [
    {
      name: 'LA18HD',
      title: name,
      url: finalUrl,
      type: 'hls',
      headers: resolved.headers,
      behaviorHints: { notWebReady: true },
    },
  ];

  console.log(`[la18hd] streams devueltos: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, CHANNELS, getCatalog, search, getMeta, getStreams };
