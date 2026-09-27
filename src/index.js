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
// DEBUG: ver en crudo qué extrae el scraper de /eventos/ antes de
// deduplicar -- útil si el sitio cambia de estructura y hay que ajustar
// los selectores en fetchEventsFromHtml (src/providers/la18hd_eventos.js).
// ==========================================
app.get('/debug/la18hd-eventos-raw', async (req, res) => {
  const { fetchEventsFromHtml } = require('./providers/la18hd_eventos');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const events = await fetchEventsFromHtml();
    res.send(JSON.stringify(events, null, 2));
  } catch (e) {
    res.status(500).send(`Error: ${e.message}\n\n${e.stack}`);
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
