// Moving accounts back to a phone. Pure: builds the QR payloads; drawing happens in the page.
// Google Authenticator reads "otpauth-migration" codes (several accounts per code, in numbered batches);
// almost every other authenticator app reads one "otpauth" code per account.
import { encodeMigration } from './migration.js';
import { toOtpauth } from './otp.js';

// Keep each QR easy for a phone camera to read from a screen.
export const MAX_PER_QR = 8;
export const MAX_QR_CHARS = 1000;

// Split accounts into Google Authenticator export codes. Each code knows its place (1 of 3, ...), and
// all codes in one export share a batch id, exactly like Google Authenticator's own export.
export function migrationBatches(accounts, { maxPer = MAX_PER_QR, maxChars = MAX_QR_CHARS, batchId = 1 + Math.floor(Math.random() * 0x7fffffff) } = {}) {
  const list = accounts.filter((a) => a && a.secret);
  if (!list.length) return [];
  // greedy: grow a chunk while it stays under both limits
  const chunks = [];
  let cur = [];
  for (const a of list) {
    const next = [...cur, a];
    if (cur.length && (next.length > maxPer || encodeMigration(next).length > maxChars)) { chunks.push(cur); cur = [a]; } else cur = next;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => ({ uri: encodeMigration(c, { batchSize: chunks.length, batchIndex: i, batchId }), accounts: c, index: i, total: chunks.length }));
}

export function singleUri(a) { return toOtpauth(a); }

// One plain-text line per account (otpauth links). Free export: lets you take your codes anywhere.
export function textExport(accounts) {
  return accounts.filter((a) => a && a.secret).map(toOtpauth).join('\n') + '\n';
}

// The most a QR code can hold at the error-correction level we draw (M, version 40): 2,331 bytes.
export const QR_MAX_BYTES_M = 2331;
export function fitsOneQr(text) { return new TextEncoder().encode(String(text)).length <= QR_MAX_BYTES_M; }
