// Desempaquetador para el formato "eval(function(p,a,c,k,e,d){...})('...',a,c,'...'.split('|'),0,{})"
// muy usado por streamwish/filemoon/vidhidepro y derivados.

function unbaser(base) {
  const ALPHABET = {
    62: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    95: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
  };
  let dictionary = {};
  if (base in ALPHABET) {
    Array.from(ALPHABET[base]).forEach((c, i) => (dictionary[c] = i));
  } else {
    Array.from(ALPHABET[95].slice(0, base)).forEach((c, i) => (dictionary[c] = i));
  }
  return (value) => {
    let ret = 0;
    Array.from(String(value)).reverse().forEach((c, i) => {
      ret += Math.pow(base, i) * (dictionary[c] || 0);
    });
    return ret;
  };
}

function isPacked(html) {
  return /eval\(function\(p,a,c,k,e,[dr]\)/.test(html);
}

function unpack(html) {
  const match = html.match(
    /eval\(function\(p,a,c,k,e,[dr]\).*?\}\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split\('\|'\)/s
  );
  if (!match) return null;
  let [, p, a, c, k] = match;
  a = parseInt(a, 10);
  c = parseInt(c, 10);
  const keywords = k.split('|');
  const base = unbaser(a);

  let count = c;
  const dict = {};
  while (count--) {
    const word = keywords[count] || count.toString(a);
    dict[base(count.toString(a))] = word || count.toString(a);
  }
  // Reconstruye reemplazando cada token \w+ por su palabra si existe en el diccionario.
  const decoded = p.replace(/\b\w+\b/g, (word) => dict[word] || word);
  return decoded.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

module.exports = { isPacked, unpack };
