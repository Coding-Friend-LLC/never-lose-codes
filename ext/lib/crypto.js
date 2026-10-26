// Never Lose Codes crypto (WebCrypto only).
//
// Vault key (VK): random AES-256-GCM key. Every account record is sealed with VK + a fresh 96-bit IV.
// VK is stored only in WRAPPED form:
//   - by the device key (non-extractable, kept in the browser) so the app opens without a password;
//   - optionally by the app password (PBKDF2-SHA256, 600k iterations, random salt);
//   - always by the RECOVERY KEY (128 random bits shown once). Backup files carry only this wrap,
//     so a backup opens on any computer with the recovery key, even if the app password is forgotten.

const enc = new TextEncoder(), dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 600000;
const RK_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L: easy to copy by hand

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export { b64, unb64 };

function rand(n) { const u = new Uint8Array(n); crypto.getRandomValues(u); return u; }

export async function newVaultKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// Seal/open any JSON value with an AES-GCM key. aad binds the ciphertext to its record id/kind.
export async function seal(key, value, aad = '') {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function open(key, box, aad = '') {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(aad) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// ---- wrapping the vault key ----
async function rawOf(vk) { return new Uint8Array(await crypto.subtle.exportKey('raw', vk)); }
async function importVK(raw, extractable = true) { return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']); }

async function kekFromSecret(secret, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// wrap with a password or recovery key; returns a plain JSON record safe to store anywhere
export async function wrapWithSecret(vk, secret, kind) {
  const salt = rand(16);
  const kek = await kekFromSecret(normalizeSecret(secret, kind), salt);
  const box = await seal(kek, { vk: b64(await rawOf(vk)) }, 'vk-wrap:' + kind);
  return { kind, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64(salt), ...box };
}
export async function unwrapWithSecret(wrap, secret) {
  if (!wrap || wrap.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(wrap.iterations) || wrap.iterations < 600000 || wrap.iterations > 5000000 || !wrap.salt) {
    throw new Error('That key file uses settings this app doesn’t accept. It may be damaged or altered.');
  }
  const kek = await kekFromSecret(normalizeSecret(secret, wrap.kind), unb64(wrap.salt), wrap.iterations);
  try {
    const { vk } = await open(kek, wrap, 'vk-wrap:' + wrap.kind);
    return importVK(unb64(vk));
  } catch {
    throw new Error(wrap.kind === 'recovery' ? 'That recovery key doesn’t match. Check each group of characters.' : 'Wrong password.');
  }
}

// device wrap: a non-extractable AES key that lives only in this browser profile
export async function newDeviceKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrapWithDevice(vk, deviceKey) {
  return { kind: 'device', ...(await seal(deviceKey, { vk: b64(await rawOf(vk)) }, 'vk-wrap:device')) };
}
export async function unwrapWithDevice(wrap, deviceKey) {
  const { vk } = await open(deviceKey, wrap, 'vk-wrap:device');
  return importVK(unb64(vk));
}

// ---- recovery key: 26 characters from a 31-symbol alphabet, shown in groups of 4 ----
export function newRecoveryKey() {
  // 26 symbols × log2(31) ≈ 128.8 bits. Rejection sampling: bytes ≥ 248 (8×31) are discarded so every
  // symbol is exactly equally likely.
  const out = [];
  while (out.length < 26) {
    const buf = rand(32);
    for (const v of buf) { if (v < 248 && out.length < 26) out.push(RK_ALPHABET[v % 31]); }
  }
  return formatRecoveryKey(out.join(''));
}
export function formatRecoveryKey(s) {
  const c = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.match(/.{1,4}/g).join('-');
}
function normalizeSecret(secret, kind) {
  // Recovery keys never contain 0, O, 1, I or L, so case and separators are the only things to ignore.
  if (kind === 'recovery') return String(secret).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return String(secret).normalize('NFKC');
}
export function looksLikeRecoveryKey(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').length === 26;
}
