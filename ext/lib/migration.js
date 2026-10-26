// Google Authenticator "Transfer accounts" export: otpauth-migration://offline?data=<base64 protobuf>
// MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2; int32 batch_size = 3;
//                    int32 batch_index = 4; int32 batch_id = 5; }
// OtpParameters    { bytes secret = 1; string name = 2; string issuer = 3; Algorithm algorithm = 4;
//                    DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }
import { base32Encode, base32Decode } from './otp.js';

const ALG = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const ALG_OUT = { SHA1: 1, SHA256: 2, SHA512: 3 };

function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    if (pos.i >= buf.length) throw new Error('Truncated export code');
    b = buf[pos.i++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error('Bad export code');
  } while (b & 0x80);
  return result;
}

function fields(buf) {
  const pos = { i: 0 };
  const out = [];
  while (pos.i < buf.length) {
    const key = Number(readVarint(buf, pos));
    const no = key >>> 3, wt = key & 7;
    if (wt === 0) out.push([no, readVarint(buf, pos)]);
    else if (wt === 2) { const len = Number(readVarint(buf, pos)); if (pos.i + len > buf.length) throw new Error('Truncated export code'); out.push([no, buf.subarray(pos.i, pos.i + len)]); pos.i += len; }
    else if (wt === 1) { pos.i += 8; } else if (wt === 5) { pos.i += 4; }
    else throw new Error('Bad export code');
  }
  return out;
}

const utf8 = (b) => new TextDecoder().decode(b);

export function isMigrationUri(s) { return /^otpauth-migration:\/\/offline\?/i.test(String(s).trim()); }

export function decodeMigration(uri) {
  const u = new URL(String(uri).trim());
  const data = u.searchParams.get('data');
  if (!data) throw new Error('That export code has no data.');
  const bin = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/').replace(/ /g, '+')), (c) => c.charCodeAt(0));
  const accounts = [];
  const meta = { version: 0, batchSize: 1, batchIndex: 0, batchId: 0 };
  let skipped = 0;
  for (const [no, v] of fields(bin)) {
    if (no === 1) {
      if (!(v instanceof Uint8Array)) continue;
      let parsed;
      try { parsed = fields(v); } catch { skipped++; continue; }
      const isB = (x) => x instanceof Uint8Array;
      if (parsed.some(([n, x]) => ([1, 2, 3].includes(n) && !isB(x)) || ([4, 5, 6, 7].includes(n) && isB(x)))) { skipped++; continue; }
      const a = { type: 'totp', algorithm: 'SHA1', digits: 6, period: 30, issuer: '', account: '' };
      for (const [n, x] of parsed) {
        if (n === 1) a.secret = base32Encode(x);
        else if (n === 2) a.name = utf8(x);
        else if (n === 3) a.issuer = utf8(x);
        else if (n === 4) { a.algorithm = ALG[Number(x)] || 'SHA1'; if (a.algorithm === 'MD5') a.bad = true; }
        else if (n === 5) a.digits = Number(x) === 2 ? 8 : 6;
        else if (n === 6) a.type = Number(x) === 1 ? 'hotp' : 'totp';
        else if (n === 7) { if (x > BigInt(Number.MAX_SAFE_INTEGER)) { a.bad = true; } else a.counter = Number(x); }
      }
      if (!a.secret || a.bad) { skipped++; continue; }
      // name is usually "Issuer:account"
      const nm = a.name || '';
      const i = nm.indexOf(':');
      if (i >= 0) { if (!a.issuer) a.issuer = nm.slice(0, i).trim(); a.account = nm.slice(i + 1).trim(); } else a.account = nm;
      delete a.name;
      if (a.type === 'totp') delete a.counter;
      accounts.push(a);
    } else if (no === 2 && !(v instanceof Uint8Array)) meta.version = Number(v);
    else if (no === 3 && !(v instanceof Uint8Array)) meta.batchSize = Number(v) || 1;
    else if (no === 4 && !(v instanceof Uint8Array)) meta.batchIndex = Number(v);
    else if (no === 5 && !(v instanceof Uint8Array)) meta.batchId = Number(v);
  }
  return { accounts, skipped, ...meta };
}

// ---- encoder (for "move to your phone" and tests) ----
function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
function lenField(no, bytes) { return [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes]; }
function intField(no, n) { return [...varint((no << 3) | 0), ...varint(n)]; }

export function encodeMigration(accounts, { batchSize = 1, batchIndex = 0, batchId = 1 } = {}) {
  const enc = new TextEncoder();
  const body = [];
  for (const a of accounts) {
    const name = a.issuer ? `${a.issuer}:${a.account || ''}` : (a.account || '');
    const p = [
      ...lenField(1, base32Decode(a.secret)), ...lenField(2, enc.encode(name)), ...lenField(3, enc.encode(a.issuer || '')),
      ...intField(4, ALG_OUT[a.algorithm] || 1), ...intField(5, a.digits === 8 ? 2 : 1), ...intField(6, a.type === 'hotp' ? 1 : 2),
      ...(a.type === 'hotp' ? intField(7, a.counter || 0) : []),
    ];
    body.push(...lenField(1, p));
  }
  body.push(...intField(2, 1), ...intField(3, batchSize), ...intField(4, batchIndex), ...intField(5, batchId));
  let s = ''; for (const b of body) s += String.fromCharCode(b);
  return 'otpauth-migration://offline?data=' + encodeURIComponent(btoa(s));
}
