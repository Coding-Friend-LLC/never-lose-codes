# Never Lose Codes

A Chrome extension for two-factor (2FA) login codes: encrypted on your computer, with backups you hold and a recovery key, so you never get locked out.

- **Install:** [Chrome Web Store](https://chromewebstore.google.com/detail/never-lose-codes-2fa-authenticator/ecgaclkdngecbiaifiiihhbpcheeeeaj)
- **Website and guides:** [codingfriendllc.com/never-lose-codes](https://codingfriendllc.com/never-lose-codes/)
- **Security design and review results:** [SECURITY.md](SECURITY.md)

This repository is the source of version 1.0.1 in the Chrome Web Store. The `ext/` folder matches the uploaded package file for file, except that two code comments were tidied in `ext/lib/license.js` and `ext/lib/crypto.js` (no code changed). You can compare it with the extension installed in your browser.

## What it can and can't touch

The extension asks for five permissions: `storage`, `unlimitedStorage`, `alarms`, `downloads` and `downloads.ui`. It has **no host permissions and no content scripts**, so it cannot read or change any web page you visit. It makes no network requests of its own. A Pro license key is checked offline against a public signature key in `ext/lib/license.js`.

## Run the tests

```
npm install
npm test
```

The tests use Node's built-in test runner, against the same modules the extension loads.

## Load it unpacked

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the `ext` folder.

## Third-party code

- `ext/vendor/jsQR.js`: jsQR 1.4.0 (Apache-2.0, see `jsQR-LICENSE.txt`)
- `ext/vendor/qrcode-generator.js`: qrcode-generator 1.4.4 (MIT, see `qrcode-generator-LICENSE.txt`)

Both are unmodified copies of the upstream releases.

## Reporting a problem

Email support@codingfriendllc.com. For security issues, see [SECURITY.md](SECURITY.md).

© 2026 Coding Friend LLC. See [LICENSE](LICENSE).
