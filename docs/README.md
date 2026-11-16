# Documentation

Start with the question you have. Every page here is hand-authored; the CI
documentation gate (`npm run docs:check`) proves every relative link and heading
anchor resolves.

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

- Protocol claims are contract-tested against the decoders: the tables in
  `PROTOCOL.md` are parsed by `test/protocol-doc.test.mjs`, so a flipped bit or a
  renamed field fails the suite.
- The module map in `ARCHITECTURE.md` is compared with the real tree by
  `test/project.test.mjs`; a new script, source module or document that is not
  listed fails the build.
- The printer table in `PRINTERS.md` is compared with the one model table in
  `src/protocol/models.js`; an invented model name or a mismatched support state
  fails the build.
- Commands are contract-tested too: every `npm` script is documented in the
  README and every command named there exists in `package.json`.

There is no generated reference page in this repository: the module map, the
protocol tables and the support matrix are the authoritative documents, and the
tests keep them pinned to the code.
