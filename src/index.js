const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const la18hd = require('./providers/la18hd');
const la18hdEventos = require('./providers/la18hd_eventos');
const {
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
} = require('./hlsproxy');

// Catálogo propio: canales de TV en vivo no tienen id de IMDb.
//
// NOTA: este addon incluía originalmente un catálogo de "DeporTV -
// Agenda en vivo" (STP + StreamXX, ver src/providers/depotv.js) además
// de LA18HD. Se sacó del manifest a pedido — el código de depotv.js sigue
// en el proyecto por si se quiere retomar más adelante, simplemente no
// está enganchado acá. En su lugar se agregó la agenda de eventos de
// LA18HD (la18hd.su/eventos/) como su propio provider
// (la18hd_eventos.js), separado del catálogo de canales fijos.
const PROVIDERS = { [la18hd.PREFIX]: la18hd, [la18hdEventos.PREFIX]: la18hdEventos };

function providerForId(id) {
  return PROVIDERS[id.split(':')[0]];
}

const manifest = {
  id: 'community.storm.depotv',
  version: '0.4.0',
  name: 'Storm CS3 LA18HD (canales en vivo)',
  description: 'Canales de TV en vivo y agenda de eventos deportivos (LA18HD). Catálogo propio.',
  logo: 'https://new.tvpublica.com.ar/wp-content/uploads/2021/05/DeporTVOK.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [
    { type: 'tv', id: 'canales', name: 'LA18HD - Canales en vivo', extra: [{ name: 'search' }], posterShape: 'square' },
    { type: 'tv', id: 'eventos', name: 'LA18HD - Agenda deportiva', extra: [{ name: 'search' }], posterShape: 'square' },
  ],
  idPrefixes: [la18hd.PREFIX, la18hdEventos.PREFIX],
};

const CATALOG_TO_PROVIDER = { canales: la18hd, eventos: la18hdEventos };

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id, extra }) => {
  try {
    const provider = CATALOG_TO_PROVIDER[id];
    if (!provider) return { metas: [] };
    if (extra?.search) {
      return { metas: await provider.search(extra.search) };
    }
    return { metas: await provider.getCatalog() };
  } catch (err) {
    console.error('catalog error', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const provider = providerForId(id);
    if (!provider) return { meta: null };
    const meta = await provider.getMeta(id);
    return { meta };
  } catch (err) {
    console.error('meta error', err);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  try {
    const provider = providerForId(id);
    if (!provider) return { streams: [] };
    const rawStreams = await provider.getStreams(id);
    const streams = rawStreams
      .filter((s) => s && s.url)
      .map((s) => ({
        name: s.name,
        title: s.title,
        url:
          s.type === 'hls'
            ? buildProxyPlaylistUrl(s.url, s.headers)
            : buildProxyDirectUrl(s.url, s.headers),
        behaviorHints: s.behaviorHints,
      }));
    console.log(`total streams devueltos: ${streams.length}`);
    return { streams };
  } catch (err) {
    console.error('stream error', err);
    return { streams: [] };
  }
});

const app = express();
app.use(getRouter(builder.getInterface()));

app.get('/hlsproxy/playlist/:token/:file', handlePlaylistProxy);
app.get('/hlsproxy/segment/:token/:file', handleSegmentProxy);
app.get('/hlsproxy/direct/:token/:file', handleDirectProxy);

// ==========================================
// DEBUG: descubrir el endpoint real de la agenda de eventos de LA18HD.
// No se pudo inspeccionar el tráfico real del sitio al armar esto (es
// una SPA, el HTML estático no trae nada), así que se prueba una lista
// de candidatos típicos de esta familia de sitios. Si ninguno funciona:
//   /debug/la18hd-agenda-candidates  -> detalle de cada intento
//   /debug/la18hd-eventos-page       -> busca ".json"/"/api/" en el HTML
//                                        y los <script src="..."> de la
//                                        página real, por si el endpoint
//                                        correcto aparece ahí.
// ==========================================
app.get('/debug/la18hd-agenda-candidates', async (req, res) => {
  const nodeFetch = require('node-fetch');
  const { DEFAULT_HEADERS } = require('./http');
  const { MAIN_URL, AGENDA_CANDIDATES } = require('./providers/la18hd_eventos');

  res.set('Content-Type', 'text/plain; charset=utf-8');
  const lines = [];

  for (const path of AGENDA_CANDIDATES) {
    const url = `${MAIN_URL}${path}${path.includes('?') ? '&' : '?'}nocache=${Date.now()}`;
    try {
      const r = await nodeFetch(url, { headers: { ...DEFAULT_HEADERS, Referer: `${MAIN_URL}/eventos/` } });
      let snippet = '';
      try {
        snippet = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
      } catch (e) { /* ignore */ }
      lines.push(`${r.status === 200 ? '✅' : '❌'} [${r.status}] ${path}\n     body: ${snippet}`);
    } catch (e) {
      lines.push(`❌ [ERROR] ${path}: ${e.message}`);
    }
  }

  res.send(lines.join('\n\n'));
});

app.get('/debug/la18hd-eventos-page', async (req, res) => {
  const { getHtml } = require('./http');
  const { MAIN_URL } = require('./providers/la18hd_eventos');

  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const html = await getHtml(`${MAIN_URL}/eventos/`);
    const jsonMentions = [...html.matchAll(/[^\s"']{0,40}\.json[^\s"']{0,60}/gi)].map((m) => m[0]);
    const apiMentions = [...html.matchAll(/["'](\/api\/[^"']+)["']/gi)].map((m) => m[1]);
    const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);

    res.send(
      `URL: ${MAIN_URL}/eventos/\n` +
      `Largo del HTML: ${html.length} caracteres\n\n` +
      `--- Menciones de ".json" (${jsonMentions.length}) ---\n${jsonMentions.join('\n') || '(ninguna)'}\n\n` +
      `--- Menciones de "/api/..." (${apiMentions.length}) ---\n${apiMentions.join('\n') || '(ninguna)'}\n\n` +
      `--- <script src="..."> (${scriptSrcs.length}) ---\n${scriptSrcs.join('\n') || '(ninguno)'}\n\n` +
      `Si el endpoint real está en uno de los scripts listados arriba, hay que\n` +
      `abrirlo (ese JS suele traer la URL del fetch hardcodeada) y agregar el\n` +
      `path correcto al principio de AGENDA_CANDIDATES en\n` +
      `src/providers/la18hd_eventos.js.`
    );
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`Addon corriendo en ${base}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn('AVISO: falta PUBLIC_URL. En Railway hay que configurarla.');
  }
});
