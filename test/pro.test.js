// 1.0.1 Pro extras: gating, organizing, move-to-phone export (QR round trip), auto-lock timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { entitlement, PRO_FEATURES, FREE_AFTER_TRIAL } from '../ext/lib/license.js';
import { sortAccounts, filterAccounts, groupNames, moveAccount, cleanOrganize, badge, BADGE_COLORS } from '../ext/lib/organize.js';
import { migrationBatches, singleUri, textExport, MAX_QR_CHARS } from '../ext/lib/export.js';
import { decodeMigration } from '../ext/lib/migration.js';
import { parseOtpauth, validateAccount } from '../ext/lib/otp.js';
import { lockMinutes, lockExpiry, LOCK_CHOICES, DEFAULT_LOCK_MINUTES } from '../ext/lib/autolock.js';
import { Vault } from '../ext/lib/vault.js';

const DAY = 86400000;
const NOW = 1_800_000_000_000;

// load the vendored browser libraries exactly as shipped (UMD files) into a sandbox
function loadUmd(file) { const sb = { module: { exports: {} } }; sb.exports = sb.module.exports; vm.runInNewContext(fs.readFileSync(file, 'utf8'), sb); return sb.module.exports; }
const qrcode = loadUmd(new URL('../ext/vendor/qrcode-generator.js', import.meta.url));
const jsQR = loadUmd(new URL('../ext/vendor/jsQR.js', import.meta.url));

function qrRoundTrip(text) {
  const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount(), quiet = 4, s = 4, w = (n + quiet * 2) * s;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const i = (((r + quiet) * s + y) * w + (c + quiet) * s + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  }
  const out = jsQR(px, w, w);
  return out && out.data;
}

const mk = (i, extra = {}) => validateAccount({ id: 'a' + i, type: 'totp', issuer: 'Site ' + i, account: `user${i}@example.com`, secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PX' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[i % 32], digits: 6, period: 30, algorithm: 'SHA1', ...extra });

test('gating: trial and Pro get every extra; free keeps every core feature but not the extras', () => {
  const trial = entitlement({ installedAt: NOW - 3 * DAY, licensed: null }, NOW);
  const free = entitlement({ installedAt: NOW - 20 * DAY, licensed: null }, NOW);
  const pro = entitlement({ installedAt: NOW - 400 * DAY, licensed: { v: 1 } }, NOW);
  for (const f of PRO_FEATURES) { assert.ok(trial.can(f), 'trial ' + f); assert.ok(pro.can(f), 'pro ' + f); assert.equal(free.can(f), false, 'free ' + f); }
  for (const f of ['view', 'copy', 'add', 'import', 'backups', 'restore', 'export', 'trash', 'recovery', 'password']) assert.ok(free.can(f), 'free core ' + f);
  for (const f of PRO_FEATURES) assert.ok(!FREE_AFTER_TRIAL.has(f));
});

test('organize: only safe fields are accepted', () => {
  assert.deepEqual(cleanOrganize({ group: '  Work\u0007 ', pinned: 'yes', order: '3', color: 'red', secret: 'X', issuer: 'evil' }), { group: 'Work', pinned: false, order: 3, color: null });
  assert.equal(cleanOrganize({ group: 'x'.repeat(99) }).group.length, 40);
  assert.equal(cleanOrganize({ color: BADGE_COLORS[2] }).color, BADGE_COLORS[2]);
  assert.equal(cleanOrganize({ order: 'nope' }).order, null);
});

test('organize: pinned first, then custom order, then alphabetical; filter by group and search', () => {
  const list = [mk(1, { issuer: 'Zeta' }), mk(2, { issuer: 'alpha' }), mk(3, { issuer: 'Mid', order: 0 }), mk(4, { issuer: 'Beta', pinned: true }), mk(5, { issuer: 'Gamma', order: 1, group: 'Work' })];
  assert.deepEqual(sortAccounts(list).map((a) => a.issuer), ['Beta', 'Mid', 'Gamma', 'alpha', 'Zeta']);
  assert.deepEqual(groupNames(list), ['Work']);
  assert.deepEqual(filterAccounts(list, { group: 'Work' }).map((a) => a.issuer), ['Gamma']);
  assert.deepEqual(filterAccounts(list, { query: 'user2@' }).map((a) => a.issuer), ['alpha']);
});

test('organize: drag to reorder returns the new positions and the order sticks', () => {
  const shown = sortAccounts([mk(1, { issuer: 'A' }), mk(2, { issuer: 'B' }), mk(3, { issuer: 'C' })]);
  const ch = moveAccount(shown, 'a3', 'a1'); // drop C before A
  const after = sortAccounts(shown.map((a) => ({ ...a, order: ch[a.id] ?? a.order })));
  assert.deepEqual(after.map((a) => a.issuer), ['C', 'A', 'B']);
  assert.deepEqual(moveAccount(shown, 'a1', 'a1'), {});
  assert.deepEqual(moveAccount(shown, 'nope', 'a1'), {});
  const toEnd = moveAccount(shown, 'a1', null);
  assert.deepEqual(sortAccounts(shown.map((a) => ({ ...a, order: toEnd[a.id] }))).map((a) => a.issuer), ['B', 'C', 'A']);
});

test('badges: deterministic letter + color, known services get their color, plain on free', () => {
  assert.deepEqual(badge({ issuer: 'GitHub' }), { letter: 'G', color: '#24292f' });
  assert.deepEqual(badge({ issuer: 'Bänk ✓' }), badge({ issuer: 'Bänk ✓' }));
  assert.equal(badge({ issuer: 'ébay' }).letter, 'É');
  assert.equal(badge({ issuer: '' , account: '' }).letter, 'U'); // "Unnamed account"
  assert.equal(badge({ issuer: 'GitHub' }, { colored: false }).color, null);
  assert.equal(badge({ issuer: 'GitHub', color: BADGE_COLORS[4] }).color, BADGE_COLORS[4]);
  assert.equal(badge({ issuer: 'GitHub', color: 'javascript:alert(1)' }).color, '#24292f');
});

test('move to phone: Google Authenticator batches decode back to exactly the accounts, in order', () => {
  const accts = Array.from({ length: 25 }, (_, i) => mk(i, { issuer: i % 3 ? 'Sité ' + i : 'Bänk ✓ ' + i, account: `ü${i}@example.com` }));
  accts[4] = mk(4, { type: 'hotp', counter: 42 });
  accts[7] = mk(7, { digits: 8, algorithm: 'SHA256' });
  const batches = migrationBatches(accts, { batchId: 77 });
  assert.ok(batches.length >= 4, 'split into several codes');
  const back = [];
  batches.forEach((b, i) => {
    assert.ok(b.uri.length <= MAX_QR_CHARS, 'code ' + i + ' small enough to scan');
    const d = decodeMigration(b.uri);
    assert.equal(d.batchSize, batches.length); assert.equal(d.batchIndex, i); assert.equal(d.batchId, 77); assert.equal(d.skipped, 0);
    back.push(...d.accounts);
  });
  assert.equal(back.length, accts.length);
  accts.forEach((a, i) => {
    const b = back[i];
    assert.equal(b.secret, a.secret); assert.equal(b.issuer, a.issuer); assert.equal(b.account, a.account);
    assert.equal(b.type, a.type); assert.equal(b.digits, a.digits); assert.equal(b.algorithm, a.algorithm);
    if (a.type === 'hotp') assert.equal(b.counter, 42);
  });
  assert.deepEqual(migrationBatches([]), []);
});

test('move to phone: every QR drawn by the shipped encoder reads back with the shipped scanner', () => {
  const accts = Array.from({ length: 12 }, (_, i) => mk(i, { issuer: 'Bänk ✓ ' + i }));
  for (const b of migrationBatches(accts)) assert.equal(qrRoundTrip(b.uri), b.uri);
  const one = singleUri(accts[3]);
  assert.equal(qrRoundTrip(one), one);
  const p = parseOtpauth(one);
  assert.equal(p.secret, accts[3].secret); assert.equal(p.issuer, accts[3].issuer); assert.equal(p.account, accts[3].account);
});

test('free text export: one otpauth link per account that parses back', () => {
  const accts = [mk(1), mk(2, { type: 'hotp', counter: 5 }), mk(3, { digits: 8 })];
  const lines = textExport(accts).trim().split('\n');
  assert.equal(lines.length, 3);
  lines.forEach((l, i) => { const p = parseOtpauth(l); assert.equal(p.secret, accts[i].secret); assert.equal(p.digits, accts[i].digits); });
  assert.equal(parseOtpauth(lines[1]).counter, 5);
});

test('auto-lock: choice only applies on Pro/trial; bad values fall back; 0 means until Chrome closes', () => {
  assert.equal(lockMinutes(60, true), 60);
  assert.equal(lockMinutes(0, true), 0);
  assert.equal(lockMinutes(60, false), DEFAULT_LOCK_MINUTES);
  assert.equal(lockMinutes(7, true), DEFAULT_LOCK_MINUTES);
  assert.equal(lockMinutes(undefined, true), DEFAULT_LOCK_MINUTES);
  assert.equal(lockMinutes('5', true), 5);
  assert.equal(lockExpiry(NOW, 1), NOW + 60000);
  assert.equal(lockExpiry(NOW, 15), NOW + 15 * 60000);
  assert.ok(lockExpiry(NOW, 0) > NOW + 100 * 365 * DAY);
  assert.ok(LOCK_CHOICES.some((c) => c.minutes === DEFAULT_LOCK_MINUTES));
});

test('export password check: right password passes, wrong fails, no password needs none', async () => {
  let t = NOW; const mirror = new Map();
  const e = { indexedDB: new IDBFactory(), mirror: { async get(k) { return mirror.has(k) ? JSON.parse(mirror.get(k)) : undefined; }, async set(k, v) { mirror.set(k, JSON.stringify(v)); } }, now: () => (t += 1000) };
  const v = await new Vault(e).open();
  await v.setup();
  assert.equal(await v.verifyPassword(''), true);
  await v.setPassword('correct horse');
  assert.equal(await v.verifyPassword('correct horse'), true);
  assert.equal(await v.verifyPassword('wrong horse'), false);
  assert.equal(await v.verifyPassword(undefined), false);
});

test('organize fields survive encryption and an edit never drops them', async () => {
  let t = NOW; const mirror = new Map();
  const e = { indexedDB: new IDBFactory(), mirror: { async get(k) { return mirror.has(k) ? JSON.parse(mirror.get(k)) : undefined; }, async set(k, v) { mirror.set(k, JSON.stringify(v)); } }, now: () => (t += 1000) };
  const v = await new Vault(e).open();
  await v.setup();
  const id = await v.addAccount(mk(1));
  await v.updateAccount(id, cleanOrganize({ group: 'Work', pinned: true, order: 2, color: BADGE_COLORS[1] }));
  await v.updateAccount(id, { issuer: 'Renamed' });
  const [a] = await v.accounts();
  assert.equal(a.group, 'Work'); assert.equal(a.pinned, true); assert.equal(a.order, 2); assert.equal(a.color, BADGE_COLORS[1]); assert.equal(a.issuer, 'Renamed');
  assert.ok(![...mirror.values()].join('').includes('Work'), 'group name is encrypted too');
});
