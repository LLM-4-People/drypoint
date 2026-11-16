# Documentation

Start with the question you have. The prose here is authored. Mechanical facts
that would otherwise drift are either rendered into marker blocks by
`scripts/build-docs.mjs` or pinned to their owner by a contract test; everything
else is prose and is reviewed as prose. The CI documentation gate
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
  `test/project.test.mjs`: every script, source module and Markdown document
  (the root `*.md` files and every page under `docs/`) must be listed, so a new
  document cannot appear without a map entry.
- The printer table in `PRINTERS.md` is compared with the one model table in
  `src/protocol/models.js`; an invented model name or a mismatched support state
  fails the build. The README support matrix and its id count, and SUPPORT's
  printer scope, are compared with the same table.
- `PROTOCOL.md` links the printer table instead of copying it;
  `test/docs.test.mjs` refuses a second model-id table on that page.
- The README storage-key table and the ARCHITECTURE storage-key table are
  compared with every `storageKey()` call under `src/`, so a key cannot be
  invented or left undocumented.
- The npm command table in `README.md` and the browser-suite list/count in
  `CONTRIBUTING.md` are rendered by `scripts/build-docs.mjs` from `package.json`
  and `scripts/test-suites.mjs`. A hand edit inside a
  `<!-- generated:… -->` block fails `scripts/build-docs.mjs --check` in
  `npm run verify`; regenerate with `npm run docs:generate`.

Most prose is not generated. The facts with a mechanical owner are:
`scripts/build-brand.mjs` renders the manifest, the Android strings,
`src/core/brand.js`, `src/core/version.js` and the icon's accessible name from
`brand.json` and `package.json`; `scripts/build-icons.mjs` rasterises that icon
into the manifest PNGs and checks their size, alpha and safe zone;
`scripts/precache.mjs` renders the precache
manifest and the worker's build and cache stamps; `scripts/build-docs.mjs`
renders the two marker blocks above. Contract tests pin the remaining repeated
facts: `test/project.test.mjs` compares the module map with the tree and the
documented `GetInfo` keys with the projection table, `test/docs.test.mjs`
compares the printer and support tables with `src/protocol/models.js` and the
storage tables with `storageKey()`, and `test/protocol-doc.test.mjs` parses the
five reply field tables it names and asserts every field against its decoder. A
pinned fact that drifts from its owner fails `npm run verify`. Prose that is
neither generated nor contract-tested is still authored text, not a generated
claim.
