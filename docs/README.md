# Documentation

Start with the question you have. The prose here is authored; the facts it
repeats are generated or contract-tested. The CI documentation gate
(`npm run docs:check`) proves every relative Markdown link or image, every
issue-template link into this repository and every heading anchor resolves.

| I want to… | Read |
| --- | --- |
| Use the app | [the README](../README.md) and its quick start |
| Know whether my printer works | [PRINTERS.md](PRINTERS.md) — the support matrix and the evidence behind it |
| Understand the wire protocol | [PROTOCOL.md](PROTOCOL.md) — frames, opcodes, reply fields, error codes |
| Understand the code | [ARCHITECTURE.md](ARCHITECTURE.md) — module map, data flow, document and capability models |
| Build or install the Android app | [ANDROID.md](ANDROID.md) — build, bridge contract, signing, platform limits |
| Work on the project | [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, tests, branch model, commit style |
| Report a security problem | [SECURITY.md](../SECURITY.md) — scope and the private reporting channel |
| Report a bug or ask a question | [SUPPORT.md](../SUPPORT.md) |
| See what changed | [CHANGELOG.md](../CHANGELOG.md) |
| Know the community rules | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |

## How this documentation is kept honest

- Protocol claims are contract-tested against the decoders: the reply field
  tables in `PROTOCOL.md` are parsed by `test/protocol-doc.test.mjs`, so a
  flipped bit or a renamed field fails the suite.
- The module map in `ARCHITECTURE.md` is compared with the real tree by
  `test/project.test.mjs`; a new script, source module or document that is not
  listed fails the build.
- The printer table in `PRINTERS.md` is compared with the one model table in
  `src/protocol/models.js`; an invented model name or a mismatched support state
  fails the build.
- Commands are contract-tested too: every `npm` script is documented in the
  README and every command named there exists in `package.json`.

There is no generated reference page, and the prose is not generated either.
The repeated facts have owners and gates: `scripts/build-brand.mjs` renders the
manifest, the Android strings, `src/core/brand.js`, `src/core/version.js` and the
icon's accessible name from `brand.json` and `package.json`;
`scripts/precache.mjs` renders the precache manifest and the worker's `BUILD`
stamp. The documents are authored, and contract tests pin them to their owners:
`test/project.test.mjs` compares the module map with the tree and the documented
`GetInfo` keys with the projection table, `test/docs.test.mjs` compares the
printer table with `src/protocol/models.js`, and `test/protocol-doc.test.mjs`
parses the five reply field tables it names and asserts every field against its
decoder. A pinned fact that drifts from its owner fails `npm run verify`.
