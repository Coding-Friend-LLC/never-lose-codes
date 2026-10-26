import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMigration, encodeMigration, isMigrationUri } from '../ext/lib/migration.js';
import { totp, base32Decode } from '../ext/lib/otp.js';

test('decodes a published real-world Google Authenticator export sample', () => {
  // Widely published example payload: secret "Hello!\xde\xad\xbe\xef", name "Example:alice@google.com", issuer "Example"
  const uri = 'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZSABKAEwAhABGAEgACjr4JKK%2Bf%2F%2F%2F%2F8B';
  assert.ok(isMigrationUri(uri));
  const r = decodeMigration(uri);
  assert.equal(r.accounts.length, 1);
  const a = r.accounts[0];
  assert.equal(a.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(a.issuer, 'Example');
  assert.equal(a.account, 'alice@google.com');
  assert.equal(a.type, 'totp');
  assert.equal(a.digits, 6);
  assert.equal(a.algorithm, 'SHA1');
});

test('25 accounts, unicode names, 8 digits, SHA256 and HOTP all survive encode → decode', async () => {
  const accts = Array.from({ length: 25 }, (_, i) => ({ type: i % 7 === 0 ? 'hotp' : 'totp', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PX' + 'ABCDEFGH'[i % 8], issuer: i === 3 ? 'Bänk ✓' : 'Site ' + i, account: `user${i}@例え.jp`, digits: i % 5 === 0 ? 8 : 6, algorithm: i % 4 === 0 ? 'SHA256' : 'SHA1', period: 30, ...(i % 7 === 0 ? { counter: i } : {}) }));
  const r = decodeMigration(encodeMigration(accts, { batchSize: 2, batchIndex: 1, batchId: 42 }));
  assert.equal(r.accounts.length, 25);
  assert.equal(r.batchSize, 2); assert.equal(r.batchIndex, 1); assert.equal(r.batchId, 42);
  for (let i = 0; i < 25; i++) {
    const a = r.accounts[i], b = accts[i];
    assert.equal(a.issuer, b.issuer); assert.equal(a.account, b.account); assert.equal(a.digits, b.digits); assert.equal(a.algorithm, b.algorithm); assert.equal(a.type, b.type);
    assert.equal(await totp(base32Decode(a.secret), { now: 1e12 }), await totp(base32Decode(b.secret), { now: 1e12 }), 'same codes after transfer');
  }
});

test('garbage export codes fail cleanly', () => {
  assert.throws(() => decodeMigration('otpauth-migration://offline?data=%%%'));
  assert.throws(() => decodeMigration('otpauth-migration://offline?data=CjE'), /Truncated|Bad/);
  assert.ok(!isMigrationUri('otpauth://totp/x?secret=AAAA'));
});

test('AUDIT L3: a malformed account is skipped, the rest of the batch still imports', () => {
  // field 1 (secret) sent as a varint instead of bytes in the first account
  const badAcct = [0x08, 0x05]; // field 1 varint
  const good = decodeMigration(encodeMigration([{ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', issuer: 'Good', account: 'g' }]));
  const goodUri = encodeMigration([{ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', issuer: 'Good', account: 'g' }]);
  const raw = Uint8Array.from(atob(decodeURIComponent(goodUri.split('data=')[1])), (c) => c.charCodeAt(0));
  const mixed = new Uint8Array([0x0a, badAcct.length, ...badAcct, ...raw]);
  let s = ''; for (const b of mixed) s += String.fromCharCode(b);
  const r = decodeMigration('otpauth-migration://offline?data=' + encodeURIComponent(btoa(s)));
  assert.equal(r.accounts.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(good.accounts[0].issuer, 'Good');
});
