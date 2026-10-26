// RFC 4226 (HOTP) and RFC 6238 (TOTP) official test vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, totp, base32Decode, base32Encode, parseOtpauth, toOtpauth } from '../ext/lib/otp.js';

const ascii = (s) => new TextEncoder().encode(s);

test('RFC 4226 HOTP vectors (counter 0..9)', async () => {
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let c = 0; c < 10; c++) assert.equal(await hotp(ascii('12345678901234567890'), c), want[c]);
});

test('RFC 6238 TOTP vectors, SHA1/SHA256/SHA512, 8 digits', async () => {
  const keys = { SHA1: ascii('12345678901234567890'), SHA256: ascii('12345678901234567890123456789012'), SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234') };
  const rows = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, s1, s256, s512] of rows) {
    assert.equal(await totp(keys.SHA1, { now: t * 1000, digits: 8, algorithm: 'SHA1' }), s1);
    assert.equal(await totp(keys.SHA256, { now: t * 1000, digits: 8, algorithm: 'SHA256' }), s256);
    assert.equal(await totp(keys.SHA512, { now: t * 1000, digits: 8, algorithm: 'SHA512' }), s512);
  }
});

test('base32 round trip and validation', () => {
  const b = ascii('12345678901234567890');
  assert.deepEqual(base32Decode(base32Encode(b)), b);
  assert.equal(base32Encode(b), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'), b, 'tolerates lowercase, spaces, dashes');
  assert.throws(() => base32Decode('ABC1'));
});

test('otpauth parse and build round trip', () => {
  const a = parseOtpauth('otpauth://totp/ACME%20Co:jane@acme.com?secret=GEZDGNBVGY3TQOJQ&issuer=ACME%20Co&digits=8&period=60&algorithm=SHA256');
  assert.equal(a.issuer, 'ACME Co'); assert.equal(a.account, 'jane@acme.com'); assert.equal(a.digits, 8); assert.equal(a.period, 60); assert.equal(a.algorithm, 'SHA256');
  assert.deepEqual(parseOtpauth(toOtpauth(a)), a);
  assert.throws(() => parseOtpauth('https://evil.com'));
  assert.throws(() => parseOtpauth('otpauth://totp/x?secret=NOT_BASE32!'));
});
