const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const la18hd = require('./providers/la18hd');
const la18hdEventos = require('./providers/la18hd_eventos');
const stremverse = require('./providers/stremverse_bridge');
const sportsfree = require('./providers/sportsfree_bridge');
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

const streamPrefixesTv = [la18hd.PREFIX, ...stremverse.SV_ID_PREFIXES];
const metaPrefixes = [la18hd.PREFIX];
if (SHOW_OWN_EVENTS) {
  streamPrefixesTv.push(la18hdEventos.PREFIX);
  metaPrefixes.push(la18hdEventos.PREFIX);
}

const manifest = {
  id: 'community.storm.depotv',
  version: '0.6.0',
  name: 'Storm CS3 LA18HD (canales en vivo)',
  description:
    'Canales de TV en vivo (LA18HD) y fuentes de LA18HD para los eventos de StremVerse y Sports Streams.',
  logo: 'https://new.tvpublica.com.ar/wp-content/uploads/2021/05/DeporTVOK.jpg',
  // "stream" se declara dos veces a propósito: una por tipo ("tv" para
  // los canales propios + StremVerse, "sport" para Sports Streams), cada
  // una con SUS prefijos de id -- si fuera una sola entrada, Stremio le
  // aplicaría los mismos idPrefixes a los dos tipos, mezclando cosas que
  // no tienen nada que ver.
  resources: [
    'catalog',
    'meta',
    { name: 'stream', types: ['tv'], idPrefixes: streamPrefixesTv },
    { name: 'stream', types: ['sport'], idPrefixes: sportsfree.SF_ID_PREFIXES },
  ],
  types: ['tv', 'sport'],
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

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    let rawStreams;
    const provider = providerForId(id);
    if (provider) {
      // Id nuestro (canal o, si SHOW_OWN_EVENTS_CATALOG=1, evento propio).
      rawStreams = await provider.getStreams(id);
    } else if (type === 'sport') {
      // Evento del catálogo de Sports Streams.
      rawStreams = await sportsfree.getStreamsForSportsFreeId(id);
    } else {
      // Cualquier otro id ajeno (StremVerse u otro addon de tipo "tv")
      // -> intentamos emparejarlo con la agenda de LA18HD. No filtramos
      // por prefijo fijo a propósito: StremVerse usa varios
      // (stremevent_merged_, replay_, highlight_, ttv:direct_...) y
      // filtrar por uno solo nos hacía perder partidos igual de válidos
      // con otro prefijo. Si no hay match, ya devuelve [] sin romper.
      rawStreams = await stremverse.getStreamsForStremverseId(id);
    }
    const streams = rawStreams
      .filter((s) => s && s.url)
      .map((s) => ({
        name: s.name,
        title: s.title,
        url: s.light
          ? s.url
          : s.type === 'hls'
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
//   /debug/stremverse-match?id=stremevent_merged_XXXX   (decodifica el id primero;
//                                                          si no se puede, lee el meta)
// Muestra los mejores candidatos con su puntaje (se acepta >= 0.75).
// ==========================================
app.get('/debug/stremverse-match', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    let svText = req.query.name;
    let idTeams = null;
    if (!svText && req.query.id) {
      idTeams = stremverse.decodeTeamsFromId(req.query.id);
      svText = idTeams ? `${idTeams[0]} vs ${idTeams[1]}` : await stremverse.getStremverseText(req.query.id);
    }
    if (!svText) return res.status(400).send('Uso: ?name=Israel vs Ireland  o  ?id=stremevent_merged_XXXX');

    const groups = await la18hdEventos.getGroupedEvents();
    const ranked = idTeams
      ? stremverse.rankMatchesByTeams(groups, idTeams[0], idTeams[1]).slice(0, 5)
      : stremverse.rankMatches(groups, svText).slice(0, 5);
    const lines = ranked.map(
      (m) =>
        `${m.score >= 0.75 ? '✅' : '❌'} ${m.score.toFixed(2)}  [${m.event.status}]  ${m.event.title}  (${m.event.sources.length} fuente(s))`
    );
    res.send(
      `Texto usado: "${svText}"${idTeams ? ' (decodificado del id, sin red)' : ''}\n` +
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
    let viaId = 0;
    const lines = metas.slice(0, 150).map((m) => {
      const idTeams = stremverse.decodeTeamsFromId(m.id);
      const best = idTeams
        ? stremverse.bestMatchByTeams(groups, idTeams[0], idTeams[1])
        : stremverse.bestMatch(groups, m.name || '');
      if (best) {
        matched++;
        if (idTeams) viaId++;
      }
      const via = idTeams ? `(id: ${idTeams[0]} vs ${idTeams[1]})` : '(nombre)';
      return best
        ? `✅ ${best.score.toFixed(2)}  ${m.name}  ${via}  ->  ${best.event.title}  (${best.event.sources.length} fuente(s))   [${m.id}]`
        : `⬜ ---   ${m.name}  ${via}   [${m.id}]`;
    });

    res.send(
      `URL: ${url}\n` +
      `Eventos en StremVerse: ${metas.length} | Agenda LA18HD: ${groups.length} partidos | Con match: ${matched} (${viaId} vía id, ${matched - viaId} vía nombre)\n\n` +
      lines.join('\n')
    );
  } catch (e) {
    res.status(500).send(`Error: ${e.message}\n\n${e.stack}`);
  }
});

// ==========================================
// DEBUG (Sports Streams) -- mismos endpoints que para StremVerse, pero
// para sportsfree-us2.highfly.dev (type "sport", sin decode de id).
//   /debug/sportsfree-match?name=Guatemala vs El Salvador
//   /debug/sportsfree-match?id=streamed-xxxx      (lee el nombre del meta)
// ==========================================
app.get('/debug/sportsfree-match', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    let text = req.query.name;
    if (!text && req.query.id) text = await sportsfree.getSportsFreeText(req.query.id);
    if (!text) return res.status(400).send('Uso: ?name=Team A vs Team B  o  ?id=streamed-XXXX');

    const groups = await la18hdEventos.getGroupedEvents();
    const ranked = sportsfree.rankMatches(groups, text).slice(0, 5);
    const lines = ranked.map(
      (m) =>
        `${m.score >= 0.75 ? '✅' : '❌'} ${m.score.toFixed(2)}  [${m.event.status}]  ${m.event.title}  (${m.event.sources.length} fuente(s))`
    );
    res.send(
      `Texto de Sports Streams: "${text}"\n` +
      `Eventos en la agenda de LA18HD: ${groups.length}\n\n` +
      (lines.join('\n') || '(ningún candidato con puntaje > 0)')
    );
  } catch (e) {
    res.status(500).send(`Error: ${e.message}\n\n${e.stack}`);
  }
});

// Recorre uno de los catálogos de Sports Streams y muestra con qué
// partido de LA18HD se emparejó cada evento (o si no hubo match).
//   /debug/sportsfree-catalog                       -> sports_live (default)
//   /debug/sportsfree-catalog?catalog=sports_football -> otro catálogo
// (ids de catálogo válidos: sports_live, sports_today, sports_football,
//  sports_basketball, sports_american_football, sports_hockey, etc. --
//  ver el manifest de sportsfree-us2.highfly.dev)
app.get('/debug/sportsfree-catalog', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    const catalogId = req.query.catalog || 'sports_live';
    const url = `${sportsfree.SF_BASE}/catalog/${sportsfree.SF_TYPE}/${encodeURIComponent(catalogId)}.json`;
    const data = await sportsfree.fetchJson(url);
    const metas = (data && data.metas) || [];
    const groups = await la18hdEventos.getGroupedEvents();

    let matched = 0;
    const lines = metas.slice(0, 150).map((m) => {
      const best = sportsfree.bestMatch(groups, m.name || '');
      if (best) matched++;
      return best
        ? `✅ ${best.score.toFixed(2)}  ${m.name}  ->  ${best.event.title}  (${best.event.sources.length} fuente(s))   [${m.id}]`
        : `⬜ ---   ${m.name}   [${m.id}]`;
    });

    res.send(
      `URL: ${url}\n` +
      `Eventos en Sports Streams: ${metas.length} | Agenda LA18HD: ${groups.length} partidos | Con match: ${matched}\n\n` +
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
