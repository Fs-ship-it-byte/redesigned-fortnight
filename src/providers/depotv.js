const nodeFetch = require('node-fetch');
const { DEFAULT_HEADERS } = require('../http');
const { resolveCanalesPhp, resolveGlobalPhp } = require('../extractors/canalesphp');
const { resolveGenericEmbed } = require('../extractors/generic');

const PREFIX = 'depotv';

// De las 10 sub-fuentes que agrega el DeporTVProvider original, estas 2
// comparten EXACTAMENTE el mismo formato de JSON (array de
// {category,link,title,time,status,language,date}). LA18HD salió de esta
// lista y ahora es su propio provider de canales (ver la18hd.js) porque
// funciona distinto: no es agenda de eventos, es una lista fija de
// canales con su propio link de stream por nombre.
const SITES = [
  { key: 'streamxx', mainUrl: 'https://streamx996.one', agendaPath: '/json/agenda550.json' },
  { key: 'stp', mainUrl: 'https://streamtp99a.sbs', agendaPath: '/eventos.json' },
];

async function getJson(url, referer) {
  const res = await nodeFetch(`${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}`, {
    headers: { ...DEFAULT_HEADERS, Referer: referer },
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

function toId(site, ev) {
  const payload = { site, title: ev.title, link: ev.link, time: ev.time, category: ev.category };
  return `${PREFIX}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function fromId(id) {
  const b64 = id.replace(`${PREFIX}:`, '');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}

async function getCatalog() {
  const results = await Promise.allSettled(
    SITES.map(async (site) => {
      const events = await getJson(`${site.mainUrl}${site.agendaPath}`, site.mainUrl);
      return (Array.isArray(events) ? events : []).map((ev) => ({
        id: toId(site.key, ev),
        type: 'tv',
        name: `${ev.title}${ev.time ? ` · ${ev.time}` : ''}`,
      }));
    })
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`[depotv] sitio ${SITES[i].key} falló:`, r.reason?.message || r.reason);
    }
  });

  return results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
}

async function search(query) {
  const all = await getCatalog();
  const q = query.toLowerCase();
  return all.filter((ev) => ev.name.toLowerCase().includes(q));
}

async function getMeta(id) {
  const data = fromId(id);
  return { id, type: 'tv', name: data.title };
}

// Replica el par de patrones más comunes de loadLinks del original:
// "canales.php?stream=" y "global1.php?" (u otro caso similar). Cualquier
// otro formato cae al extractor genérico como último intento.
async function resolveLink(link) {
  try {
    if (link.includes('canales.php?stream=') || link.includes('canal.php?stream=')) {
      return await resolveCanalesPhp(link);
    }
    if (link.includes('global1.php?') || link.includes('global2.php?')) {
      return await resolveGlobalPhp(link);
    }
  } catch (e) {
    console.log(`[depotv] resolveLink falló para ${link}:`, e.message);
    return [];
  }
  return [];
}

async function getStreams(id) {
  const { link, site } = fromId(id);
  let urls = await resolveLink(link);

  if (urls.length === 0) {
    // Último recurso: tratar el link como un embed genérico tipo
    // streamwish/vidhide (a veces estos sitios linkean directo a uno).
    const resolved = await resolveGenericEmbed(link, link);
    if (resolved) {
      return [
        {
          name: 'DeporTV',
          title: site,
          url: resolved.url,
          type: resolved.type,
          headers: resolved.headers,
          behaviorHints: { notWebReady: resolved.type === 'hls' },
        },
      ];
    }
    console.log(`[depotv] no se pudo resolver ningún link para ${link}`);
    return [];
  }

  const streams = urls.map((url) => ({
    name: 'DeporTV',
    title: site,
    url,
    type: url.includes('.m3u8') ? 'hls' : 'mp4',
    headers: { Referer: link, 'User-Agent': DEFAULT_HEADERS['User-Agent'] },
    behaviorHints: { notWebReady: url.includes('.m3u8') },
  }));
  console.log(`[depotv] streams encontrados: ${streams.length}`);
  return streams;
}

module.exports = { PREFIX, SITES, getCatalog, search, getMeta, getStreams };
