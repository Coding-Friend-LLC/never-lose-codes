# Security

This page explains how Never Lose Codes protects your 2FA secrets, what it does not protect against, and what two security reviews of the code found. It applies to version 1.0.1.

## How your codes are protected

- **Everything is encrypted on your computer.** A random AES-256-GCM vault key seals every account record, each with a fresh 96-bit IV. The record's id and kind are bound to it as additional authenticated data, so records can't be swapped or moved without detection.
- **The vault key is only stored wrapped (encrypted by another key):**
  - by a non-extractable device key kept in the browser, so the app opens without a password;
  - optionally, by your app password (PBKDF2-SHA256, 600,000 iterations, random salt). When you set a password, the device wrap is removed, so nothing opens without it;
  - always, by your **recovery key**: 26 characters (about 128 random bits), shown once at setup. You type its last 4 characters back to confirm you saved it.
- **Backups carry only the recovery-key wrap.** An encrypted backup file is written to your Downloads folder after every change. It opens on any computer with your recovery key, even if you forget your app password. It contains no readable account data.
- **Restoring only adds.** A backup can add accounts. It can't overwrite, roll back or delete what you already have.
- **Auto-lock removes the key, not just the screen.** When the time runs out, the unlocked vault key is erased from Chrome's session storage. A background alarm also erases it when no Never Lose Codes page is open, and on every start of the background worker.
- **No website access.** No host permissions and no content scripts. The extension can't read or change any page you visit, and it makes no network requests.
- **WebCrypto only.** All cryptography uses the browser's built-in `crypto.subtle`. There is no hand-written cipher code and no remote code. The page security policy is `script-src 'self'`.
- **Codes follow the standards.** RFC 4226 (HOTP) and RFC 6238 (TOTP), tested against the official test vectors.

## What it does not protect against

- **Malware on your computer**, or a browser extension with broad permissions that can read other extensions' pages. Nothing running in the same browser profile can fully defend against that.
- **Someone using your computer while the vault is unlocked.** Use an app password and a short auto-lock time if others can reach your computer.
- **A lost recovery key plus a lost app password.** We can't reset either one, because we never have them. This is by design.
- **Clipboard history.** A code you copy, or a text export, can be saved by your operating system's clipboard history. Text exports are cleared from the clipboard after 45 seconds, but OS history may keep a copy.
- **A short delay in auto-lock.** With no Never Lose Codes page open, Chrome can delay the background alarm, so the key may be erased up to about 30 seconds after the lock time.

## Security reviews

We have **not** had a paid human security audit. Instead, the code was checked by **two separate AI security reviews** (AI models reviewing the source independently of the AI that wrote it). We publish what they found and what we changed, so you can judge for yourself, and so you can check the code here.

### Review 1: before the 1.0.0 release (October 25, 2026)

No critical findings. Everything listed was fixed before release, each with a test.

| Severity | Finding | Fix |
|---|---|---|
| High | Setting an app password could leave the device-wrapped key in place, so a flag change could bypass the password | Setting a password now removes the device wrap and its key |
| Medium | Restoring a backup could overwrite, roll back or empty Trash using fields that weren't authenticated | Restore only adds accounts; an id clash becomes a copy |
| Medium | Editing an account could drop it from Trash handling, or save a damaged record | Edits keep Trash intact and refuse damaged records |
| Medium | Event numbering could restart after a damaged entry in the change journal | Numbering continues past damaged entries |
| Low | Account fields weren't fully validated when added | Validated at add |
| Low | Key files didn't limit their key-derivation settings | Iterations must be 600,000 to 5,000,000 |
| Low | Google Authenticator import didn't check every field's type | Per-field type checks; bad accounts are skipped, not fatal |
| Low | The self-test could report success too generously | Honest self-test, plus a recovery-key test |
| Low | Specially named ids (`__proto__`) were accepted | Rejected |

### Review 2: version 1.0.1 (October 26, 2026)

A fresh AI reviewer, with no part in writing the code, reviewed 1.0.1. No critical findings. Everything listed is fixed in 1.0.1, with 16 new unit tests and 9 new browser tests.

| Severity | Finding | Fix |
|---|---|---|
| High | Auto-lock locked the screen, but the unlocked vault key stayed in Chrome's session storage until Chrome closed. Someone at the computer with developer tools could reopen the vault | The key is erased at the lock time, by the open page, by a background alarm, and on every background start. An expired or tampered entry is deleted when read |
| Medium | A copied text export stayed on the clipboard | Cleared after 45 seconds, with a warning about OS clipboard history |
| Low | The toolbar popup didn't auto-lock itself | It auto-locks now too, and the full view locks at the exact time |
| Low | Decrypted account data stayed in page memory after locking | Cleared on lock |
| Low | Changing the auto-lock setting extended an open unlock | It never extends an existing unlock |
| Low | Accounts too long for a QR code failed silently | A clear message and a text link; setup keys over 256 characters are refused |
| Low | Drag-to-reorder could save duplicate positions in a filtered view | Positions are numbered against the whole list and saved in one step |

The fixes in review 2 have not yet had their own separate review.

### Vendored libraries

`jsQR` 1.4.0 and `qrcode-generator` 1.4.4 were checked byte for byte against their upstream releases.

## Tests

53 unit tests (`npm test`) cover the OTP standards, encryption, vault, backup and restore, Google Authenticator migration, Pro features, and every review finding above. A further 45 checks run the real extension in Chromium. They aren't in this repository, because they depend on our build machine.

## Reporting a vulnerability

Please email **support@codingfriendllc.com** with "Security" in the subject. Don't open a public issue for a security problem. We'll reply within 3 business days. We fix confirmed issues as fast as we can and credit you in the release notes if you'd like.
