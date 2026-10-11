const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const la18hd = require('./providers/la18hd');
const la18hdEventos = require('./providers/la18hd_eventos');
const stremverse = require('./providers/stremverse_bridge');
const sportsfree = require('./providers/sportsfree_bridge');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const {
  assertConfig,
  buildProxyPlaylistUrl,
  buildProxyDirectUrl,
  handlePlaylistProxy,
  handleSegmentProxy,
  handleDirectProxy,
} = require('./hlsproxy');
const live = require('./live');

// ---------------------------------------------------------------------------
// Configuración obligatoria. Si falta algo, el servidor NO arranca.
//   GATEWAY_SECRET     = igual que en el Worker
//   PROXY_SIGNING_KEY  = igual que en el Worker
//   MEDIA_BASE_URL     = URL pública de ESTE servicio (https://xxx.onrender.com)
//   GATEWAY_URL        = URL del Worker (https://xxx.workers.dev), para volcar contadores
// ---------------------------------------------------------------------------
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || '';
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/+$/, '');
const ENABLE_DEBUG = process.env.ENABLE_DEBUG === '1';
// MAGMA son .m3u8 directos y por defecto NO pasan por el proxy (ni cuentan en espectadores/GB/horas).
// MAGMA_PROXY=1 los hace pasar por el proxy como al resto.
const MAGMA_PROXY = process.env.MAGMA_PROXY === '1';
{
  const p = [];
  if (GATEWAY_SECRET.length < 16) p.push('GATEWAY_SECRET (mínimo 16 caracteres)');
  if (!/^https:\/\/[^/]+$/.test(GATEWAY_URL)) p.push('GATEWAY_URL (https://<worker>, sin barra final)');
  if (p.length) { console.error('Configuración inválida o incompleta: ' + p.join(', ')); process.exit(1); }
  assertConfig(); // PROXY_SIGNING_KEY y MEDIA_BASE_URL
}

// La cuenta, el IP y los límites los pone el gateway en cada pedido; el
// handler del SDK no ve el request, así que se pasan por AsyncLocalStorage.
const ctx = new AsyncLocalStorage();
const VALID_ID = /^[A-Za-z0-9:_.~%-]{1,4000}$/; // los ids de eventos llevan las fuentes en base64 (~450+ caracteres)
const VALID_ACCT = /^[A-Za-z0-9_-]{1,40}$/;

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
      const q = String(extra.search).slice(0, 80);
      return { metas: await provider.search(q) };
    }
    return { metas: await provider.getCatalog() };
  } catch (err) {
    console.error('catalog error', err);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    if (!VALID_ID.test(String(id))) return { meta: null };
    const provider = providerForId(id);
    if (!provider) return { meta: null };
    const meta = await provider.getMeta(id);
    return { meta };
  } catch (err) {
    console.error('meta error', err);
    return { meta: null };
  }
});

function limitStream(kind, msg) {
  // Entrada informativa (Stremio la muestra como un "stream" que abre una página con el aviso)
  return {
    name: kind === 'cuota' ? '⛔ Tope diario' : kind === 'horas' ? '⛔ Tope de horas' : '⛔ Límite',
    title: msg,
    externalUrl: `${GATEWAY_URL}/aviso/${kind}`,
  };
}

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const c = ctx.getStore() || {};
    if (!c.acct || !VALID_ID.test(String(id))) return { streams: [] };
    if (live.isBlocked(c.acct)) return { streams: [] };
    const meta = { acct: c.acct, ch: String(id).slice(0, 80), ms: c.maxStreams, bl: c.dailyBytes, wl: c.dailySeconds, ip: c.ip !== 'unknown' ? c.ip : '' };
    if (live.overQuota(c.acct, c.dailyBytes || 0)) {
      return { streams: [limitStream('cuota', 'Alcanzaste el tope diario de datos. Se restablece a las 00:00 UTC.')] };
    }
    if (live.overWatch(c.acct, c.dailySeconds || 0)) {
      return { streams: [limitStream('horas', 'Alcanzaste el tope diario de horas de visualización. Se restablece a las 00:00 UTC.')] };
    }
    if (c.maxStreams && live.atLimit(c.acct, c.ip, c.maxStreams)) {
      return { streams: [limitStream('limite', `Ya tienes ${live.activeCount(c.acct)} reproducciones activas (máximo ${c.maxStreams}). Cierra una para ver otra.`)] };
    }
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
        url:
          s.direct && !MAGMA_PROXY
            ? s.url
            : s.type === 'hls'
              ? buildProxyPlaylistUrl(s.url, s.headers, meta)
              : buildProxyDirectUrl(s.url, s.headers, meta),
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
app.disable('x-powered-by');
// Cuántos proxies hay delante (Render): para leer la IP real del cliente en /hlsproxy/*.
app.set('trust proxy', parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// /hlsproxy/* es público (lo piden los players directo): se protege con la firma del token.
app.options('/hlsproxy/*', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  res.sendStatus(204);
});
app.get('/hlsproxy/playlist/:token/:file', handlePlaylistProxy);
app.get('/hlsproxy/segment/:token/:file', handleSegmentProxy);
app.get('/hlsproxy/direct/:token/:file', handleDirectProxy);

// Todo lo demás (manifest, catalog, meta, stream, debug) exige el secreto del gateway.
// Se responde 404 (no 401) para no delatar que aquí hay algo.
const GATEWAY_SECRET_HASH = crypto.createHash('sha256').update(GATEWAY_SECRET).digest();
app.use((req, res, next) => {
  const got = crypto.createHash('sha256').update(String(req.get('X-Gateway-Secret') || '')).digest();
  if (!crypto.timingSafeEqual(got, GATEWAY_SECRET_HASH)) return res.status(404).send('Not found');
  const acct = String(req.get('X-Account-Id') || '');
  if (!VALID_ACCT.test(acct)) return res.status(400).json({ error: 'bad account' });
  const num = (h) => { const n = parseInt(req.get(h) || '0', 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  ctx.run(
    { acct, ip: String(req.get('X-Client-Ip') || '').slice(0, 64) || 'unknown', maxStreams: num('X-Max-Streams'), dailyBytes: num('X-Daily-Bytes'), dailySeconds: num('X-Daily-Seconds') },
    next
  );
});
// Espectadores activos por cuenta (lo consulta el panel del gateway). Va detrás del secreto.
app.get('/internal/viewers', (req, res) => res.json({ viewers: live.snapshot(), ...(req.query.detail ? { detail: live.detail() } : {}) }));
app.use(getRouter(builder.getInterface()));

if (ENABLE_DEBUG) {
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
    res.status(500).send(`Error: ${e.message}`);
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
    res.status(500).send(`Error: ${e.message}`);
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
    res.status(500).send(`Error: ${e.message}`);
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
    res.status(500).send(`Error: ${e.message}`);
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
    res.status(500).send(`Error: ${e.message}`);
  }
});

app.get('/debug/whoami', (req, res) => {
  res.json({ ip: req.ip, xff: req.get('x-forwarded-for') || null, ctx: ctx.getStore() });
});
} // fin ENABLE_DEBUG

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Addon escuchando en el puerto ${PORT}`);
  live.start();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => live.shutdown().finally(() => process.exit(0)));
  // Precalienta la agenda (renderiza /eventos/ con Chromium) para que el
  // primer pedido de streams no tenga que esperar ese render.
  la18hdEventos
    .getGroupedEvents()
    .catch((e) => console.log(`[la18hd-eventos] precalentamiento falló: ${e.message}`));
});
