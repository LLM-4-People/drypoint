# Third-party notices

This project ships two pieces of third-party work. Both are MIT-licensed, and
both keep their attribution next to the code or data they belong to.

## QR Code Generator for JavaScript

- **File:** `src/vendor/qrcode.js`
- **Copyright (c) 2009 Kazuhiko Arase**
- **URL:** <http://www.d-project.com/>
- **Licence:** MIT — <http://www.opensource.org/licenses/mit-license.php>

The file is vendored unchanged and loaded as a classic script before the app
modules. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Code 128 symbol table

- **File:** `test/fixtures/code128-patterns.json` (test fixture only; the
  patterns themselves are a published standard and the app compiles them into
  `src/label/barcode.js`)
- **Source:** JsBarcode 3.12.3, `src/barcodes/CODE128/constants.js`
- **URL:** <https://github.com/lindell/JsBarcode>
- **Licence:** MIT

Only the data table is included, normalised to one string per symbol. The
fixture carries its own attribution and retrieval date, and
`test/code128-table.test.mjs` pins the project table to it.

## Trademarks

NIIMBOT and the NIIMBOT model names (D110, D110_M, D11, D11_H, D11S, D11_Pro,
B1, B1 Pro, B1 SE, B2, B2 Pro, B21, B21S, B21 Pro) are trademarks of their
owner. They are used here only to describe hardware compatibility.

This project is not affiliated with, authorised by, endorsed by, or supported
by NIIMBOT or any printer manufacturer. It is an independent, unofficial
client. Printer firmware, label stock and model availability are the
manufacturer's responsibility; nothing here is a statement about a device's
warranty or its intended use.
