// One-time passwords (RFC 4226 HOTP / RFC 6238 TOTP) with WebCrypto, plus otpauth:// parsing.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!s || /[^A-Z2-7]/.test(s)) throw new Error('That secret key has characters a 2FA key can’t contain (only letters A–Z and digits 2–7).');
  let bits = 0, value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const ALGS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function hotp(secretBytes, counter, { digits = 6, algorithm = 'SHA1' } = {}, subtle = globalThis.crypto.subtle) {
  const hash = ALGS[String(algorithm).toUpperCase().replace('-', '')];
  if (!hash) throw new Error('Unsupported algorithm ' + algorithm);
  const key = await subtle.importKey('raw', secretBytes, { name: 'HMAC', hash }, false, ['sign']);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const mac = new Uint8Array(await subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export async function totp(secretBytes, { period = 30, digits = 6, algorithm = 'SHA1', now = Date.now() } = {}, subtle) {
  const counter = Math.floor(now / 1000 / period);
  return hotp(secretBytes, counter, { digits, algorithm }, subtle);
}

export function secondsLeft(period = 30, now = Date.now()) {
  return period - (Math.floor(now / 1000) % period);
}

// otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
export function parseOtpauth(uri) {
  let u;
  try { u = new URL(String(uri).trim()); } catch { throw new Error('That isn’t an otpauth:// link.'); }
  if (u.protocol !== 'otpauth:') throw new Error('That isn’t an otpauth:// link.');
  const type = u.hostname.toLowerCase();
  if (type !== 'totp' && type !== 'hotp') throw new Error('Unsupported code type: ' + type);
  let label;
  try { label = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { throw new Error('That otpauth:// link is malformed.'); }
  const p = u.searchParams;
  const secret = (p.get('secret') || '').replace(/\s/g, '').toUpperCase();
  base32Decode(secret); // validates
  let issuer = p.get('issuer') || '';
  let account = label;
  const i = label.indexOf(':');
  if (i >= 0) { if (!issuer) issuer = label.slice(0, i).trim(); account = label.slice(i + 1).trim(); }
  return {
    type, secret, issuer: issuer.slice(0, 120), account: account.slice(0, 200),
    algorithm: (p.get('algorithm') || 'SHA1').toUpperCase(),
    digits: Number(p.get('digits')) === 8 ? 8 : 6,
    period: Number(p.get('period')) > 0 ? Number(p.get('period')) : 30,
    counter: type === 'hotp' ? Number(p.get('counter') || 0) : undefined,
  };
}

export function toOtpauth(a) {
  const label = encodeURIComponent((a.issuer ? a.issuer + ':' : '') + (a.account || ''));
  const q = new URLSearchParams({ secret: a.secret, ...(a.issuer ? { issuer: a.issuer } : {}), algorithm: a.algorithm || 'SHA1', digits: String(a.digits || 6), ...(a.type === 'hotp' ? { counter: String(a.counter || 0) } : { period: String(a.period || 30) }) });
  return `otpauth://${a.type || 'totp'}/${label}?${q}`;
}

// Reject accounts that could never produce a working code, at the moment they are added.
export const MAX_SECRET_CHARS = 256;

export function validateAccount(a) {
  if (!a || typeof a !== 'object') throw new Error('That account is empty.');
  const out = { ...a };
  out.type = out.type === 'hotp' ? 'hotp' : 'totp';
  out.algorithm = String(out.algorithm || 'SHA1').toUpperCase().replace('-', '');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(out.algorithm)) throw new Error('That account uses an unsupported algorithm (' + out.algorithm + ').');
  out.digits = Number(out.digits || 6);
  if (out.digits !== 6 && out.digits !== 8) throw new Error('Codes must be 6 or 8 digits.');
  out.period = Number(out.period || 30);
  if (!Number.isInteger(out.period) || out.period < 1 || out.period > 300) throw new Error('That account’s code period isn’t valid.');
  if (out.type === 'hotp') { out.counter = Number(out.counter || 0); if (!Number.isSafeInteger(out.counter) || out.counter < 0) throw new Error('That account’s counter isn’t valid.'); } else delete out.counter;
  out.secret = String(out.secret || '').replace(/[\s=-]/g, '').toUpperCase();
  // Real keys are 16–64 characters (rarely 128). Anything far longer is junk and can't fit a QR code.
  if (out.secret.length > MAX_SECRET_CHARS) throw new Error('That setup key is too long to be real (over ' + MAX_SECRET_CHARS + ' characters). Check what you copied.');
  const bytes = base32Decode(out.secret);
  if (bytes.length < 10) throw new Error('That setup key is too short to be real. Check that you copied all of it.');
  out.issuer = String(out.issuer || '').slice(0, 120);
  out.account = String(out.account || '').slice(0, 200);
  return out;
}
