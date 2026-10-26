import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVaultKey, seal, open, wrapWithSecret, unwrapWithSecret, newDeviceKey, wrapWithDevice, unwrapWithDevice, newRecoveryKey, formatRecoveryKey, looksLikeRecoveryKey, PBKDF2_ITERATIONS } from '../ext/lib/crypto.js';

test('seal/open round trip; tampering, wrong key or wrong record id all fail', async () => {
  const vk = await newVaultKey();
  const box = await seal(vk, { secret: 'GEZDGNBV', n: 1 }, 'acct:1');
  assert.deepEqual(await open(vk, box, 'acct:1'), { secret: 'GEZDGNBV', n: 1 });
  await assert.rejects(open(vk, box, 'acct:2'), 'aad binds the record id');
  const bad = { ...box, ct: box.ct.slice(0, -4) + (box.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(open(vk, bad, 'acct:1'));
  await assert.rejects(open(await newVaultKey(), box, 'acct:1'));
  const box2 = await seal(vk, { secret: 'GEZDGNBV', n: 1 }, 'acct:1');
  assert.notEqual(box.iv, box2.iv, 'fresh IV every time');
});

test('recovery key: 26 symbols from the safe alphabet, unique, wraps and unwraps the vault key', async () => {
  const rk = newRecoveryKey();
  assert.match(rk, /^([A-HJKMNP-Z2-9]{4}-){6}[A-HJKMNP-Z2-9]{2}$/);
  assert.ok(looksLikeRecoveryKey(rk));
  assert.notEqual(rk, newRecoveryKey());
  const vk = await newVaultKey();
  const box = await seal(vk, 'hello', 'x');
  const w = await wrapWithSecret(vk, rk, 'recovery');
  assert.equal(w.iterations, PBKDF2_ITERATIONS);
  // typed back lowercase, without dashes, with spaces
  const typed = rk.toLowerCase().replace(/-/g, ' ');
  assert.equal(await open(await unwrapWithSecret(w, typed), box, 'x'), 'hello');
  await assert.rejects(unwrapWithSecret(w, newRecoveryKey()), /recovery key doesn’t match/);
});

test('app password wrap: right password opens, wrong one fails with a plain message', async () => {
  const vk = await newVaultKey();
  const w = await wrapWithSecret(vk, 'correct horse battery staple', 'password');
  const box = await seal(vk, [1, 2, 3], 'y');
  assert.deepEqual(await open(await unwrapWithSecret(w, 'correct horse battery staple'), box, 'y'), [1, 2, 3]);
  await assert.rejects(unwrapWithSecret(w, 'wrong'), /Wrong password/);
});

test('device key is non-extractable and unwraps only its own wrap', async () => {
  const dk = await newDeviceKey();
  assert.equal(dk.extractable, false);
  const vk = await newVaultKey();
  const w = await wrapWithDevice(vk, dk);
  const box = await seal(vk, 'z', 'z');
  assert.equal(await open(await unwrapWithDevice(w, dk), box, 'z'), 'z');
  await assert.rejects(unwrapWithDevice(w, await newDeviceKey()));
});

test('recovery key alphabet is unbiased (chi-square over 26k symbols)', () => {
  const counts = {};
  for (let i = 0; i < 1000; i++) for (const c of newRecoveryKey().replace(/-/g, '')) counts[c] = (counts[c] || 0) + 1;
  const n = 26000, exp = n / 31;
  const chi = Object.values(counts).reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
  assert.equal(Object.keys(counts).length, 31);
  assert.ok(chi < 70, 'chi-square ' + chi.toFixed(1)); // df=30, p≈0.00005 cutoff
  assert.equal(formatRecoveryKey('abcdefgh'), 'ABCD-EFGH');
});
