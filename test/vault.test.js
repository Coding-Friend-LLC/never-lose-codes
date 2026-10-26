import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { Vault } from '../ext/lib/vault.js';

function memMirror() { const m = new Map(); return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : undefined; }, async set(k, v) { m.set(k, JSON.stringify(v)); } }; }
function env() { let t = 1_800_000_000_000; return { indexedDB: new IDBFactory(), mirror: memMirror(), now: () => (t += 1000) }; }
const acct = (n) => ({ issuer: 'Site' + n, account: `user${n}@x.com`, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', type: 'totp', digits: 6, period: 30, algorithm: 'SHA1' });

test('setup, add accounts, reopen and unlock with the device key', async () => {
  const e = env();
  const v = await new Vault(e).open();
  const rk = await v.setup();
  assert.match(rk, /-/);
  await v.addAccount(acct(1)); await v.addAccount(acct(2));
  await v.close();
  const v2 = await new Vault(e).open();
  assert.ok(v2.locked);
  await v2.unlock();
  assert.equal((await v2.accounts()).length, 2);
});

test('nothing readable is ever stored: no secret, issuer or email in the journal or mirror', async () => {
  const e = env();
  const v = await new Vault(e).open();
  await v.setup();
  await v.addAccount({ ...acct(1), secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', issuer: 'MySecretBank' });
  const dump = [...e.mirror.m.values()].join('');
  assert.ok(!dump.includes('JBSWY3DPEHPK3PXP'));
  assert.ok(!dump.includes('MySecretBank'));
  assert.ok(!dump.includes('user1@x.com'));
});

test('browser data cleared (device key gone): the recovery key gets everything back', async () => {
  const e = env();
  const v = await new Vault(e).open();
  const rk = await v.setup();
  await v.addAccount(acct(1));
  await v.close();
  const keyDbGone = new IDBFactory();
  // simulate: journal survives in mirror, but IndexedDB (journal + device key) is wiped
  const e2 = { ...e, indexedDB: keyDbGone };
  const v2 = await new Vault(e2).open();
  await assert.rejects(v2.unlock(), /DEVICE_KEY_MISSING/);
  await v2.unlockWithRecovery(rk);
  assert.equal((await v2.accounts()).length, 1);
  await v2.close();
  const v3 = await new Vault(e2).open();
  await v3.unlock(); // a fresh device key was created by the recovery unlock
  assert.equal((await v3.accounts()).length, 1);
});

test('forgotten app password: recovery key still opens the vault', async () => {
  const e = env();
  const v = await new Vault(e).open();
  const rk = await v.setup();
  await v.addAccount(acct(1));
  await v.setPassword('longpassword1');
  await v.close();
  const v2 = await new Vault(e).open();
  await assert.rejects(v2.unlock(), /Password required/);
  await assert.rejects(v2.unlock({ password: 'nope-nope-nope' }), /Wrong password/);
  await v2.unlockWithRecovery(rk);
  assert.equal((await v2.accounts()).length, 1);
});

test('backup file: encrypted, opens on a brand-new computer with only the recovery key', async () => {
  const e = env();
  const v = await new Vault(e).open();
  const rk = await v.setup();
  await v.addAccount(acct(1)); await v.addAccount(acct(2));
  const backup = JSON.parse(JSON.stringify(v.exportBackup()));
  const txt = JSON.stringify(backup);
  assert.ok(!txt.includes('GEZDGNBV') && !txt.includes('user1@x.com'), 'backup file has no readable secrets');
  const fresh = await new Vault(env()).open(); // new computer, nothing set up
  const r = await fresh.restoreBackup(backup, rk.toLowerCase());
  assert.equal(r.added, 2);
  assert.equal((await fresh.accounts()).length, 2);
  await assert.rejects(new Vault(env()).open().then((x) => x.restoreBackup(backup, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GG')), /recovery key doesn’t match/);
});

test('restoring into an existing vault with a different key re-seals accounts and never overwrites newer ones', async () => {
  const a = await new Vault(env()).open(); const rkA = await a.setup();
  const id = await a.addAccount(acct(1));
  const backup = JSON.parse(JSON.stringify(a.exportBackup()));
  const b = await new Vault(env()).open(); await b.setup();
  await b.addAccount(acct(9));
  const r = await b.restoreBackup(backup, rkA);
  assert.equal(r.added, 1);
  assert.equal((await b.accounts()).length, 2);
  // restore again: nothing new
  assert.equal((await b.restoreBackup(backup, rkA)).added, 0);
  void id;
});

test('damaged backup is rejected and nothing changes', async () => {
  const v = await new Vault(env()).open(); const rk = await v.setup();
  await v.addAccount(acct(1));
  const backup = JSON.parse(JSON.stringify(v.exportBackup()));
  backup.count = 999;
  const fresh = await new Vault(env()).open();
  await assert.rejects(fresh.restoreBackup(backup, rk), /damaged/);
  assert.ok(!fresh.isSetUp);
});

test('trash keeps deleted accounts recoverable', async () => {
  const v = await new Vault(env()).open(); await v.setup();
  const id = await v.addAccount(acct(1));
  await v.trash(id);
  assert.equal((await v.accounts()).length, 0);
  assert.equal((await v.accounts({ includeTrash: true })).length, 1);
  await v.untrash(id);
  assert.equal((await v.accounts()).length, 1);
});

test('backups need no unlock and carry only the recovery wrap (no password/device wraps)', async () => {
  const e = env();
  const v = await new Vault(e).open(); const rk = await v.setup();
  await v.addAccount(acct(1)); await v.setPassword('longpassword1');
  await v.close();
  const locked = await new Vault(e).open(); // not unlocked
  const b = JSON.parse(JSON.stringify(locked.exportBackup()));
  assert.equal(b.count, 1);
  assert.deepEqual(Object.keys(b.state.meta.keys), ['recovery']);
  assert.ok(!JSON.stringify(b).includes('"password"'));
  const fresh = await new Vault(env()).open();
  assert.equal((await fresh.restoreBackup(b, rk)).added, 1);
  assert.deepEqual(await locked.selfTest(), { ok: true, partial: true, count: 1 });
});

test('AUDIT H1: with a password set, nothing on disk opens the vault without it', async () => {
  const e = env();
  const v = await new Vault(e).open(); const rk = await v.setup();
  await v.addAccount(acct(1)); await v.setPassword('longpassword1');
  assert.equal(v.keys.device, undefined, 'device wrap removed');
  await v.close();
  const v2 = await new Vault(e).open();
  await assert.rejects(v2.unlock(), /Password required/);
  // flipping a flag can no longer bypass the password: there is no device wrap to use
  assert.ok(!('requirePassword' in v2.keys));
  await v2.unlock({ password: 'longpassword1' });
  await v2.removePassword();
  await v2.close();
  const v3 = await new Vault(e).open(); await v3.unlock();
  assert.equal((await v3.accounts()).length, 1);
  void rk;
});

test('AUDIT M1: a forged backup cannot roll back, trash or overwrite local accounts', async () => {
  const v = await new Vault(env()).open(); const rk = await v.setup();
  const id = await v.addAccount({ ...acct(1), secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
  const old = JSON.parse(JSON.stringify(v.exportBackup()));
  await v.updateAccount(id, { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }); // user re-enrolled
  // attacker edits the old backup: future timestamp + trash mark, recomputes the checksum
  const { sealed } = await import('../ext/lib/checksum.js');
  const { crc, ...body } = old;
  for (const r of Object.values(body.state.sessions)) { r.updatedAt = 9e15; r.trashedAt = 9e15; }
  const forged = sealed(body);
  await v.restoreBackup(forged, rk);
  const mine = (await v.accounts({ includeTrash: true })).find((a) => a.id === id);
  assert.equal(mine.secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'local secret untouched');
  assert.equal(mine.trashedAt, null, 'not trashed by the backup');
});

test('AUDIT M2: editing keeps Trash state; broken records are never overwritten', async () => {
  const v = await new Vault(env()).open(); await v.setup();
  const id = await v.addAccount(acct(1));
  await v.trash(id);
  await v.updateAccount(id, { issuer: 'Renamed' });
  assert.ok((await v.accounts({ includeTrash: true })).find((a) => a.id === id).trashedAt);
  await v.store.saveSession({ id: 'zzz', kind: 'account', box: { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }, windows: [] });
  await assert.rejects(v.updateAccount('zzz', { issuer: 'x' }), /can’t be opened/);
});

test('AUDIT L1/L2: bad accounts and absurd key-file settings are rejected up front', async () => {
  const v = await new Vault(env()).open(); const rk = await v.setup();
  for (const bad of [{ secret: 'A' }, { secret: 'GEZDGNBV' }, { secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'MD5' }, { secret: 'GEZDGNBVGY3TQOJQ', period: Infinity }, { secret: 'GEZDGNBVGY3TQOJQ', type: 'hotp', counter: 'abc' }, { secret: 'GEZDGNBVGY3TQOJQ', digits: 7 }])
    await assert.rejects(v.addAccount({ ...acct(1), ...bad }));
  const b = JSON.parse(JSON.stringify(v.exportBackup()));
  const { sealed } = await import('../ext/lib/checksum.js');
  const { crc, ...body } = b; body.state.meta.keys.recovery.iterations = 1e9;
  await assert.rejects(new Vault(env()).open().then((x) => x.restoreBackup(sealed(body), rk)), /settings this app doesn’t accept/);
});
