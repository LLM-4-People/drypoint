# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version number follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`package.json` is the one owner of that number: a release tag must be exactly
`v<version>` and its notes are copied from the matching section below.

## [1.0.1] - 2026-11-16

### Changed

- **The release signing identity is new.** v1.0.0 was signed with a key that
  was retired before any public install; v1.0.1 is signed by the key whose
  fingerprint is recorded in `brand.json`. Android treats a different key as a
  different app, so uninstall v1.0.0 before installing this build.
- Pages deploys only after the `Checks` run for the same commit succeeds, and
  its smoke test now requests every precached file instead of four.
- The APK is byte-reproducible: generated ZIP entries carry a fixed timestamp,
  and the signing block is the only part a rebuild cannot reproduce.
- Documentation was corrected against the code: refusal wording, LAN binding,
  browser support, dpi class versus capability value, ownership and limits.

### Fixed

- Every mutating printer command is gated, not only printing. Unsupported and
  unknown models are refused with **zero frames**; a sensor refusal reads one
  heartbeat and prints nothing. Self-test on an experimental model asks first.
- Undo history is bounded by bytes (32 MiB), so image edits cannot retain
  hundreds of megabytes.
- Image hydration reaches a fixed point above the 16-source cache, and the 17th
  distinct image is refused before insertion.
- Image import rejects oversized files before reading them.
- A hostile reported dpi can no longer allocate a giant canvas.
- The web manifest no longer claims the origin-root app identity, the PWA icons
  have transparent corners, and the service worker notifies only its own scope.
- The Android shell disables backup, enforces a CSP, rejects foreign hosts in
  the asset interceptor, and writes exports with `IS_PENDING`.
- The test suite is split by the real Chromium import, so only the browser job
  launches a browser.

## [1.0.0] - 2026-11-15

First public release: a static, offline editor and printer client for 12 mm
labels on the NIIMBOT D110 family, plus a self-signed Android app.

### Added

- The label editor: multi-line text with auto-fit, QR codes, Code 128 B
  barcodes, imported images with three dither modes, frames, layers, starter
  templates, undo/redo, drag/resize with snapping, zoom and keyboard nudging.
- Rendering at the printer's own dot resolution and a 1-bit raster, so what the
  stage shows is what the head prints.
- Web Serial over Bluetooth Classic SPP (desktop Chrome/Edge) and Web Bluetooth
  GATT (Chrome on Android) transports.
- An Android shell that adds the one API WebView lacks — a BLE GATT bridge —
  and serves the bundled app from a stable `https://drypoint.local` origin.
  Built without Gradle: `aapt2`, `javac`, `d8`, `zipalign`, `apksigner`.
- The offline worker: a generated precache manifest with one SHA-256 digest per
  file, a build stamp shared with `sw.js`, a staging cache promoted only after
  every file verifies, and a `precache-error` message the page shows.
- Roll profiles keyed by the RFID barcode, remembering label length and tape
  type per roll.
- A pinned printer-model table: `0x0910` (D110_M) is the tested reference,
  `0x0210` (D11_H) is experimental, every other known id is named and refused
  before a frame is sent.

### Changed

- Model identity comes from the reported model id. The print task
  (`D110M V4`) is a model fact, never a name derived from the protocol build.
- The print gate refuses an unsupported model by name, refuses an unknown model
  or a guessed head width, and asks for confirmation before an experimental
  model prints.
- Density and tape type mirror what the printer reports; an edit made while
  offline is replaced by the printer's stored value on the next connection.
- Discovery is one bounded, single-flight pass: a silent printer can no longer
  lock the manager, and two callers can no longer publish two models.

### Fixed

- A silent heartbeat no longer lets a print start: when the printer reported
  sensors but the job's own heartbeat goes unanswered, the print is refused
  instead of assuming the previous reading.
- A truncated `GetInfo` head-width reply is absent instead of a shifted
  `u16`, and an inverted capability range decodes as absent instead of a
  backwards range.
- A pre-cache install that fails — including a same-build reinstall — leaves
  the active cache and the running page untouched.
- A failed APK build leaves the previous stable and versioned APKs byte-for-byte
  intact; a failed publish restores the previous pair.

### Security

- Signing passwords reach `keytool` and `apksigner` through 0600 files that are
  deleted afterwards; no password ever appears in a process argument list.
- The Android build never invents a release key in CI: a missing keystore is a
  hard failure, and the local throwaway key is announced loudly.
- The service worker rejects a redirected precache response, a content type
  that contradicts the file extension, a missing digest and a digest mismatch.
- The dev server and the APK bundle both re-assert the one app-surface
  allowlist and resolve real paths, so a symlink cannot reach the keystore.
- Every GitHub Actions workflow pins each action to a commit SHA, declares
  explicit permissions and a timeout, and never persists checkout credentials.
- A privacy gate fails the build when a private host, an absolute home
  directory, the reference unit's serial or a non-fixture e-mail address
  reaches the published tree.
