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
   manifest's files under its `assets/www`, re-asserting the generator's
   app-surface allowlist; that fresh assets root is what `aapt2 -A` packages, so
   nothing else in the source tree can ride along;
3. links resources and the manifest with `aapt2` inside the scratch directory;
4. compiles the Java sources, dexes them, adds `classes.dex`;
5. aligns and signs with `android/keystore/drypoint-release.jks`;
6. verifies the staged APK, stages and verifies both published names, then
   renames the versioned and stable copies into `android/build/` as one
   transaction: a failure restores the previous pair byte-for-byte;
7. removes the scratch directory in a `finally`.

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
that file is deleted in a `finally`. The generated keystore itself is `chmod
600`.

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
- Image import uses the system file picker exposed by the shell.

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
