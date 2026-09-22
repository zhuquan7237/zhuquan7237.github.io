# vendor/

`qrcode.cjs` is the MIT-licensed **QR Code Generator for JavaScript**
(Copyright (c) 2009 Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator),
copied verbatim from the `qrcode-generator` package's `dist/qrcode.js`.

It is vendored on purpose: the mobile bridge ships inside the desktop app and must
not add a runtime dependency to the engine's installation. `src/qr.ts` loads it
through `createRequire`, and the desktop shell uses the same library for its own
card so both render the identical QR for a given pairing link.
