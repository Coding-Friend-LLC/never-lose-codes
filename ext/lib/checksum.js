// CRC32 over a canonical JSON string. Used to detect corrupted records.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(str) {
  let c = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    // fold UTF-16 code units into bytes (two bytes per unit; stable and cheap)
    c = TABLE[(c ^ (code & 0xff)) & 0xff] ^ (c >>> 8);
    c = TABLE[(c ^ (code >>> 8)) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Deterministic JSON: object keys sorted, so the same data always gives the same checksum.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sealed(obj) {
  return { ...obj, crc: crc32(canonical(obj)) };
}

export function verify(rec) {
  if (!rec || typeof rec.crc !== 'number') return false;
  const { crc, ...rest } = rec;
  return crc32(canonical(rest)) === crc;
}
