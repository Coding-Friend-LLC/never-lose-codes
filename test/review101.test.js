// Regression tests for the independent security review of 1.0.1 (H1, M1-related, L1-L5, nits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { effectiveExpiry, unlockIsLive, alarmTime, adjustedExpiry, lockExpiry, DEFAULT_LOCK_MINUTES } from '../ext/lib/autolock.js';
import { moveAccount, sortAccounts, filterAccounts } from '../ext/lib/organize.js';
import { validateAccount, MAX_SECRET_CHARS } from '../ext/lib/otp.js';
import { fitsOneQr, singleUri, QR_MAX_BYTES_M } from '../ext/lib/export.js';
import { verifyKey } from '../ext/lib/license.js';
import { Vault } from '../ext/lib/vault.js';

const MIN = 60000, DAY = 86400000, NOW = 1_800_000_000_000;
const FOREVER = Number.MAX_SAFE_INTEGER;

// ---------------- H1 / L1 / L3: pure expiry rules ----------------
test('H1/L3: an unlock is live only before its expiry; free plans are capped at the default', () => {
  const s = { raw: 'k', exp: NOW + 60 * MIN, at: NOW };
  assert.equal(unlockIsLive(s, true, NOW + 59 * MIN), true);
  assert.equal(unlockIsLive(s, true, NOW + 60 * MIN), false);
  // after the trial ends, a 1-hour (or forever) unlock made during the trial lasts only 15 minutes
  assert.equal(effectiveExpiry(s, false), NOW + DEFAULT_LOCK_MINUTES * MIN);
  assert.equal(effectiveExpiry({ raw: 'k', exp: FOREVER, at: NOW }, false), NOW + DEFAULT_LOCK_MINUTES * MIN);
  assert.equal(unlockIsLive({ raw: 'k', exp: FOREVER, at: NOW }, false, NOW + 16 * MIN), false);
  // an edited/malformed entry (no key or no start time) never counts, on any plan
  assert.equal(effectiveExpiry({ exp: FOREVER }, false), 0);
  assert.equal(effectiveExpiry({ exp: NOW + 1e9 }, true), 0);
  assert.equal(effectiveExpiry({ raw: 'k', exp: NOW + 1e9 }, true), 0);
  assert.equal(effectiveExpiry({ exp: NOW + 1e9, at: NOW }, true), 0);
  assert.equal(unlockIsLive(null, true), false);
});

test('H1: the background alarm fires at expiry, or at trial end for "until Chrome closes"', () => {
  assert.equal(alarmTime({ raw: 'k', exp: NOW + MIN, at: NOW }, true), NOW + MIN);
  assert.equal(alarmTime({ raw: 'k', exp: FOREVER, at: NOW }, true), null); // session storage clears when Chrome closes
  assert.equal(alarmTime({ raw: 'k', exp: FOREVER, at: NOW }, true, NOW + 3 * DAY), NOW + 3 * DAY);
  assert.equal(alarmTime({ raw: 'k', exp: FOREVER, at: NOW }, false), NOW + 15 * MIN);
  assert.equal(alarmTime(null, true), null);
});

test('L3: changing the auto-lock setting never extends an open unlock', () => {
  const s = { exp: NOW + MIN, at: NOW };
  assert.equal(adjustedExpiry(s, 0), NOW + MIN); // "until Chrome closes" does not extend
  assert.equal(adjustedExpiry(s, 60), NOW + MIN);
  const long = { exp: NOW + 60 * MIN, at: NOW };
  assert.equal(adjustedExpiry(long, 1), NOW + MIN); // shorter applies right away
  assert.equal(adjustedExpiry({ exp: NOW + MIN }, 60), NOW + MIN); // no start time: unchanged
});

// ---------------- H1: session code deletes expired keys and schedules the alarm ----------------
function fakeChrome({ installedAt = NOW - 30 * DAY, license = null } = {}) {
  const session = {}, local = { nlc_installedAt: installedAt, ...(license ? { nlc_license: license } : {}) };
  const alarms = {};
  const pick = (store, k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries((k || []).map((x) => [x, store[x]])));
  return {
    session, local, alarms,
    storage: {
      session: { get: async (k) => pick(session, k), set: async (o) => Object.assign(session, o), remove: async (k) => { delete session[k]; } },
      local: { get: async (k) => pick(local, k), set: async (o) => Object.assign(local, o) },
    },
    alarms: Object.assign(alarms, {
      create: async (name, info) => { alarms[name + ':when'] = info.when; },
      clear: async (name) => { delete alarms[name + ':when']; return true; },
    }),
    runtime: { sendMessage: () => Promise.resolve() },
  };
}

async function sessionModule(chromeFake, now) {
  globalThis.chrome = chromeFake;
  const realNow = Date.now;
  Date.now = () => now;
  const mod = await import('../ext/src/session.js?' + Math.random());
  return { mod, restore: () => { Date.now = realNow; } };
}

test('H1: readUnlock deletes an expired key (editing exp afterwards has nothing to open)', async () => {
  const c = fakeChrome({ installedAt: NOW - DAY }); // in trial: can choose
  c.session.nlc_vk = { raw: 'AAAA', exp: NOW - 1, at: NOW - MIN };
  const { mod, restore } = await sessionModule(c, NOW);
  try {
    assert.equal(await mod.readUnlock(), null);
    assert.equal(c.session.nlc_vk, undefined, 'expired key must be removed from session storage');
    // the walk-up attack: set a far-future expiry on the (now missing) entry -> still nothing
    const s = (await c.storage.session.get('nlc_vk')).nlc_vk;
    assert.equal(s, undefined);
    // and a hand-made entry without the key (or start time) is refused and deleted too
    c.session.nlc_vk = { exp: NOW + 1e9 };
    assert.equal(await mod.readUnlock(), null);
    assert.equal(c.session.nlc_vk, undefined);
  } finally { restore(); }
});

test('H1: rememberUnlock records the start time and arms the background alarm; forget clears both', async () => {
  const c = fakeChrome({ installedAt: NOW - DAY });
  c.local.nlc_autoLock = 1;
  const { mod, restore } = await sessionModule(c, NOW);
  try {
    const vk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await mod.rememberUnlock({ vk });
    assert.equal(c.session.nlc_vk.at, NOW);
    assert.equal(c.session.nlc_vk.exp, NOW + MIN);
    assert.equal(c.alarms['autolock:when'], NOW + MIN);
    await mod.forgetUnlock();
    assert.equal(c.session.nlc_vk, undefined);
    assert.equal(c.alarms['autolock:when'], undefined);
  } finally { restore(); }
});

test('H1/L3: after the trial, an "until Chrome closes" unlock is dropped once 15 minutes have passed', async () => {
  const c = fakeChrome({ installedAt: NOW - 30 * DAY }); // free plan now
  c.session.nlc_vk = { raw: 'AAAA', exp: FOREVER, at: NOW - 16 * MIN };
  const { mod, restore } = await sessionModule(c, NOW);
  try {
    assert.equal(await mod.sweepUnlock(), false);
    assert.equal(c.session.nlc_vk, undefined);
  } finally { restore(); }
});

test('H1: sweepUnlock keeps a live unlock and re-arms the alarm for it', async () => {
  const c = fakeChrome({ installedAt: NOW - DAY });
  c.session.nlc_vk = { raw: 'AAAA', exp: NOW + 5 * MIN, at: NOW };
  const { mod, restore } = await sessionModule(c, NOW);
  try {
    assert.equal(await mod.sweepUnlock(), true);
    assert.equal(c.alarms['autolock:when'], NOW + 5 * MIN);
    assert.equal(await mod.unlockEndsAt(), NOW + 5 * MIN);
  } finally { restore(); }
});

test('H1: the background worker sweeps on start and on the autolock alarm', () => {
  const src = fs.readFileSync(new URL('../ext/src/background.js', import.meta.url), 'utf8');
  assert.match(src, /a\.name === 'autolock'[^\n]*sweepUnlock/);
  assert.match(src, /^sweepUnlock\(\)\.catch/m);
});

test('H1/L1/L2: pages drop the key at the exact expiry and stop the decrypted refresh loop', () => {
  const m = fs.readFileSync(new URL('../ext/src/manager.js', import.meta.url), 'utf8');
  assert.match(m, /async function lockNow\(\) \{\s*await forgetUnlock\(\);\s*clearInterval\(window\.__t\); ACCTS = \[\];/);
  assert.match(m, /LOCK_TIMER = setTimeout\(lockNow/);
  assert.match(m, /if \(STATE !== 'open'\) \{ clearInterval\(window\.__t\); ACCTS = \[\]; \}/);
  assert.doesNotMatch(m, /lockSel\.onchange[^;]*rememberUnlock/); // L3: setting change doesn't renew the unlock
  const p = fs.readFileSync(new URL('../ext/src/popup.js', import.meta.url), 'utf8');
  assert.match(p, /lockTimer = setTimeout\(autoLock/);
  assert.match(p, /async function autoLock\(\) \{\s*clearInterval\(tick\); clearTimeout\(lockTimer\);\s*accts = \[\];\s*await forgetUnlock\(\);/);
});

// ---------------- M1 + nits: clipboard and export field ----------------
test('M1: copied export is cleared from the clipboard after 45 seconds; export box has no spellcheck/autofill', () => {
  const m = fs.readFileSync(new URL('../ext/src/manager.js', import.meta.url), 'utf8');
  assert.match(m, /writeText\(ta\.value\); clearClipboardLater\(\);/);
  assert.match(m, /function clearClipboardLater\(ms = 45000\)/);
  assert.match(m, /navigator\.clipboard\.writeText\(''\)/);
  assert.match(m, /Windows clipboard history/);
  assert.match(m, /'Exported links'/);
  assert.match(m, /spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Exported links'/);
});

test('nit: the export password field is cleared even when a free user is shown the Pro note', () => {
  const m = fs.readFileSync(new URL('../ext/src/manager.js', import.meta.url), 'utf8');
  const i = m.indexOf("const pwOk = !pw || await V.verifyPassword(pw.value);");
  assert.ok(i > 0);
  const after = m.slice(i, i + 400);
  assert.ok(after.indexOf("if (pw) pw.value = '';") < after.indexOf("proPrompt('Moving accounts"));
});

test('nit: a malformed license key names this product', async () => {
  const r = await verifyKey('not a key');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Never Lose Codes key/);
});

// ---------------- L4: QR overflow ----------------
function loadUmd(file) { const sb = { module: { exports: {} } }; sb.exports = sb.module.exports; vm.runInNewContext(fs.readFileSync(file, 'utf8'), sb); return sb.module.exports; }
const qrcode = loadUmd(new URL('../ext/vendor/qrcode-generator.js', import.meta.url));

test('L4: a too-long account is detected before drawing (and the library really would throw)', () => {
  const big = { type: 'totp', issuer: '€'.repeat(120), account: 'x'.repeat(200), secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
  const uri = singleUri(big);
  assert.equal(fitsOneQr(uri), false);
  assert.throws(() => { const q = qrcode(0, 'M'); q.addData(uri, 'Byte'); q.make(); }, /overflow/);
  // exactly at capacity still draws
  const edge = 'A'.repeat(QR_MAX_BYTES_M);
  assert.equal(fitsOneQr(edge), true);
  assert.doesNotThrow(() => { const q = qrcode(0, 'M'); q.addData(edge, 'Byte'); q.make(); });
  assert.equal(fitsOneQr(edge + 'A'), false);
  const m = fs.readFileSync(new URL('../ext/src/manager.js', import.meta.url), 'utf8');
  assert.match(m, /function qrOrFallback\(text, accts\)/);
  assert.equal((m.match(/drawQr\(/g) || []).length, 2, 'drawQr is only called inside qrOrFallback (plus its definition)');
});

test('L4: secrets longer than 256 characters are refused; real-world lengths are fine', () => {
  const ok = 'A'.repeat(MAX_SECRET_CHARS);
  assert.equal(validateAccount({ issuer: 'X', secret: ok }).secret.length, MAX_SECRET_CHARS);
  assert.throws(() => validateAccount({ issuer: 'X', secret: ok + 'A' }), /too long/);
  assert.equal(validateAccount({ issuer: 'X', secret: 'JBSWY3DPEHPK3PXP' }).secret, 'JBSWY3DPEHPK3PXP');
});

// ---------------- L5: reorder inside a filtered view ----------------
test('L5: dragging within a filtered view keeps every position unique across the whole list', () => {
  const all = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ id: x, issuer: x.toUpperCase(), group: i % 2 ? 'Work' : 'Home', order: i }));
  const shown = sortAccounts(filterAccounts(all, { group: 'Home' })); // a, c, e
  assert.deepEqual(shown.map((a) => a.id), ['a', 'c', 'e']);
  // the old way (numbering only what is shown) collides with hidden accounts:
  const old = moveAccount(shown, 'e', 'a');
  const oldOrders = all.map((a) => (a.id in old ? old[a.id] : a.order));
  assert.notEqual(new Set(oldOrders).size, all.length);
  // the fix: number against the whole sorted list
  const fixed = moveAccount(sortAccounts(all), 'e', 'a');
  const merged = all.map((a) => ({ ...a, order: a.id in fixed ? fixed[a.id] : a.order }));
  assert.equal(new Set(merged.map((a) => a.order)).size, all.length);
  assert.deepEqual(sortAccounts(merged).map((a) => a.id), ['e', 'a', 'b', 'c', 'd']);
});

test('L5: updateAccounts decrypts the list once for a whole reorder', async () => {
  const mirrorData = {};
  const mirror = { async get(k) { return mirrorData[k]; }, async set(k, v) { mirrorData[k] = v; } };
  const v = await new Vault({ indexedDB: new IDBFactory(), mirror }).open();
  await v.setup();
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await v.addAccount({ issuer: 'Site ' + i, secret: 'JBSWY3DPEHPK3PXP' }));
  let listCalls = 0;
  const orig = v.accounts.bind(v);
  v.accounts = (...a) => { listCalls++; return orig(...a); };
  const n = await v.updateAccounts(Object.fromEntries(ids.map((id, i) => [id, { order: 19 - i }])).valueOf());
  assert.equal(n, 20);
  assert.equal(listCalls, 1, 'one decrypt pass for the whole batch');
  v.accounts = orig;
  const after = await v.accounts();
  assert.equal(new Set(after.map((a) => a.order)).size, 20);
  assert.equal(await v.updateAccounts({ nope: { order: 1 } }), 0);
  await v.close();
});
