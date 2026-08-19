const fetch = require('node-fetch');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function getHtml(url, opts = {}) {
  const res = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

module.exports = { getHtml, DEFAULT_HEADERS };
