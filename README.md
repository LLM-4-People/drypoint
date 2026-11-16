# Drypoint

Design and print 12 mm labels on a **NIIMBOT D110-family** thermal printer —
in the browser, entirely offline, with no account, no server and no telemetry.

[![Checks](https://github.com/LLM-4-People/drypoint/actions/workflows/checks.yml/badge.svg)](https://github.com/LLM-4-People/drypoint/actions/workflows/checks.yml)

- **Live app:** <https://llm-4-people.github.io/drypoint/>
- **Android APK:** [latest release](https://github.com/LLM-4-People/drypoint/releases/latest)

Drypoint is not affiliated with NIIMBOT. It is an independent client for
hardware you already own; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Support matrix

| Model | Status | What that means |
| --- | --- | --- |
| **D110_M** | Tested | The reference unit: discovery, the print sequence and every fact below were captured from and verified on retail hardware. |
| **D11_H** | Experimental | Same protocol family, but the D110M V4 print sequence has not been verified on this model. The app asks for confirmation before it prints or runs the self-test. |
| Every other known NIIMBOT model | Not supported | The model is recognised and named; every command that writes to the printer is refused before a frame, while read-only diagnostics remain available. |
| Any model the printer reports outside the table | Unknown | Every write stays disabled: the app never guesses a model. |

The full table — ids, head widths, pitches, tape widths and what each model
would need — is in [docs/PRINTERS.md](docs/PRINTERS.md).

## Quick start

**In a browser.** Open <https://llm-4-people.github.io/drypoint/> in Chrome or
Edge 117+ on a desktop with Bluetooth, or in Chrome on Android where Web
Bluetooth is available. Pair the printer first (Windows: Settings → Bluetooth),
then use **Connect printer** in the header or the Print tab. The first load
registers the offline worker; after that a cold start with no connectivity
still edits and prints.

**As an Android app.** Download the APK from the
[latest release](https://github.com/LLM-4-People/drypoint/releases/latest),
allow "install unknown apps" for the file manager, and sideload it. The APK is
self-signed, needs Android 8 or newer, and asks for the Nearby-devices
permission when it scans. It needs no network and no server. Build and install
details: [docs/ANDROID.md](docs/ANDROID.md).

Safari and Firefox do not implement Web Serial or Web Bluetooth, so they can
view the app but cannot reach a printer.

## What it does

### Design

- **Text** — multi-line, automatic or fixed font size, bold, horizontal and
  vertical alignment, rotation 0/90/180/270.
- **QR code** — arbitrary text/URL, error correction L/M/Q/H, real 4-module
  quiet zone.
- **Code 128** — subset B (printable ASCII), optional human-readable text.
- **Image** — imported as a data URL, fit contain/cover/stretch, per-image
  dithering (crisp, Floyd–Steinberg, Atkinson) or the print setting.
- **Frame** — stroke width, filled or outline, corner radius.
- **Canvas** — drag and resize, snapping to the grid and label centres, optional
  grid and centre guides, zoom buttons / Ctrl+wheel / fit, keyboard nudging
  (1 px, Shift = 8 px), duplicate, delete, lock, hide, z-order, alignment
  controls, and undo/redo. Two fingers on a zoomed label pan the stage
  horizontally; a second touch cancels a pending drag, so the label never moves
  by accident.
- **Layers and templates** — reorder, lock and hide from the layer list;
  starter templates for text, name tag, QR, cable, framed and blank labels.
- **Document** — length in millimetres (20–200 mm, clamped to the device
  maximum), presets, and copies.

### Print

- Connect from the header pill or the Print tab; the header connects too, not
  just the panel. **Choose printer** always opens the printer picker, even when
  a printer is already saved. **Forget printer** asks for confirmation and
  clears a saved Android BLE selection; a browser serial-port permission belongs
  to the browser and can only be removed in its site settings.
- Live printer state: transport, model and its support state (tested,
  experimental or not supported), serial, firmware/hardware, the D110M V4 print
  task, head width and dpi, **Output: 1-bit monochrome**, battery, roll tag and
  remaining labels, lid and paper sensors. Values the printer did not report are
  labelled as assumed.
- Job settings: density, tape type, **Print quality** (Normal/Quality), copies.
- Maintenance: feed/align one label, printer self-test page, sync clock (hidden
  only when the printer reports no RTC), auto power-off, Bluetooth/power sounds
  (hidden only when the printer reports no volume support), reset printer
  settings.
- Diagnostics: paper-info and print-history replies (shown as raw bytes while
  their layout is unverified), log level, log viewer and JSON export.
- Print also needs a live connection and at least one visible element. Every
  command that writes to the printer — print, test print, self-test, feed,
  reset, clock, density, tape type, auto power-off and sound — is gated on a
  supplied model and a head width the printer actually reported. An
  unsupported or unknown model or a guessed head writes no frame at all; reads
  (identity, battery, sensors, roll and diagnostics) stay available. An
  experimental model asks for confirmation before it prints or runs the
  self-test. Lid, paper and battery are checked from the job's own fresh
  heartbeat, and each applies only when the printer reported it. A sensor
  refusal reads that heartbeat once, then stops without discovery and says
  nothing was printed. If the printer reported sensors but the heartbeat goes
  unanswered, the print is refused instead of assuming the previous reading is
  still true.
- Roll profiles: after a successful print the roll's RFID barcode remembers the
  label length and tape type, and reapplies them when that roll is seen again.

The design is stored locally; reopening the page keeps the label.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Enter` | Print |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + Y` | Redo |
| `Ctrl/Cmd + D` | Duplicate the selected element |
| `Delete` or `Backspace` | Delete the selected element |
| `Escape` | Clear the selection |
| `Arrow keys` | Nudge the selection 1 px |
| `Shift + Arrow keys` | Nudge the selection 8 px |

## Privacy

- **No network.** The only requests the app makes are for its own files from the
  host that served the page; it never calls a third-party service or an API. The
  only other network APIs it can reach are the ones the browser gives it to talk
  to the printer: Web Serial, Web Bluetooth, and — inside the Android app — a
  local BLE bridge. There is no analytics, no crash reporter, no remote logging
  and no update check.
- **No account.** Nothing to sign in to, nothing to sign up for.
- **Local storage only.** The label, settings, roll profiles and zoom live in
  the browser's `localStorage`. Diagnostics are generated on demand and
  downloaded as a file you own; they are never uploaded.
- **No secrets.** A repository privacy gate fails the build if a private host,
  a home directory, the reference unit's serial or a non-fixture e-mail address
  appears anywhere in the published tree.
- **The printer sees a bitmap.** The app sends the job as 1-bit rows after a
  short control handshake; it does not upload the label or read back its
  content.

See [SECURITY.md](SECURITY.md) for the threat model and the reporting channel.

## Offline behaviour

The first successful load registers `sw.js`, which imports the generated
`assets/precache.js` and caches every file in it:

- `index.html`, `assets/app.css`, `manifest.webmanifest` and every icon,
- `src/vendor/qrcode.js`,
- every ES module reachable from `src/main.js`,
- every local asset referenced by a stylesheet `url()` (`data:`, `http(s):` and
  fragment-only references are not files).

One allowlist owns that surface: `index.html`, `manifest.webmanifest`,
`assets/**` and `src/**`. The generator, the Android bundler and the dev server
all re-assert it, so the keystore, docs, scripts, tests and `package.json` can
never reach the offline cache, the APK or the served tree.

After that:

- **Precached URLs** are cache-first, so the first paint works with zero
  connectivity.
- **Navigations** are network-first and fall back to the cached `index.html`
  when the network fails or answers a non-OK status.
- **Other requests** are network-only and are never answered with the app shell.
- The cache name is the manifest's content hash; older `drypoint-*` caches are
  deleted on activate.
- `sw.js` carries the same hash as a generated `BUILD` stamp. Changing any
  precached file changes that stamp, so the worker bytes change and the browser
  installs a new worker even though the file list is generated.
- `assets/precache.js` also carries a SHA-256 digest per file. The worker hashes
  every staged body and refuses the install when the bytes differ or a digest is
  missing, so a host that serves a different file cannot poison the cache.
- The worker refuses to install when its stamp and the manifest disagree, when a
  file redirects, or when a response's content type contradicts its extension —
  including a known extension served with no `Content-Type` at all.

If a listed file is missing or the list is malformed, install fails loudly: the
service worker logs the problems and posts a `precache-error` message, which the
page shows as a toast and records in the diagnostics log. The worker fetches
into a staging cache and promotes it only when every file arrived, so a failed
install never writes into or deletes the cache being served — for a same-build
reinstall too.

A *torn pair* — a manifest and a worker from two different builds — is not an
error. The two are separate atomic writes, so a host or a cache can serve a
manifest newer than the worker; the worker then logs one informational line,
installs nothing and keeps the active cache and its page untouched, without a
toast or a `precache-error` message. The previous worker and cache simply stay
in place until the matching pair is fetched. `npm run check:precache` and
`test/precache.test.mjs` catch a stale list before it ships.

## How it is put together

```
brand.json                the authored product identity (name, slug, id, prefixes)
index.html                shell markup and module entry
manifest.webmanifest      PWA metadata and icons (GENERATED by scripts/build-brand.mjs)
sw.js                     offline worker (BUILD stamp + manifest import)
assets/app.css            layout, themes and components
assets/precache.js        GENERATED by scripts/precache.mjs
src/main.js               composition root
src/core/                 brand/version (GENERATED), config, DOM, geometry, logging, settings, store, offline status
src/protocol/             frames, commands, client, replies, models, session, errors
src/device/               manager, capabilities, print job/options, transports
src/label/                document model, render, raster, codes, images
src/editor/               controller, canvas, manipulation, image import, shortcuts
src/ui/                   inspector, layers, print panel, modals, controls, layout
src/vendor/qrcode.js      MIT QR generator
scripts/                  serve, stop, precache, brand, APK build, Pages, repository gates
test/                     node:test suites
docs/                     README.md, ARCHITECTURE.md, PROTOCOL.md, PRINTERS.md and ANDROID.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, data
flow, document model, capability model, storage keys, offline strategy and the
release process, and [docs/PROTOCOL.md](docs/PROTOCOL.md) for frames, opcodes,
reply fields, error codes and the D110M V4 print sequence.

### Print pipeline

```
document → renderDocument (native dots) → canvasToRaster (1-bit rows)
        → runPrintJob: Heartbeat → SetLabelType → SetDensity → PrintStart
        → PrintStatus → SetPageSize → rows (0x85/0x84) → PageEnd
        → poll PrintStatus until the page counter reaches copies → PrintEnd
```

Rows are run-length encoded: `0x85` carries a row plus a repeat count, `0x84`
collapses blank runs. A job that fails or is cancelled after `PrintStart` sends
exactly one `CancelPrint` instead of `PrintEnd`.

### Verified on the reference unit

Captured from a retail D110_M used for development and pinned by the test
suite. The unit's serial number is an identifier, so it is not published here;
the fixtures use clearly synthetic values.

| Fact | Value |
| --- | --- |
| Model | `0x0910` → D110_M (confirmed) |
| Head | 96 dots at the reported 200 dpi class → 7.87 dots/mm, 12.19 mm wide |
| Protocol build | 301 → D110M V4 print task |
| Max print height | 1600 px → 203 mm at 200 dpi (capped to the 200 mm app maximum) |
| Density / speed range | 1–5 / 1–5 |
| Roll tag | `6977031214406`, 192-label capacity; used/remaining are read from the tag |

The pitch is the reported resolution class divided by 25.4 — 203 dpi is
7.99 dots/mm and 300 dpi is 11.81 dots/mm — and the tape width is derived from
the head. Before a printer is discovered, or when its head width is unknown, the
app uses the configured fallback (203 dpi, 96 dots, 8 dots/mm), labels it as
assumed and keeps printing disabled.

## Development

The app has **no dependencies at all** — only `node:` built-ins. There is no
lockfile and no `npm install` step; `npm ci` does not apply. CI runs `npm test`
directly.

Requirements:

- **Node.js 22 or newer** for the scripts and the test runner (`.node-version`
  pins the version the project develops on). `import.meta.dirname` needs
  20.11+, and the suite relies on the modern `node --test` glob runner.
- **Chromium** for the three measured layout suites. The helper looks at
  `D110_CHROME`, then `CHROME_PATH`, then `google-chrome`/`chromium`/
  `chromium-browser` on `PATH`, then the Playwright browser cache. A missing
  browser skips those suites locally and **fails** them when `CI=true`.
- **JDK 21** (17 or newer works) for the Java filename test and the Android
  build.
- **Android SDK** with platform 34+ and build-tools (`aapt2`, `d8`, `zipalign`,
  `apksigner`), plus `python3`, to build the APK.

Commands:

```bash
npm start                        # dev server on http://127.0.0.1:8080
npm stop                         # stop the server tracked for that port
npm test                         # node --test "test/*.test.mjs"
npm run test:browser             # the three measured layout suites
npm run build                    # regenerate assets/precache.js and stamp sw.js
npm run check:precache           # fail if the generated offline file is stale
npm run build:brand -- --check   # fail if a generated brand file drifted
npm run build:android            # sideloadable APK in android/build/
npm run docs:check               # Markdown links, anchors and images resolve
npm run privacy:check            # no private host, path, serial or address
npm run workflows:check          # pinned actions, permissions, timeouts
npm run pages:build              # stage the deployment in _site/
npm run verify                   # brand + precache + privacy + tests + docs + workflows
```

`npm start` serves the app with Node's standard library only; there is nothing
to install. It binds to `127.0.0.1` and serves only the app surface — the files
in `assets/precache.js` plus `sw.js` — so the keystore, docs, scripts, tests and
`.run` are not reachable. Use `npm start -- --port 8081` to change the port, and
opt in to a LAN bind for a phone with `npm start -- --host 0.0.0.0`.

The dev server regenerates the offline manifest and worker stamp once, before
it starts listening. It is not a file watcher: after editing a precached file,
run `npm run build` (or restart the server) and reload the page. If the browser
keeps an older worker, reload once while online so the new one installs, or
clear the site data.

The product name, application id and storage/cache prefixes are authored once in
`brand.json`; the version is authored only in `package.json` and rendered into
`src/core/version.js`. After editing either file run
`node scripts/build-brand.mjs --write`.
Generated files are checked into the repository and verified byte-for-byte by
`--check` in CI, so never edit one by hand.

### Android app

`npm run build:android` packages the same web app in a small native shell and
signs a sideloadable APK (`android/build/drypoint.apk`). The shell adds the one
API WebView lacks — a BLE GATT bridge — and serves the bundled assets from a
stable `https://drypoint.local` origin, so the editor, storage and print
pipeline are identical. It needs no internet and no server.

Running it needs Android 8+ and the Nearby-devices permission; the APK is
self-signed, so install it by sideloading. See
[docs/ANDROID.md](docs/ANDROID.md) for build, install, signing and limits.

For phone testing without HTTPS:

```bash
adb reverse tcp:8080 tcp:8080    # phone's localhost:8080 → this machine
# open http://localhost:8080 on the phone
```

Or put any TLS terminator in front of `npm start`.

## Storage keys

| Key | Contents |
| --- | --- |
| `drypoint.document` | the current label document (`version: 4`) |
| `drypoint.settings` | user settings, validated and coerced on load |
| `drypoint.rolls` | roll profiles keyed by RFID barcode (bounded to 64) |
| `drypoint.zoom` | the last canvas zoom |

The prefixes belong to a new install: there is no migration from the
pre-release name and no compatibility key.

Settings drop unknown keys and clamp invalid values on load; roll profiles are
sanitised when written and bounded to 64 entries. A storage read or write
failure is logged through the diagnostics logger; the app keeps working in
memory.

## Limitations

- **12 mm printable width.** Long text or a wide barcode can overflow; the stage
  hint warns and the print flow asks before printing anyway.
- **Length is a setting, not a measurement.** It is remembered per roll, but if
  prints drift across the gap, set the length to match the tape.
- **Code 128 B only** (printable ASCII 32–126). QR handles arbitrary text.
- **Web Serial is desktop Chrome/Edge; Web Bluetooth is Chrome on Android.**
  Safari and Firefox cannot connect a printer.
- **BLE writes are paced at ~12 ms**, so a 40 mm label takes a few seconds.
- **Paper info (`0x69`), print history (`0x62`) and the print area (`0x0F`)
  layouts are unverified.** They are exposed as raw bytes rather than guessed
  fields.
- **Density and tape type always come from the printer.** Discovery mirrors the
  values stored in the printer, so an edit made while offline is overwritten on
  the next connection. Change them while connected (or on the printer itself);
  the next job uses the printer's stored values.
- **One document at a time.** There is no multi-label library or cloud sync;
  images are embedded as data URLs, which count against the browser's
  localStorage quota.
- **Two open tabs are last-writer-wins.** Each tab saves its own label; the last
  tab to write — or to close while dirty — replaces the other. There is no merge
  and no revision envelope, so finish in one tab before editing in another.

## Troubleshooting

- **“Failed to open serial port”** — another tab or program holds the printer.
  Close it and connect again.
- **The chooser is empty** — the printer is not paired, or Windows assigned no
  SPP port. Re-pair it in Settings → Bluetooth.
- **“Port 8080 is already in use”** — run `npm stop` (or `node
  scripts/stop.mjs --port 8080`), or start on another port with `PORT=8081 npm
  start`. A tracked server is recorded in `.run/server-<port>.pid`.
- **Offline reload fails** — run `npm run build`, then `npm run
  check:precache`, and reload once while online so the new worker installs.
  Check the console for `precache-error` details.
- **Printer stops mid-job** — check the tape and lid; the status line and
  diagnostics log report the printer's error code.

## Documentation

| Document | What it answers |
| --- | --- |
| [docs/README.md](docs/README.md) | the documentation index: task → page |
| [docs/PRINTERS.md](docs/PRINTERS.md) | which models work, the evidence, and what a new model needs |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | frames, opcodes, reply fields, error codes, verified facts |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | module map, data flow, document and capability models, offline and release |
| [docs/ANDROID.md](docs/ANDROID.md) | APK build, bridge contract, signing and platform limits |
| [CONTRIBUTING.md](CONTRIBUTING.md) | setup, tests, branch model, commit style, printer reports |
| [SECURITY.md](SECURITY.md) | threat model, supported versions, private reporting |
| [SUPPORT.md](SUPPORT.md) | where to ask, what to include, response expectations |
| [CHANGELOG.md](CHANGELOG.md) | what changed in each release |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | the community standard |

## Contributing and security

Contributions are welcome: short-lived branch, pull request, `main`. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately
through GitHub's security advisories — see [SECURITY.md](SECURITY.md) — and
never paste a printer serial, a home path or a log with either into an issue.

## License

MIT — see [LICENSE](LICENSE). Bundled third-party work and its attribution:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
