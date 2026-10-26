// Shared: live code rendering + adding accounts from images, text, webcam.
import { totp, hotp, base32Decode, secondsLeft, parseOtpauth } from '../lib/otp.js';
import { isMigrationUri, decodeMigration } from '../lib/migration.js';

export async function codeFor(a, now = Date.now()) {
  const key = base32Decode(a.secret);
  if (a.type === 'hotp') return hotp(key, a.counter || 0, a);
  return totp(key, { ...a, now });
}

export function prettyCode(c) { return c.length === 6 ? c.slice(0, 3) + ' ' + c.slice(3) : c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c; }
export { secondsLeft };

// Turn any text the user gives us (otpauth link, migration link, or a bare secret) into accounts.
export function accountsFromText(text) {
  const t = String(text || '').trim();
  if (!t) return { accounts: [] };
  if (isMigrationUri(t)) { const r = decodeMigration(t); return { accounts: r.accounts, batch: r }; }
  if (/^otpauth:\/\//i.test(t)) return { accounts: [parseOtpauth(t)] };
  const lines = t.split(/\s*\n\s*/).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => /^otpauth/i.test(l))) {
    const out = []; for (const l of lines) out.push(...accountsFromText(l).accounts); return { accounts: out };
  }
  base32Decode(t); // bare secret: validates or throws a plain message
  return { accounts: [{ type: 'totp', secret: t.replace(/[\s-]/g, '').toUpperCase(), issuer: '', account: '', digits: 6, period: 30, algorithm: 'SHA1' }], needsName: true };
}

// Read a QR code from an image File/Blob using the vendored jsQR (global window.jsQR).
export async function qrFromImage(blob) {
  const bmp = await createImageBitmap(blob);
  // try full size, then scaled down (very large screenshots decode better smaller), then upscaled
  for (const scale of [1, Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), 2]) {
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    const r = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (r && r.data) return r.data;
  }
  throw new Error('No QR code found in that image. Try a sharper screenshot, or crop to the QR code.');
}

export function scanFromVideo(video, onText) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  let stop = false;
  (function tick() {
    if (stop) return;
    if (video.readyState >= 2) {
      c.width = video.videoWidth; c.height = video.videoHeight;
      g.drawImage(video, 0, 0);
      const r = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      if (r && r.data) { stop = true; onText(r.data); return; }
    }
    requestAnimationFrame(tick);
  })();
  return () => { stop = true; };
}

export function label(a) { return a.issuer || a.account || 'Unnamed account'; }
