# Drypoint Android app

The Android build wraps the same web app in a small native shell so it installs
as an APK, works with no internet, and prints over Bluetooth LE. The printer
firmware is untouched.

```
WebView (https://drypoint.local)
  └── bundled web app (the APK's assets/www, staged from assets/precache.js
      for that build only)
  └── NiimbotBLE bridge (Java)
        scan → connect → GATT notify → chunked writes
```

## Why a shell is needed

Android WebView does not implement Web Bluetooth. The shell provides exactly the
one host API the app needs — a GATT client — and leaves every protocol decision
(ports, frames, rasterisation, retries) in the web code. The transport lives in
`src/device/transports/android.js` and implements the same contract as the
serial and BLE transports, so the device manager, session and print job are
unchanged.

## Build

Requirements:

- JDK 17 or newer (`javac`, `keytool`)
- Android SDK with a platform (34+) and build-tools (`aapt2`, `d8`, `zipalign`,
  `apksigner`); `ANDROID_HOME` or `~/Android/Sdk`
- `python3` (only to add `classes.dex` to the APK archive)

```bash
npm run build:android
```

The script:

1. regenerates the precache manifest (`scripts/precache.mjs --write`);
2. creates a scratch directory (`android/build-XXXXXX`) and stages exactly the
   manifest's files under its `assets/www`, plus `LICENSE` and
   `THIRD_PARTY_NOTICES.md` from the one distribution list
   (`scripts/lib/distribution.mjs`), re-asserting the generator's app-surface
   allowlist; that fresh assets root is what `aapt2 -A` packages, so nothing
   else in the source tree can ride along;
3. compiles the resources with PNG crunching off (`--no-crunch`, so the launcher
   drawable is byte-for-byte `assets/icon-192.png`) and links them with the
   manifest inside the scratch directory;
4. compiles the Java sources, dexes them, and appends `classes.dex` through an
   explicit `ZipInfo` with the fixed 1980-01-01 timestamp;
5. aligns and signs with `android/keystore/drypoint-release.jks`, using exactly
   the signature schemes the manifest's `minSdkVersion` needs;
6. compares the signing certificate with
   `brand.json.androidSigningCertificateSha256` and refuses to publish a
   mismatch;
7. verifies the staged APK, stages and verifies both published names, then
   renames the versioned and stable copies into `android/build/` as one
   transaction: a failure restores the previous pair byte-for-byte;
8. removes the scratch directory in a `finally` — a refusal throws instead of
   calling `process.exit`, so a failed build leaves no `android/build-*` tree.

Output: `android/build/drypoint-<version>.apk` (and, only after the signature
verified, a stable copy at `android/build/drypoint.apk`). The
build never deletes `android/build/` before it has a verified replacement, so a
failed build (javac, d8, apksigner, a full disk) leaves the previous stable and
versioned APKs exactly as they were.

There is no Gradle or Maven dependency. The build also fails if a manifest entry
is missing or is outside the app surface (keystore, docs, tests, scripts,
`package.json`).

The release identity is `android/keystore/drypoint-release.jks`, alias
`drypoint`, with the certificate `CN=Drypoint, O=LLM-4-People, C=CA`.
`android/keystore/` is excluded from version control: **back it up securely**.
Android only installs an update over an existing app when it is signed by the
same key, so losing it means uninstalling before reinstalling.

`ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEYSTORE_KEY_PASSWORD` and `ANDROID_KEY_ALIAS` override the local
`android/keystore/keystore.properties` (environment first). A local build with
neither still generates a password and a throwaway key, and says loudly that it
did. In CI (`CI=true`) or with `--require-key`, a missing keystore is a hard
failure: the build never invents a release key.

The password reaches `keytool` and `apksigner` through a 0600 temporary file
(`-storepass:file`, `--ks-pass file:`), never as a command-line argument, and
that file is deleted in a `finally`. `android/keystore/` is created 0700 before
anything is written, and a generated keystore is created under `umask 077` and
renamed into place 0600, so the key is never readable by another local user —
not even in the first instant of its existence.

## The signing certificate is pinned

`brand.json.androidSigningCertificateSha256` holds the SHA-256 of the release
certificate, the exact value `apksigner verify --print-certs` prints. After
signing, the build compares the APK's certificate with that field and refuses to
publish anything on a mismatch. The pin is on by default; there are exactly two
declared exceptions, and both say so in the build log:

- a key the build just generated cannot be the release key;
- `CI` sets `ANDROID_ALLOW_TEST_KEY=1`, which the pull-request gate does because
  it proves the toolchain with a throwaway key and publishes nothing. The
  release workflow never sets it.

## Signature schemes and reproducible bytes

`minSdkVersion` (26) is the one owner of the scheme choice. API 24 and later
verify the APK Signature Scheme v2, so `apksigner` signs with v2 + v3 and
`--v1-signing-enabled false`: the JAR (v1) signature would add
`META-INF/MANIFEST.MF`, `META-INF/DRYPOINT.SF` and `META-INF/DRYPOINT.RSA`
stamped with the wall clock, and the same tree would produce a different APK on
every build. Below API 24 the build re-enables v1, because it is required there.

Together with the fixed `classes.dex` entry timestamp and `aapt2 --no-crunch`,
two builds of the same tree are byte-identical: `sha256sum` of
`android/build/drypoint-1.0.0.apk` is the same after every run. What cannot be
pinned is the APK Signing Block itself — the v2/v3 digests and signatures
`apksigner` writes between the zip entries and the central directory. For one
fixed key and one `apksigner` build it is deterministic (RSA PKCS#1 v1.5 has no
random salt and apksigner adds no signing time), but its bytes belong to the
signing tool and change if that tool's scheme version changes.

Changing the signing key costs one uninstall: Android refuses to replace an app
signed by a different key, so the first install after a key change needs the old
copy removed (`adb uninstall dev.llm4people.drypoint` or the system
uninstall). Later updates install normally with the new key.

## Web assets

The APK's `assets/www` is staged from `assets/precache.js` into the build's own
scratch directory and is never hand-edited; nothing is copied into the source
tree. Each manifest entry carries a SHA-256 digest of the file
bytes; `sw.js` verifies every staged body before caching, `npm run
check:precache` recomputes the digests and fails when a listed file changed, and
`test/precache.test.mjs` re-hashes every file on disk. The APK bundles exactly
that list; run `npm run check:precache` and `npm test` before packaging to catch
a stale or tampered asset. The build also re-asserts the app-surface allowlist
for every entry (`index.html`, `manifest.webmanifest`, `assets/**`, `src/**`), so
keystore, docs, tests and scripts cannot enter the APK.

## Install

1. Copy the APK to the phone (USB, cloud drive, or `adb install`).
2. Allow "install unknown apps" for the file manager when prompted.
3. Open the app and grant the Nearby devices permission when it scans.
4. Print tab → Connect printer (or the header pill) → pick `D110…` from the
   native list.

The Print panel has three printer actions: **Connect printer** reconnects to the
saved printer (or asks once when none is saved), **Choose printer** always opens
the native scan list and replaces the saved choice, and **Forget printer**
clears the saved BLE selection after a confirmation, so the next connection asks
again.

`adb install -r android/build/drypoint.apk` works for updates signed
with the same key.

## Bridge contract

`src/device/transports/android.js` owns the connection bridge;
`src/core/dom.js` (`downloadJson`) is the only `saveFile` caller, used by the
diagnostics export. `BleBridge.java` is the only implementation. Both sides own
half of every rule, and neither guesses:

| Concern | Web side | Java side |
| --- | --- | --- |
| A call that never answers | every call has `CONFIG.transport.androidCallTimeoutMs` (15 s) and rejects | a destroyed bridge answers `{ok:false}` immediately |
| Closing | `close()` rejects every pending call and clears its timer | `disconnect()` drops the GATT link |
| Connect handshake | `open()` awaits the `connect` reply | resolves after the notification descriptor is written **and** the MTU exchange finished, or after a 300 ms fallback |
| Write pacing | the session serialises requests | each chunk waits for its ack; a 2 s missing ack closes the link with "Printer stopped acknowledging writes" |
| Chunk size | — | `min(MTU − 3, 512)`, and the MTU resets to 23 on connect and on close |
| Teardown | a late native event is ignored after close() | `destroy()` clears the main-looper queue, dismisses the picker, stops the scan and never calls a destroyed WebView |
| Forgetting the printer | `AndroidTransport.forget()` reports `false` on an older bridge | `forgetDevice()` removes `lastDevice`; a browser port permission is not revocable by page script |
| System bars | `applyTheme` sends the `--bg` token it just applied | `setSystemBars(hex)` colours the status and navigation bars; a malformed value is ignored |

The connect call is the one that matters most: an Android GATT connect that
ends in `STATE_DISCONNECTED` (or with a non-success status) settles that call
with `Bluetooth connection failed (status N)`, so the app shows the real cause
instead of staying on "Connecting…" until it reloads. The Java side clears the
connection token on every settle, so a late callback cannot resolve a second
time.

## How the web app is hosted

`MainActivity` intercepts requests for `https://drypoint.local` and serves them from
`assets/www`. A stable https origin is what makes ES modules, `localStorage` and
the normal code paths work; no HTTP server, port or cleartext traffic is
involved. The service worker is skipped in the shell because the assets are
already on disk (and a stale worker cache would survive an APK update).

`MainActivity.isAppUrl` is the one definition of "the app": an `https` URL on the
one host. Everything else is refused rather than released to the platform:

- `shouldInterceptRequest` answers **403 Forbidden** for a request that is not
  the app. It used to return `null`, which let the WebView resolve that request
  over the network and made the shell's offline guarantee depend on the absent
  `INTERNET` permission.
- `shouldOverrideUrlLoading` returns `true` for any navigation that leaves the
  origin, so a link cannot hand the page to a browser or another app.

The manifest declares no `INTERNET` permission, no `provider`, `service` or
`receiver`, and `android:exported="true"` only on the launcher activity.
`android:allowBackup="false"`: the label documents, the layout state and the
paired printer's Bluetooth address are never copied into a cloud or
device-to-device backup.

`index.html` carries a Content-Security-Policy meta element —
`default-src 'self'; img-src 'self' data: blob:; style-src 'self'
'unsafe-inline'; script-src 'self'` — with no inline script. It applies equally
to the Pages deployment and to the WebView, because both serve the same
document. `data:` and `blob:` are allowed for images only: the editor renders
canvas and object URLs it creates itself.

## Platform notes

- **BLE only.** Android's Web Serial cannot reach Bluetooth Classic SPP, so the
  printer must be the BLE model path (D110_M exposes the GATT service used here).
- **Android 12+**: scanning asks for Nearby devices (`BLUETOOTH_SCAN` with
  `neverForLocation`); older versions ask for location, which Android requires
  for BLE scans.
- **One host at a time.** The printer accepts a single connection; disconnect on
  the other device before connecting here.
- **No Play Store.** The APK is self-signed and sideloaded. Distribution is the
  APK file itself.
- **Minimum Android 8 (API 26)** with a current WebView.

## Export and images

- Diagnostics export uses the native bridge (`saveFile`), which writes to
  Downloads on Android 10+ and to the app's external Downloads directory on
  older versions. The bridge accepts only a single filename segment (no empty
  name, separators, NUL, `.` or `..`) and canonicalises the legacy target under
  the Downloads directory before writing.
- On Android 10+ the row is inserted with `IS_PENDING=1`, so the Files app never
  shows a half-written export; the flag is cleared only after the bytes are
  written, and a failed write deletes the pending row again. A display name that
  Downloads already holds is refused before the insert, because MediaStore would
  otherwise silently rename the new file to `name (1).json`.
- Image import uses the system file picker exposed by the shell.

`LICENSE` and `THIRD_PARTY_NOTICES.md` are staged into `assets/www` from the same
list the site uses (`scripts/lib/distribution.mjs`), so both distributions carry
the same notices.

## Troubleshooting

- **No printer in the list.** Grant Nearby devices, turn Bluetooth on, and keep
  the printer awake; scan again from the Print panel. Another host may already
  hold the single connection.
- **"does not expose its data service".** Pair the printer once in Android
  Settings → Bluetooth, then return to the app. Some units only publish the GATT
  service after bonding.
- **Install refused.** An existing copy signed with a different key must be
  uninstalled first; use the same `android/keystore/` for every update.
- **Blank page after an update.** The shell loads only bundled assets; if the
  page is blank, check that the APK contains `assets/www/index.html`
  (`unzip -l`), then reinstall.
- **"Printer stopped acknowledging writes".** The link stopped acking a GATT
  chunk for two seconds, so the app closed it rather than printing garbage or
  hanging. Turn the printer off and on, move it closer, and connect again.

## Verification limits

The JavaScript transport is covered by `test/android-transport.test.mjs`
(picker, connect frame, notifications, close, rejected writes, a bridge that
never answers, a close that rejects pending calls) and the native bridge
contract by `test/android-bridge.test.mjs` (ack watchdog, MTU reset and
handshake, token settling, teardown guards) plus `test/android-shell.test.mjs`
(method names, permissions, asset packaging). `SafeFileName` is compiled and
executed by `test/safe-filename.test.mjs`, so its rule is a runtime assertion,
not a source grep. The native GATT path itself needs a physical Android phone
and the printer; it cannot be exercised in CI or an emulator, so the GATT
behaviour is a source contract verified by `javac` in
`scripts/build-android.mjs`, not by execution.
