const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const depotv = require('./providers/depotv');
const la18hd = require('./providers/la18hd');
const {
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
} = require('./hlsproxy');

const PROVIDERS = { [depotv.PREFIX]: depotv, [la18hd.PREFIX]: la18hd };

function providerForId(id) {
  return PROVIDERS[id.split(':')[0]];
}

// Catálogo propio, igual que el addon de CablevisionHd+Streamed: eventos y
// canales deportivos en vivo no tienen id de IMDb.
const manifest = {
  id: 'community.storm.depotv',
  version: '0.2.0',
  name: 'Storm CS3 DeporTV (agenda + canales en vivo)',
  description:
    'Agenda de eventos deportivos en vivo (STP, StreamXX) y lista de canales en vivo (LA18HD). Catálogo propio, se refresca en cada request.',
  logo: 'https://new.tvpublica.com.ar/wp-content/uploads/2021/05/DeporTVOK.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [
    { type: 'tv', id: 'agenda', name: 'DeporTV - Agenda en vivo', extra: [{ name: 'search' }] },
    { type: 'tv', id: 'canales', name: 'LA18HD - Canales en vivo', extra: [{ name: 'search' }] },
  ],
  idPrefixes: [depotv.PREFIX, la18hd.PREFIX],
};

const CATALOG_TO_PROVIDER = { agenda: depotv, canales: la18hd };

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

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`Addon corriendo en ${base}/manifest.json`);
  if (!process.env.PUBLIC_URL) {
    console.warn('AVISO: falta PUBLIC_URL. En Railway hay que configurarla.');
  }
});
