// Trial + one-time license (pure + WebCrypto). License keys are signed by our server with ECDSA
// P-256; the extension verifies them locally with the public key — works offline, no account,
// can't be forged. Format: NLT1.<base64url(payload JSON)>.<base64url(signature, IEEE P1363 r||s)>
// payload: { v: 1, id, email, t: issuedAt ms, plan: 'lifetime' }

export const PUBLIC_KEY_SPKI_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEU33V5AVhnQ8a/hLPjmyBdoSpNseD+qRTtmB1I03J0rn5hgjFoFWGRxpIZBG6qtgegswixDg1XA8fSvUn9I3tIQ==';
export const TRIAL_DAYS = 14;
export const PRICE_LABEL = '$5'; // one-time
export const BUY_URL = 'https://app.codingfriendllc.com/nltpro/buy?product=neverlosecodes';
export const PRODUCT = 'neverlosecodes';
const DAY = 86400000;

// Free forever: everything needed to use and keep your codes. Nobody is ever locked out of their codes.
export const FREE_AFTER_TRIAL = new Set(['view', 'copy', 'add', 'import', 'search', 'backups', 'restore', 'export', 'trash', 'recovery', 'password']);
// Pro extras (built in 1.0.1): groups/pins/drag order, QR export to a phone, color badges, auto-lock choice.
export const PRO_FEATURES = ['organize', 'exportQr', 'icons', 'autoLockOptions'];

const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function parseKey(raw) {
  const key = String(raw || '').trim().replace(/\s+/g, '');
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== 'NLT1') return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    return { key, payload, data: new TextEncoder().encode(parts[0] + '.' + parts[1]), sig: b64urlToBytes(parts[2]) };
  } catch { return null; }
}

export async function verifyKey(raw, spkiB64 = PUBLIC_KEY_SPKI_B64, subtle = globalThis.crypto.subtle) {
  const p = parseKey(raw);
  if (!p) return { ok: false, reason: 'That doesn’t look like a Never Lose Codes key. It starts with NLT1.' };
  try {
    const pub = await subtle.importKey('spki', Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, p.sig, p.data);
    if (!ok) return { ok: false, reason: 'This key isn’t valid. Please copy it exactly from your email.' };
    if (p.payload.v !== 1) return { ok: false, reason: 'This key is for a different version.' };
    if ((p.payload.product || 'neverlosetabs') !== PRODUCT) return { ok: false, reason: 'This key is for a different Coding Friend product.' };
    return { ok: true, payload: p.payload };
  } catch {
    return { ok: false, reason: 'This key could not be checked. Please copy it exactly from your email.' };
  }
}

export function trialStatus(installedAt, now = Date.now(), days = TRIAL_DAYS) {
  if (!installedAt) return { inTrial: true, daysLeft: days, endsAt: null };
  const endsAt = installedAt + days * DAY;
  const left = Math.ceil((endsAt - now) / DAY);
  return { inTrial: now < endsAt, daysLeft: Math.max(0, left), endsAt };
}

// licensed: verified payload or null
export function entitlement({ installedAt, licensed }, now = Date.now()) {
  if (licensed) return { tier: 'pro', can: () => true, trial: null };
  const t = trialStatus(installedAt, now);
  if (t.inTrial) return { tier: 'trial', can: () => true, trial: t };
  return { tier: 'free', can: (f) => FREE_AFTER_TRIAL.has(f), trial: t };
}
