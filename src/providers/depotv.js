const cheerio = require('cheerio');
const nodeFetch = require('node-fetch');
const { getHtml, DEFAULT_HEADERS } = require('../http');
const { isPacked, unpack } = require('../extractors/unpacker');
const { resolveGenericEmbed } = require('../extractors/generic');

const PREFIX = 'depotv';

// De las 10 sub-fuentes que agrega el DeporTVProvider original, estas 3
// comparten EXACTAMENTE el mismo formato de JSON (array de
// {category,link,title,time,status,language,date}), así que se pueden
// tratar con un solo parser. Las otras 7 (Rustico, FutbolLibre, StreamXHD,
// TVTVHD, CanalesDeportivos, Angulismo, STP_OLD) quedan afuera — cada una
// tiene su propio formato/HTML distinto, ver el README para más detalle.
const SITES = [
  { key: 'streamxx', mainUrl: 'https://streamx996.one', agendaPath: '/json/agenda550.json' },
  { key: 'stp', mainUrl: 'https://streamtp99a.sbs', agendaPath: '/eventos.json' },
  { key: 'la18hd', mainUrl: 'https://la18hd.su', agendaPath: '/eventos/json/agenda123.json' },
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

function decodeBase64UntilUnchanged(str) {
  let decoded = str;
  let prev = '';
  while (decoded !== prev) {
    prev = decoded;
    try {
      decoded = Buffer.from(decoded, 'base64').toString('utf8');
    } catch (e) {
      break;
    }
  }
  return decoded;
}

// Mismos 4 patrones que ya vimos en CablevisionHd (comparten familia de
// sitios/plantillas): JS empacado + MARIOCSCryptOld, jwplayer.key,
// var src = "...", var playbackURL = atob("...").
function extractPlaybackUrls(html) {
  const $ = cheerio.load(html);
  const urls = [];

  $('script').each((_, s) => {
    const script = $(s).html() || '';
    const trimmed = script.trim();

    if (script.includes('function(p,a,c,k,e,d)') && isPacked(script)) {
      const unpacked = unpack(script);
      if (unpacked) {
        const m = unpacked.match(/MARIOCSCryptOld\("(.*?)"\)/);
        if (m) {
          const url = decodeBase64UntilUnchanged(m[1]);
          if (url) urls.push(url);
        }
      }
      return;
    }

    if (trimmed.includes('var playbackURL')) {
      const m = script.match(/var playbackURL\s*=\s*"([^"]+)"/) ||
        script.match(/atob\("([^"]+)"\)/);
      if (m) {
        const url = decodeBase64UntilUnchanged(m[1]);
        if (url) urls.push(url);
      }
      return;
    }

    if (trimmed.startsWith("jwplayer.key = '")) {
      const url = script.split('setupPlayer("')[1]?.split('");')[0];
      if (url) urls.push(url);
      return;
    }

    if (trimmed.startsWith('var src = "')) {
      const url = script
        .split('var src = "')[1]
        ?.split('";')[0]
        ?.replace(/\\\//g, '/')
        ?.replace(/\\:/g, ':');
      if (url) urls.push(url);
    }
  });

  return urls;
}

// Replica el par de patrones más comunes de loadLinks del original:
// "canales.php?stream=" (hay un salto extra por un <iframe>) y
// "global1.php?" (directo). Cualquier otro formato cae al extractor
// genérico como último intento.
async function resolveLink(link) {
  try {
    if (link.includes('canales.php?stream=') || link.includes('canal.php?stream=')) {
      const html = await getHtml(link, { headers: { Referer: link } });
      const $ = cheerio.load(html);
      let iframeSrc = $('iframe').first().attr('src');
      if (!iframeSrc) return [];
      if (!iframeSrc.startsWith('http')) {
        iframeSrc = `https://${new URL(link).host}${iframeSrc}`;
      }
      const finalHtml = await getHtml(iframeSrc, { headers: { Referer: link } });
      return extractPlaybackUrls(finalHtml);
    }

    if (link.includes('global1.php?') || link.includes('global2.php?')) {
      const res = await nodeFetch(link, {
        headers: { ...DEFAULT_HEADERS, 'Sec-Fetch-Dest': 'iframe' },
      });
      const html = await res.text();
      return extractPlaybackUrls(html);
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
