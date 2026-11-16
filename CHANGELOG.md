# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and tags use the [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
`MAJOR.MINOR.PATCH` shape. The project's actual rule is narrower: patch releases
carry fixes and small, backward-compatible additions that do not change the
stored document format (1.0.2 added label export and import); a document-format
change or a user-visible redesign is a minor release. `package.json` is the one
owner of that number: a release tag must be exactly `v<version>` and its notes
are copied from the matching section below by `scripts/release-notes.mjs`.

## [1.0.3] - 2026-11-16

### Added

- The site publishes a generated social card and Open Graph and Twitter
  metadata, so a shared link previews the product instead of a bare URL.

### Fixed

- **Android label import now works.** The 1.0.2 APK filtered its system file
  picker to images, so **Document → Import label** could not select a label
  `.json` file. The picker now accepts JSON documents and the imported label is
  validated before it replaces the open one; the 1.0.2 release notes record
  that limitation for that build.
- **A deep in-scope navigation loads its assets.** The document now carries the
  deployment base, so opening a deep path serves the app shell with its modules
  and styles instead of 404s. The Pages deployment injects the shared base
  rule; the Android shell needs none because it always loads the root document.
- **The desktop layout keeps the action bar on screen.** The top bar, storage
  alert, workspace and action bar each own a grid row, so hiding the alert no
  longer pushes the workspace into the flexible row and the Print button below
  the viewport. The compact phone layout is unchanged.
- **An unreadable stored label is quarantined, not replaced.** A label whose
  stored value cannot be parsed is kept as raw bytes behind a banner; edits
  cannot overwrite it until the operator resets it, and Reset now asks first.
  A v3 label with no valid element list is quarantined; a v3 label whose
  geometry has to be bounded loads with a notice. Both report what changed.
- **A lost link is described honestly.** A disconnect after the page counter
  proved the copies, but before the printer confirmed the end of the job, says
  so instead of "may be incomplete"; a disconnect before that proof still says
  the label may be incomplete.
- **Malformed settings are reported and reset once.** A stored settings value
  that cannot be read as an object shows one notice and is replaced with clean
  defaults; a failed save still leaves the stored value untouched.
- **A deliberately chosen zoom survives a reload** up to the manual cap, while
  an automatic fit still clamps to the viewport.
- **Imported v3 labels say they were rotated.** A portrait v3 label converted
  to the landscape frame reports the rotation instead of silently moving its
  elements.
- **A hostile or oversized import is bounded before it is echoed.** The format
  name in an import error is a bounded, escaped excerpt, so a one-megabyte
  value cannot become a one-megabyte message.
- **The printer gate names the missing fact.** A printer that reports a
  resolution but no head width says the head width is missing, a printer that
  reports a head width but no usable resolution says the resolution is missing,
  and only a printer missing both gets the generic message.
- **Six more printer ids are named and refused.** B18, B18S, N1, H1, H1S and
  D101 are now in the model table with their scope, so an owned but unsupported
  printer is refused by name instead of falling through to an unknown id.
- **The raster width follows the head.** Rendering uses the printer's reported
  head width instead of assuming one 384-dot head, so a 192-dot or 576-dot head
  gets a correctly sized frame.
- **The compact shell paints in its final order.** The phone layout no longer
  shifts when the first script runs, and the sidebar keeps its landmark and
  accessible name in the accessibility tree.
- **The hidden page heading is inside the banner landmark**, so the page has one
  heading and no orphaned region.
- **The image source budget is one decision at every boundary.** Import,
  hydration and replacement all consult the same 16-source limit, and the undo
  history is bounded by an escape-exact byte estimate.
- **A file the deploy can lose now fails the smoke test.** The deployment smoke
  test requests every precached file, checks its content type against its
  extension, and fails when a `.js` file is served as HTML.

### Changed

- The service worker's content types are generated from one owner and stamped
  into `sw.js`, keeping the worker, the dev server, the browser harness and the
  Pages smoke test in agreement.
- The release workflow creates a throwaway signing key only in CI, signs the
  published APK with the release key in a separate job, binds the attestation to
  the resolved tag commit, and asserts the exact package, version code and
  version name before publishing.
- The workflow policy is now the one trusted gate: it rejects a release
  environment or secret outside the signing job, a masked aggregate command, a
  local action inside the trusted jobs, and any workflow file it does not own.
- Release notes are generated from their owners; the repeated documentation
  tables and marker blocks are generated or contract-tested against the code,
  while the prose is maintained.
- **The app is served at its custom domain root.** The Pages deployment now
  publishes at <https://drypoint.llm4people.dev/> instead of the repository
  subpath, and ships the `CNAME` file that keeps the domain bound across
  deployments.
- **The header title opens the repository.** The Drypoint wordmark is a link to
  <https://github.com/LLM-4-People/drypoint> in a new browser tab. In the
  Android shell it opens the same page in the browser, and every other
  external navigation stays refused.

## [1.0.2] - 2026-11-16

<!-- release-notes: the blockquote below is the top of the corrected v1.0.2 release body -->
> **Android 1.0.2 limitation (recorded 2026-11-16).** The APK's system file
> picker in this build is filtered to images, so **Document → Import label**
> cannot select a label `.json` file on Android. Label import works in the web
> app; it is fixed in 1.0.3.

### Added

- **Label export and import.** The Document panel saves the current label as
  one JSON file and loads it again in the web app; the 1.0.2 APK filters the
  picker to images (see the note above), so on Android this build can export but
  not import. This is the backup path a signing-key change or a device
  replacement needs; before this version only diagnostics could be exported.
- A model or geometry refusal is visible above the action bar, not only in a
  tooltip, so a disabled Print button names the unsupported model or guessed
  head on a phone. Printing, empty, offline and reading states explain
  themselves through the button label and title.

### Fixed

- Repainting a label hydrates a hidden image again when it is revealed, so it
  no longer stays "still loading".
- Replacing an image cannot push the document past the 16-source cap.
- Offline Print says "Connect the printer to print" instead of "Unknown model".
- The first offline install retries a transient network failure (still fails
  closed, never a partial cache); a 404 is never retried.
- The maskable icon is opaque, and the Apple touch icon uses the opaque file.
- A disconnect while preparing says nothing was printed; after the first frame
  it says the label may be incomplete. One toast, not two.
- A sensor refusal names the action that was refused — printing, feeding or
  advancing — instead of always saying nothing was printed.
- Android: the asset interceptor now lets the WebView handle `data:`, `blob:`
  and `about:` requests locally and answers 403 only for network schemes, so
  imported images cannot be blocked by the offline guard.
- The warning summary no longer counts or can be forged by its own "and N more"
  tail; a hostile reported dpi is bounded at the geometry choke point; an edit
  that truncates text reports it.
- The generated 404 page carries the standard generated-by header.
- `CONTRIBUTING.md` matches the unit/browser split, and the Android
  reproducibility example no longer names a past version.

### Changed

- **Upgrading from 1.0.0 still requires an uninstall, and its labels are lost.**
  1.0.0 was signed with a different key, so Android cannot upgrade it in place,
  and 1.0.0 has no label export. Uninstall it before installing this build; do
  not install 1.0.0 for new work. Use **Export label** before any future
  signing-key change or device replacement.
- Two builds of the same tree with the same signing key are byte-identical; a
  different key changes only the signing block.
- The workflow policy rejects quoted and job-level `write-all`, requires
  `--verify-tag` on the release command itself, and derives the aggregate check
  from every job in the workflow.
- Pages checks out `main` and asserts it equals the validated `Checks` commit,
  removing the untrusted-checkout pattern.
- The browser suite runs two Chromiums at once by default —
  `D110_BROWSER_CONCURRENCY` raises or lowers it — and its mount timeout honours
  `D110_CHROME_TIMEOUT_MS`.
- The release attaches its provenance bundle, prints the signing certificate
  fingerprint, and asserts the built APK's contents, permissions and backup
  setting. The Android manifest package comes from `brand.json`.
- Actionlint is downloaded at a pinned version and verified against a pinned
  SHA-256 instead of an action that fetches an unchecked binary.
- The redundant `Docs` workflow is removed; `Checks` already runs the docs and
  workflow-policy gates in every web leg.

## [1.0.1] - 2026-11-16

### Changed

- **The release signing identity is new.** v1.0.0 was signed with a key that
  was retired before any known install; the 1.0.0 APK had been downloaded.
  v1.0.1 is signed by the key whose fingerprint is recorded in `brand.json`.
  Android treats a different key as a different app, so uninstall v1.0.0 before
  installing this build.
- Pages deploys only after the `Checks` run for the same commit succeeds, and
  its smoke test now requests every precached file instead of four.
- The APK is byte-reproducible with the same key and `apksigner`: generated ZIP
  entries carry a fixed timestamp, and a different key changes only the signing
  block. The signing block's bytes belong to the signing tool, so a different
  `apksigner` version can change them.
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

<!-- release-notes: the published v1.0.1 body is left as published; this note supersedes it -->
> **Historical note (added 2026-11-16).** The published v1.0.1 release body says
> the v1.0.0 key "was retired before any public install" and that "the signing
> block is the only part a rebuild cannot reproduce". Both are superseded here:
> the 1.0.0 APK had been downloaded, and a rebuild with the same key and
> `apksigner` build is byte-identical. The published body is not edited; this
> changelog is the corrected record.

<!-- release-notes: no signing footer; the v1.0.1 body was published before the generated footer -->

## [1.0.0] - 2026-11-15

<!-- release-notes: the blockquote below is the published v1.0.0 release-page banner -->
> **Do not install this build for new work.** v1.0.0 is signed with a retired key and cannot be upgraded to v1.0.1; uninstalling it deletes every label, because this build has no project export. Use [v1.0.1](https://github.com/LLM-4-People/drypoint/releases/tag/v1.0.1) for a fresh install.

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

<!-- release-notes: no signing footer; the v1.0.0 body was published before the generated footer -->
<!-- release-notes: one trailing blank line; the published v1.0.0 body ended with it -->
