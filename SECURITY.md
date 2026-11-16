# Security policy

## The boundary this app lives in

Drypoint is a static page and an Android WebView shell. It has no backend, no
server component and no cloud account. The security boundary is therefore the
browser sandbox, the printer link and the signing key — not a database or an
API.

**What the app can reach**

- **Web Serial** — a user-granted serial port, used for Bluetooth Classic SPP on
  desktop Chrome/Edge. The browser owns the permission.
- **Web Bluetooth** — a user-granted GATT device, used on Android Chrome.
- **The Android bridge** — inside the APK, a `JavascriptInterface` that exposes
  BLE scan/connect/write and one file save for diagnostics. It is reachable only
  from the bundled page at the app's own origin.
- **`localStorage`** — the label, settings, roll profiles and zoom.

**What it cannot do**

- No network request to a third-party service or API: no analytics, no
  telemetry, no crash reporting, no remote logging, no update check, no fonts or
  scripts from a CDN. The only requests are for the app's own files from the
  host that served them, and the printer link.
- No account, no identifier, no cookie set by the page.
- No file-system access beyond the image picker and the diagnostics download,
  and no background execution after the page is closed.
- The APK package is self-signed and sideloaded; it is not distributed through a
  store and has no auto-update channel.

The offline worker caches the app's own files only. It rejects a redirect, a
content type that contradicts the file extension and any body whose SHA-256
digest does not match the generated manifest, so a host that serves different
bytes cannot poison the cache.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes — fixes land on `main` and are released as a new tag |
| Anything older than 1.0 | No — there is no compatibility branch |

Releases are the signed APK and the static site at
<https://llm-4-people.github.io/drypoint/>. The APK's signing certificate is
`CN=Drypoint, O=LLM-4-People, C=CA`, self-signed. Android only installs an
update over an existing app when it is signed by the same key.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's security advisories:

<https://github.com/LLM-4-People/drypoint/security/advisories/new>

That channel is private to the maintainers, keeps the report and the fix
attached to the repository, and gives you credit in the advisory if you want it.
There is no project e-mail address; the advisory form is the reporting channel.

Please include:

- the version or commit, and whether it is the web app or the APK,
- the platform and transport (Web Serial, Web Bluetooth, Android bridge),
- what an attacker gains, and the smallest reproduction you have,
- any relevant log excerpt **with serial numbers, MAC addresses and home paths
  removed**.

Never attach a private signing key, a keystore password or a full diagnostics
export that has not been redacted.

## Coordinated disclosure

- We acknowledge a report as soon as we can and confirm whether it is in scope.
- We work on a fix in a private advisory draft; the repository's CI still runs
  on the fix.
- We agree a disclosure date with you. The default is when a fixed release is
  published; a report that is already public is handled immediately.
- The advisory and the release notes describe the impact and the fix, and credit
  the reporter unless they ask otherwise.

## Scope of the protocol implementation

This project implements the printer protocol it could observe on retail
hardware. It is not an official SDK and makes no claim to be complete.

- The D110M V4 sequence is the only print task implemented. Models outside the
  tested one are refused before a frame is sent; the D11_H is experimental and
  asks for confirmation.
- Reply layouts that were not verified — paper info (`0x69`), print history
  (`0x62`) and the print area (`0x0F`) — are exposed as raw bytes, never as
  guessed fields.
- A malformed or hostile reply is treated as absent or as an error, not as a
  default: a truncated head width, an inverted range and a zero-length model id
  all decode as "not reported", and a print that depends on them is refused.
- The app never writes printer firmware, RFID data other than the roll profile
  it owns, or any calibration that the operator did not request.

Out of scope: a vulnerability that requires an already-compromised device,
physical access to the printer, a malicious browser extension with page access,
or a firmware flaw in the printer itself. A flaw in *this app's* handling of
printer input is in scope.
