# Drypoint

Design and print 12 mm labels on a **NIIMBOT D110-family** thermal printer:
in the browser, entirely offline, with no account, no server and no telemetry.

[![Checks](https://github.com/LLM-4-People/drypoint/actions/workflows/checks.yml/badge.svg)](https://github.com/LLM-4-People/drypoint/actions/workflows/checks.yml)

> **Do not install v1.0.0 for new work.** Its key was retired before any known
> install; the 1.0.0 APK had been downloaded. It cannot be upgraded in place to
> 1.0.1 or later, and has no label export, so uninstalling it deletes every
> label. Use the latest release.

- **Live app:** <https://drypoint.llm4people.dev/>
- **Android APK:** [latest release](https://github.com/LLM-4-People/drypoint/releases/latest)

Drypoint is not affiliated with NIIMBOT. It is an independent client for
hardware you already own; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Support matrix

| Model | Status | What that means |
| --- | --- | --- |
| **D110_M** | Tested | The reference unit: discovery, the print sequence and the facts in [Verified on the reference unit](#verified-on-the-reference-unit) were captured from and verified on retail hardware. Family-known opcode layouts and the reply maps marked unverified are documented but were not verified on it. |
| **D11_H** | Experimental | Same protocol family, but the D110M V4 print sequence has not been verified on this model. The app asks for confirmation before it prints or runs the self-test. |
| Every other id the app recognises | Not supported | The id is recognised and named in [docs/PRINTERS.md](docs/PRINTERS.md); every command that writes to the printer is refused before a frame, while read-only diagnostics remain available. The table names 21 ids; the vendor catalogue has more models, and an id outside the table is `Unknown` and blocked. |
| Any model the printer reports outside the table | Unknown | Every write stays disabled: the app never guesses a model. |

The table of every recognised id, the one measured head and what each model
would need before it could print is in [docs/PRINTERS.md](docs/PRINTERS.md).

## Quick start

**In a browser.** Open <https://drypoint.llm4people.dev/> in a browser
that exposes the printer API you need: Chrome or Edge on desktop, or Chrome on
Android (see [Browser support](#browser-support)). Pair the printer first
(Windows: Settings → Bluetooth), then use **Connect printer** in the header or
the Print tab. The first load registers the offline worker; after that a cold
start with no connectivity still edits and prints.

**As an Android app.** Download the APK from the
[latest release](https://github.com/LLM-4-People/drypoint/releases/latest),
allow "install unknown apps" for the file manager, and sideload it. The APK is
self-signed, needs Android 8 or newer, and asks for the Nearby-devices
permission on Android 12+ (location on Android 8-11) when it scans. It needs no
network and no server. Build and install details:
[docs/ANDROID.md](docs/ANDROID.md).

Safari implements neither device API, so it can view the app but cannot reach a
printer. Firefox 151+ exposes Web Serial, but this app's Bluetooth SPP filter is
unverified there. Chrome on desktop is the tested serial path; Edge exposes the
same Chromium APIs but was not hardware-tested.

### Browser support

Device APIs are the limit, not the editor. The version floors below come from
MDN's browser compatibility data (BCD), not from a guess; only the D110_M path
was tested on hardware.

| Capability | Chrome | Chrome Android | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- | --- |
| **Web Serial** | 89+ | 148+ (138-147 partial RFCOMM) | mirrors Chrome | 151+ | none |
| **Web Bluetooth** | 70+ | 56+ | mirrors Chrome | none | none |

- **Chromium on Linux** (Chrome and Edge) ships Web Bluetooth disabled by
  default; enable it in the browser if your distribution packages it.
- Edge is a Chromium mirror for these APIs. It was not hardware-tested with this
  printer, so treat it as "should work", not as a verified path.
- Firefox's Web Serial support is new and this app's Bluetooth SPP filter is
  unverified there. Safari implements neither API.

## Backup and upgrade

**Export a label.** Open **Document → Export label**. The web app downloads one
JSON file; the Android app writes the same file to Downloads through its native
bridge (on Android 8-9, the app's external Downloads directory). The filename
carries a timestamp, so exporting twice does not overwrite the first file.

**Import a label.** Open **Document → Import label**, pick the `.json` file, and
the label loads as one undoable step, with any shortening reported. Import works
in the web app and in the Android APK from 1.0.3. The 1.0.2 APK's file picker is
filtered to images, so its **Import label** cannot select the file: use the web
app or a 1.0.3+ APK instead.

The same document model and migration validate the import and the stored label.
One deliberate difference: the importer refuses a file whose image sources
exceed the authoring budget, while storage keeps an older over-budget label
intact rather than destroying it.

The file is the only backup outside this browser's storage, so export before
uninstalling, clearing site data or changing browsers. Export for a device
replacement or a future re-upgrade: a file exported by 1.0.2 can only be
imported by 1.0.2 or newer, so it cannot restore a label inside a downgraded
1.0.0 or 1.0.1 build (neither has an importer).

v1.0.0 has a different signing key and must be uninstalled before 1.0.1+. That
uninstall deletes the labels stored by 1.0.0, because 1.0.0 has no export. Do
not install 1.0.0 for new work.

## What it does

### Design

- **Text**: multi-line, automatic or fixed font size, bold, horizontal and
  vertical alignment, rotation 0/90/180/270.
- **QR code**: arbitrary text/URL, error correction L/M/Q/H, real 4-module
  quiet zone.
- **Code 128**: subset B (printable ASCII), optional human-readable text.
- **Image**: imported as a data URL, fit contain/cover/stretch, per-image
  dithering (crisp, Floyd-Steinberg, Atkinson) or the print setting.
- **Frame**: stroke width, filled or outline, corner radius.
- **Canvas**: drag and resize, snapping to the grid and label centres, optional
  grid and centre guides, zoom buttons / Ctrl+wheel / fit, keyboard nudging
  (1 px, Shift = 8 px), duplicate, delete, lock, hide, z-order, alignment
  controls, and undo/redo. Two fingers on a zoomed label pan the stage
  horizontally; a second touch cancels a pending drag, so the label never moves
  by accident.
- **Layers and templates**: reorder, lock and hide from the layer list;
  starter templates for text, name tag, QR, cable, framed and blank labels.
- **Export and import**: one JSON file per label, from the Document panel
  beside Templates. Import validates the format, bounds and document version,
  applies as one undoable step and reports any content it had to shorten.
- **Document**: length in millimetres (20-200 mm, clamped to the device
  maximum) and presets. Copies is a document field, but its only control is in
  the Print panel.

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
- Maintenance: **Feed / align paper**, printer self-test page, **Sync clock** (a
  "not supported" row when the printer reports no RTC).
- Device settings: auto power-off, Bluetooth and power sounds (a "not supported"
  hint when the printer reports no volume support).
- Device commands: read paper info and print history (shown as raw bytes while
  their layout is unverified), read capabilities, read device info, reset
  printer settings.
- Diagnostics: log level, log viewer and JSON export.
- Print also needs a live connection and at least one visible element. Every
  command that writes to the printer (print, test print, self-test, feed,
  reset, clock, density, tape type, auto power-off and sound) is gated on a
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
  to the printer: Web Serial, Web Bluetooth, and, inside the Android app, a
  local BLE bridge. There is no analytics, no crash reporter, no remote logging
  and no update check.
- **No account.** Nothing to sign in to, nothing to sign up for.
- **Local storage only.** The label, settings, roll profiles and zoom live in
  the browser's `localStorage`. Diagnostics are generated on demand and
  downloaded as a file you own; they are never uploaded.
- **No secrets.** A repository privacy gate fails the build if the published tree
  contains a private host name, an absolute home directory, an absolute
  browser-cache path, the reference unit's serial or an e-mail address outside
  the fixture domain.
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
- **Navigations** are network-first: the worker makes one same-origin request,
  waits at most `CONFIG.offline.navigationTimeoutMs` (3000 ms, stamped into the
  manifest), and falls back to the cached `index.html` when the network fails or
  answers a non-OK status. On a host that answers a missing path with a non-OK
  status (GitHub Pages and the dev server do), a controlled page therefore
  answers an in-scope deep link with the shell and a 200; the host's own 404
  page is seen only before the worker controls the page.
- **Other requests** are network-only and are never answered with the app shell.
- The cache name is the manifest's content hash; older `drypoint-*` caches are
  deleted on activate.
- `sw.js` carries the same hash as a generated `BUILD` stamp, and its cache
  prefix is stamped from `brand.json`. Changing any precached file changes the
  stamp, so the worker bytes change and the browser installs a new worker even
  though the file list is generated.
- `assets/precache.js` also carries a SHA-256 digest per file. The worker hashes
  every staged body and refuses the install when the bytes differ or a digest is
  missing, so a host that serves a different file cannot poison the cache.
- The worker refuses to install when its stamp and the manifest disagree, when a
  file redirects, or when a response's content type contradicts its extension,
  including a known extension served with no `Content-Type` at all.

If a listed file is missing or the list is malformed, install fails loudly: the
service worker logs the problems and posts a `precache-error` message, which the
page shows as a toast and records in the diagnostics log. A transient
network-level failure is retried twice per file with a short backoff; an HTTP
non-200, a redirect or a validation failure is never retried. The worker fetches
into a staging cache and promotes it only when every file arrived, so a failed
install never writes into or deletes the cache being served, even for a
same-build reinstall.

A *torn pair* (a manifest and a worker from two different builds) is not an
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
sw.js                     offline worker (BUILD/cache stamps + manifest import)
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
suite. The unit's serial number and Bluetooth address are identifiers, so they
are not published here; the fixtures use clearly synthetic values.

| Fact | Value |
| --- | --- |
| Model | `0x0910` → D110_M (confirmed) |
| Head | 96 dots at the capability TLV's reported 200 dpi → 7.87 dots/mm, 12.19 mm wide |
| Heartbeat resolution class | `0xDE` payload byte 6 is `2` → 203 dpi; the TLV's 200 dpi is the pitch the app uses |
| Protocol build | 301, reported by status data; it does not name the print task |
| Max print height | 1600 px → 203 mm at 200 dpi (capped to the 200 mm app maximum) |
| Density / speed range | 1-5 / 1-5 |
| Roll tag | `6977031214406`, 192-label capacity; used/remaining are read from the tag |

The pitch is the reported resolution divided by 25.4 (203 dpi is 7.99 dots/mm
and 300 dpi is 11.81 dots/mm), and the tape width is derived from the head. The
app prefers the capability TLV's dpi and falls back to the heartbeat's class
byte only when the TLV has no usable value. Before a printer is discovered, or
when its head width is unknown, the app uses the configured fallback (203 dpi,
96 dots, 8 dots/mm), labels it as assumed and keeps printing disabled.

## Development

The app has **no npm runtime dependencies**: it ships only `node:` built-ins.
One dev-only dependency, the ISC `yaml` parser, backs the workflow policy gate
and is installed with `npm ci`; `package-lock.json` is tracked so that install is
reproducible. CI runs `npm ci` before the gates that use it, then
`npm run test:unit`, `npm run test:browser` and the Android build, and proves the
tree is clean.

Requirements:

- **Node.js 22 or newer** for the scripts and the test runner (`.node-version`
  pins the version the project develops on). `import.meta.dirname` needs
  20.11+, and the suite relies on the modern `node --test` glob runner.
- **Chromium** for the measured browser suites. The helper looks at
  `D110_CHROME`, then `CHROME_PATH`, then `google-chrome`/`chromium`/
  `chromium-browser` on `PATH`, then the Playwright browser cache. A missing
  browser skips those suites locally and **fails** them when `CI=true`.
- **JDK 21** (17 or newer works) for the Java filename test and the Android
  build.
- **Android SDK** with platform 34+ and build-tools (`aapt2`, `d8`, `zipalign`,
  `apksigner`), plus `python3`, to build the APK.

Commands:

The table is generated from `package.json`; edit the script there and run
`npm run docs:generate`. The prose below the block explains the two gates.

[//]: # (generated:scripts)
| Command | Runs |
| --- | --- |
| `npm start` | `node scripts/serve.mjs` |
| `npm stop` | `node scripts/stop.mjs` |
| `npm run build` | `node scripts/precache.mjs --write` |
| `npm run check:precache` | `node scripts/precache.mjs --check` |
| `npm run build:brand` | `node scripts/build-brand.mjs` |
| `npm run build:icons` | `node scripts/build-icons.mjs` |
| `npm run build:social` | `node scripts/build-social.mjs` |
| `npm run build:android` | `node scripts/build-android.mjs` |
| `npm run pages:build` | `node scripts/build-pages.mjs` |
| `npm run docs:check` | `node scripts/check-docs.mjs` |
| `npm run docs:generate` | `node scripts/build-docs.mjs --write` |
| `npm run privacy:check` | `node scripts/check-privacy.mjs` |
| `npm run workflows:check` | `node scripts/check-workflows.mjs` |
| `npm test` | `node --test "test/*.test.mjs"` |
| `npm run test:browser` | `node scripts/test-suites.mjs browser` |
| `npm run verify` | `npm run build:brand -- --check && npm run build:icons -- --check && npm run build:social -- --check && npm run check:precache && npm run privacy:check && npm run test:unit && node scripts/build-docs.mjs --check && npm run docs:check && npm run workflows:check` |
| `npm run test:unit` | `node scripts/test-suites.mjs unit` |
| `npm run verify:all` | `npm run verify && npm run test:browser` |
[//]: # (/generated:scripts)

`npm run verify` is the **unit gate**: brand and precache drift, privacy, the
unit suite, generated documentation and link checks, and workflow policy.
`npm run verify:all` adds the measured browser suites. CI additionally builds
and signs the APK and proves that the build left no tracked or untracked change.

`npm start` serves the app with Node's standard library only; there is nothing
to install. It binds to `127.0.0.1` and serves only the app surface (the files
in `assets/precache.js` plus `sw.js`), so the keystore, docs, scripts, tests and
`.run` are not reachable. Use `npm start -- --port 8081` to change the port.
`npm start -- --host 0.0.0.0` serves the same surface on the LAN, which is
useful for viewing on a phone only: a `192.168.x.x` origin is not a secure
context, so Web Serial, Web Bluetooth and the service worker do not work there.

The dev server regenerates the offline manifest and worker stamp once, before
it starts listening. It is not a file watcher: after editing a precached file,
run `npm run build` (or restart the server) and reload the page. If the browser
keeps an older worker, reload once while online so the new one installs, or
clear the site data.

The product name, application id and storage/cache/CLI prefixes are declared in
`brand.json`; the version is declared only in `package.json`. Run
`node scripts/build-brand.mjs --write` after editing either file: it renders
`manifest.webmanifest`, `android/app/src/main/res/values/strings.xml`,
`src/core/brand.js`, `src/core/version.js` and the icon's accessible name.
`test/brand.test.mjs` proves the generated module mirrors `brand.json`, that the
manifest and `package.json` metadata agree with it, and that the hand-authored
`index.html` title, wordmark and README H1 name the same product. The Android
shell repeats the slug in its Java package path and `https://drypoint.local`
origin, so a rename edits those two literals by hand. Generated files are
checked into the repository and verified byte-for-byte by `--check` in CI, so
never edit one by hand.

### Android app

`npm run build:android` packages the same web app in a small native shell and
signs a sideloadable APK (`android/build/drypoint.apk`). The shell provides the
one connectivity API WebView lacks (a BLE GATT bridge) plus two small host
helpers (`saveFile` for the label export, the diagnostics report and the raw
copy of an unreadable stored label, and `setSystemBars` for the native theme
bars), and serves the bundled assets from a stable `https://drypoint.local`
origin, so the editor, storage and print pipeline are identical. It needs no
internet and no server.

Running it needs Android 8+; scanning asks for Nearby devices on Android 12+
and for location on Android 8-11. The APK is self-signed, so install it by
sideloading. See [docs/ANDROID.md](docs/ANDROID.md) for build, install, signing
and limits.

For printing or offline work on a phone without HTTPS, forward the port
instead; the phone's own `localhost` is a secure context:

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
- **Code 128 B only** (printable ASCII 32-126). QR handles arbitrary text.
- **Browser APIs decide.** Web Serial is tested on desktop Chrome. Edge mirrors
  the Chromium APIs but was not hardware-tested with this printer. Web Bluetooth
  is Chrome and Edge on desktop and Chrome on Android; Chromium on Linux ships
  Web Bluetooth disabled by default. Safari cannot connect a printer; Firefox's
  serial support is untested with this printer's Bluetooth SPP filter. See
  [Browser support](#browser-support).
- **BLE writes are paced at ~12 ms**, so a 40 mm label takes a few seconds.
- **Paper info (`0x69`), print history (`0x62`) and the print area (`0x0F`)
  layouts are unverified.** They are exposed as raw bytes rather than guessed
  fields.
- **Density and tape type come from the printer when `Read printer settings`
  is on**, which is the default: discovery mirrors the printer's stored values,
  so an edit made while offline is overwritten on the next connection. With the
  setting off, the app's stored values are used. Change them while connected
  (or on the printer itself) when the setting is on.
- **One document at a time.** There is no multi-label library or cloud sync;
  images are embedded as data URLs, which count against the browser's
  localStorage quota.
- **A maximum-size export is memory-heavy.** The transfer bound is about 65 MB
  of JSON (16 image sources plus envelope overhead), and the Android bridge
  marshals it as one string. On a low-RAM phone that can fail or run out of
  memory; export a smaller label or remove an image first. 1.0.3 has no chunked
  transfer.
- **Two open tabs are last-writer-wins.** Each tab saves its own label; the last
  tab to write (or to close while dirty) replaces the other. There is no merge
  and no revision envelope, so finish in one tab before editing in another.

## Troubleshooting

- **“Failed to open serial port”**: another tab or program holds the printer.
  Close it and connect again.
- **The chooser is empty**: the printer is not paired, or Windows assigned no
  SPP port. Re-pair it in Settings → Bluetooth.
- **“Port 8080 is already in use”**: run `npm stop` (or `node
  scripts/stop.mjs --port 8080`), or start on another port with `PORT=8081 npm
  start`. A tracked server is recorded in `.run/server-<port>.pid`.
- **Offline reload fails**: run `npm run build`, then `npm run
  check:precache`, and reload once while online so the new worker installs.
  Check the console for `precache-error` details.
- **Printer stops mid-job**: check the tape and lid; the status line and
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
through GitHub's security advisories (see [SECURITY.md](SECURITY.md)), and
never paste a printer serial, a home path or a log with either into an issue.

## License

MIT: see [LICENSE](LICENSE). Bundled third-party work and its attribution:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
