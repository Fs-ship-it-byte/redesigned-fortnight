const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const depotv = require('./providers/depotv');
const {
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
} = require('./hlsproxy');

// Catálogo propio, igual que el addon de CablevisionHd+Streamed: eventos
// deportivos en vivo no tienen id de IMDb.
const manifest = {
  id: 'community.storm.depotv',
  version: '0.1.0',
  name: 'Storm CS3 DeporTV (agenda deportiva en vivo)',
  description:
    'Agenda de eventos deportivos en vivo, agregando 3 de las 10 sub-fuentes del DeporTVProvider original (STP, StreamXX, LA18HD — las que comparten formato JSON). Catálogo propio, se refresca en cada request.',
  logo: 'https://new.tvpublica.com.ar/wp-content/uploads/2021/05/DeporTVOK.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'agenda', name: 'DeporTV - Agenda en vivo', extra: [{ name: 'search' }] }],
  idPrefixes: [depotv.PREFIX],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ extra }) => {
  try {
    if (extra?.search) {
      return { metas: await depotv.search(extra.search) };
    }
    return { metas: await depotv.getCatalog() };
  } catch (err) {
    console.error('catalog error', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const meta = await depotv.getMeta(id);
    return { meta };
  } catch (err) {
    console.error('meta error', err);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  try {
    const rawStreams = await depotv.getStreams(id);
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

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`Addon corriendo en ${base}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn('AVISO: falta PUBLIC_URL. En Railway hay que configurarla.');
  }
});
