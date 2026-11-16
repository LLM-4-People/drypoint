# Contributing

Thanks for taking the time. This project has no dependencies, no build step for
the app and no framework, which keeps contributing unusually small: edit a file,
run the suite, open a pull request.

## Setup

```bash
git clone https://github.com/LLM-4-People/drypoint.git
cd drypoint
node --version        # 22 or newer; .node-version pins the development version
npm test              # nothing to install: only node: built-ins are used
npm start             # http://127.0.0.1:8080
```

There is no `npm install`: `package.json` has no dependencies and there is no
lockfile, so `npm ci` does not apply.

## What each test leg needs

| Leg | Needs | Without it |
| --- | --- | --- |
| Most of `npm test` | Node 22+ | — |
| The browser suites (listed below) | A Chromium binary | Skipped locally, **failed** when `CI=true` |
| `safe-filename` | A JDK (`javac`) | Skipped locally, **failed** when `CI=true` |
| `npm run build:android` | JDK 17+, Android SDK platform 34+ and build-tools, `python3` | Not run |

Chromium is discovered from `D110_CHROME`, then `CHROME_PATH`, then
`google-chrome`/`chromium`/`chromium-browser` on `PATH`, then the Playwright
browser cache.

<!-- generated:suites -->
The browser leg runs **8 tests in 7 files**:

- `actionbar-clearance.test.mjs` (1 test)
- `content-security.test.mjs` (2 tests)
- `document-transfer.test.mjs` (1 test)
- `image-hydration.test.mjs` (1 test)
- `layout-edges.test.mjs` (1 test)
- `stage-hint.test.mjs` (1 test)
- `toast-overlay.test.mjs` (1 test)
<!-- /generated:suites -->

`npm run test:browser` runs only that list.

## Commands

```bash
npm test                  # every test file; browser suites need Chromium
npm run test:unit         # the unit suite only
npm run test:browser      # only the measured browser suites listed above
npm run check:precache    # fail when the generated offline files are stale
npm run build:brand -- --check   # fail when a generated brand file drifted
npm run build:icons -- --check   # fail when a generated icon drifted
npm run docs:generate     # regenerate the marker blocks in README/CONTRIBUTING
npm run docs:check        # Markdown and issue-template links and anchors
npm run privacy:check     # private hosts, paths, serials, foreign e-mails
npm run workflows:check   # action pins, permissions, timeouts
npm run pages:build       # stage the static site in _site/
npm run verify            # the unit gate: brand, precache, privacy, unit, docs, workflows
npm run verify:all        # verify, then the browser suites
```

`npm run verify` is the **unit gate**, not everything CI does. `npm run
verify:all` adds the measured browser suites. CI also builds and signs the APK
and proves the build left no tracked or untracked file. Run `verify:all` before
you open a pull request when the change touches layout.

## Branch model

1. Branch from the current `main`: `fix/short-description` or
   `feature/short-description`.
2. Keep the branch short-lived; rebase or merge `main` if it drifts.
3. Open a pull request against `main`. Do not push to `main` directly.
4. The pull request needs the `required` check to pass. That aggregate job is
   the only required status check: it fails when any leg failed, was cancelled
   or was skipped.
5. A maintainer reviews and merges. The branch is deleted afterwards.

Releases are tagged from `main`; a tag must be exactly `v<package.json version>`.

## Commit style

- One cohesive change per commit, with a message that says what changed and why.
- Imperative subject line, at most ~72 characters; the body explains the
  mechanism and the evidence for a fix.
- Do not mix formatting or renaming into a behaviour change.
- Reference the issue in the body (`Fixes #123`) when there is one.

## Generated files — never edit by hand

These are generated and checked byte-for-byte in CI:

| Generated file | Owner | Regenerate with |
| --- | --- | --- |
| `manifest.webmanifest` | `brand.json` | `npm run build:brand -- --write` |
| `src/core/brand.js` | `brand.json` | `npm run build:brand -- --write` |
| `assets/icon.svg` | `brand.json` | `npm run build:brand -- --write` |
| `android/app/src/main/res/values/strings.xml` | `brand.json` | `npm run build:brand -- --write` |
| `assets/precache.js` | the real import graph | `npm run build` |
| the `BUILD` and cache-prefix stamps in `sw.js` | the precache hash and `brand.json` | `npm run build` |
| the `generated:scripts` block in `README.md` | `package.json` | `npm run docs:generate` |
| the `generated:suites` block in `CONTRIBUTING.md` | `scripts/test-suites.mjs` | `npm run docs:generate` |
| `_site/` | `collectFiles()` | `npm run pages:build` |

Edit the owner and regenerate. If a generated file changed and you did not touch
its owner, you found a bug — please say so in the pull request.

## Never commit secrets

- The release keystore, its `keystore.properties` and any `*.jks`, `*.keystore`,
  `*.p12`, `*.pem` or `*.key` file are ignored and must stay out of git.
- Do not paste a printer serial, a MAC address, a home directory or a full
  diagnostics export into a commit, a test fixture or an issue. The privacy gate
  (`npm run privacy:check`) fails the build when a private host, an absolute
  home directory, the reference unit's serial or a non-fixture e-mail address
  appears in the published tree.
- CI signs with a throwaway key generated in the job; a real release is signed
  from the repository secret. A pull request never sees that key.

## Printer models: the support policy

A printer model is supported only when it has been tested on real hardware —
with evidence, never a guess. There are three states, defined in
[docs/PRINTERS.md](docs/PRINTERS.md):

- **Tested** — discovery and printing were verified on retail hardware.
- **Experimental** — a known id in the same family, unverified print sequence;
  the app asks before printing.
- **Not supported** — a known id that this app will name and refuse.

An unknown id stays unknown. The print gate exists so a guess can never reach a
print head.

### Proposing a new model

Do not add an entry because a name looks similar. A pull request that adds or
promotes a model must include:

1. the id the printer reports, and the discovery transcript with serials
   removed;
2. the print sequence its firmware expects, captured from a real print;
3. a hardware test of discovery, one label, sensors and the roll tag;
4. the change in `src/protocol/models.js` and the matching row in
   [docs/PRINTERS.md](docs/PRINTERS.md), plus the test that pins the new id.

A change that only renames or re-labels an id, without evidence, will be
declined: a wrong print task can feed the wrong rows to a head.

## Documentation

Documentation is part of the change. If you add a script, a source module or a
document, add it to the module map in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — that map is contract-tested. If
you add an `npm` script, document it in the README — that list is contract-tested
too. `npm run docs:check` catches a broken relative link or anchor.

## Pull requests

Use the pull request template. It asks for the commands you actually ran, any
breaking change, and a short safety review: does the change touch the print
gate, the protocol decoders, the signing path or the app-surface allowlist? If
it does, say how you verified it.
