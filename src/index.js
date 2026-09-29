const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const la18hd = require('./providers/la18hd');
const la18hdEventos = require('./providers/la18hd_eventos');
const stremverse = require('./providers/stremverse_bridge');
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

// La agenda de eventos ya no se muestra como catálogo propio (sin
// imágenes): se usa el catálogo de StremVerse, que sí trae posters, y este
// addon solo aporta los STREAMS (ver providers/stremverse_bridge.js).
// SHOW_OWN_EVENTS_CATALOG=1 vuelve a publicar el catálogo propio de eventos.
const SHOW_OWN_EVENTS = process.env.SHOW_OWN_EVENTS_CATALOG === '1';

const streamPrefixes = [la18hd.PREFIX, stremverse.SV_PREFIX];
const metaPrefixes = [la18hd.PREFIX];
if (SHOW_OWN_EVENTS) {
  streamPrefixes.push(la18hdEventos.PREFIX);
  metaPrefixes.push(la18hdEventos.PREFIX);
}

const manifest = {
  id: 'community.storm.depotv',
  version: '0.5.0',
  name: 'Storm CS3 LA18HD (canales en vivo)',
  description:
    'Canales de TV en vivo (LA18HD) y fuentes de LA18HD para los eventos del catálogo de StremVerse.',
  logo: 'https://new.tvpublica.com.ar/wp-content/uploads/2021/05/DeporTVOK.jpg',
  // "stream" se declara como objeto para poder aceptar ids de StremVerse
  // (stremevent_...) además de los propios.
  resources: [
    'catalog',
    'meta',
    { name: 'stream', types: ['tv'], idPrefixes: streamPrefixes },
  ],
  types: ['tv'],
  catalogs: [
    { type: 'tv', id: 'canales', name: 'LA18HD - Canales en vivo', extra: [{ name: 'search' }], posterShape: 'square' },
    ...(SHOW_OWN_EVENTS
      ? [{ type: 'tv', id: 'eventos', name: 'LA18HD - Agenda deportiva', extra: [{ name: 'search' }], posterShape: 'square' }]
      : []),
  ],
  idPrefixes: metaPrefixes,
};

const CATALOG_TO_PROVIDER = { canales: la18hd, ...(SHOW_OWN_EVENTS ? { eventos: la18hdEventos } : {}) };

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
    let rawStreams;
    if (id.startsWith(stremverse.SV_PREFIX)) {
      // Evento del catálogo de StremVerse: se empareja con la agenda de
      // LA18HD y se devuelven todas las fuentes de ese partido.
      rawStreams = await stremverse.getStreamsForStremverseId(id);
    } else {
      const provider = providerForId(id);
      if (!provider) return { streams: [] };
      rawStreams = await provider.getStreams(id);
    }
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

// ==========================================
// DEBUG: ver cómo se empareja un evento de StremVerse con la agenda.
//   /debug/stremverse-match?name=Israel vs Republic of Ireland
//   /debug/stremverse-match?id=stremevent_XXXX      (lee el nombre del meta)
// Muestra los mejores candidatos con su puntaje (se acepta >= 0.75).
// ==========================================
app.get('/debug/stremverse-match', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    let svText = req.query.name;
    if (!svText && req.query.id) svText = await stremverse.getStremverseText(req.query.id);
    if (!svText) return res.status(400).send('Uso: ?name=Israel vs Ireland  o  ?id=stremevent_XXXX');

    const groups = await la18hdEventos.getGroupedEvents();
    const ranked = stremverse.rankMatches(groups, svText).slice(0, 5);
    const lines = ranked.map(
      (m) =>
        `${m.score >= 0.75 ? '✅' : '❌'} ${m.score.toFixed(2)}  [${m.event.status}]  ${m.event.title}  (${m.event.sources.length} fuente(s))`
    );
    res.send(
      `Texto de StremVerse: "${svText}"\n` +
      `Eventos en la agenda de LA18HD: ${groups.length}\n\n` +
      (lines.join('\n') || '(ningún candidato con puntaje > 0)')
    );
  } catch (e) {
    res.status(500).send(`Error: ${e.message}\n\n${e.stack}`);
  }
});

// Recorre el catálogo "Live Events" de StremVerse y muestra, para cada
// evento, con cuál de la agenda de LA18HD se emparejó (o si no hubo match).
//   /debug/stremverse-catalog                 -> todo
//   /debug/stremverse-catalog?genre=Football  -> solo fútbol
app.get('/debug/stremverse-catalog', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const genre = req.query.genre ? `/genre=${encodeURIComponent(req.query.genre)}` : '';
    const url = `${stremverse.SV_BASE}/catalog/tv/stremverse_live_events${genre}.json`;
    const data = await stremverse.fetchJson(url);
    const metas = (data && data.metas) || [];
    const groups = await la18hdEventos.getGroupedEvents();

    let matched = 0;
    const lines = metas.slice(0, 150).map((m) => {
      const best = stremverse.bestMatch(groups, m.name || '');
      if (best) matched++;
      return best
        ? `✅ ${best.score.toFixed(2)}  ${m.name}  ->  ${best.event.title}  (${best.event.sources.length} fuente(s))   [${m.id}]`
        : `⬜ ---   ${m.name}   [${m.id}]`;
    });

    res.send(
      `URL: ${url}\n` +
      `Eventos en StremVerse: ${metas.length} | Agenda LA18HD: ${groups.length} partidos | Con match: ${matched}\n\n` +
      lines.join('\n')
    );
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
  // Precalienta la agenda (renderiza /eventos/ con Chromium) para que el
  // primer pedido de streams no tenga que esperar ese render.
  la18hdEventos
    .getGroupedEvents()
    .catch((e) => console.log(`[la18hd-eventos] precalentamiento falló: ${e.message}`));
});
