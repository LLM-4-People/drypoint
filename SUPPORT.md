# Support

## Where to ask

| I need… | Go to |
| --- | --- |
| To report a bug | [a bug report](https://github.com/LLM-4-People/drypoint/issues/new?template=bug_report.yml) |
| A feature | [a feature request](https://github.com/LLM-4-People/drypoint/issues/new?template=feature_request.yml) |
| To ask how something works | [a question](https://github.com/LLM-4-People/drypoint/issues/new?template=question.yml) |
| To report a vulnerability | [a private advisory](https://github.com/LLM-4-People/drypoint/security/advisories/new): never a public issue |

Search the existing issues first: a printer that is not on the support matrix is
the most common question, and the answer is in
[docs/PRINTERS.md](docs/PRINTERS.md).

## What to include in a report

- **Which surface**: the web app (which browser and version) or the Android APK
  (Android version, phone model).
- **Which printer**: the model name and the id the app shows in the Print panel.
  Say whether it is tested, experimental, not supported or unknown.
- **What you expected and what happened**, with the shortest reproduction.
- **The diagnostics log** when it applies: Print panel → diagnostics →
  **Export report**. It is a local JSON file; nothing in the app uploads it.

Before you paste anything, remove:

- the printer's serial number and its Bluetooth address,
- the roll tag's serial,
- your home directory path and your machine's host name,
- any password, token or signing material.

The repository's privacy gate fails the build when the published tree contains
the private host name, an absolute home directory, an absolute browser-cache
path, the reference unit's serial or an e-mail address outside the fixture
domain. It does not recognise a MAC address, a roll-tag serial or an arbitrary
password or token, so those are yours to remove; an issue is a public place too.
A maintainer may edit or redact a report that contains them.

## Supported models

Only the D110_M is tested; the D11_H is experimental. The app names 21 ids in
[docs/PRINTERS.md](docs/PRINTERS.md); every other id it recognises is refused
before a frame is sent, and an id outside the table stays `Unknown` and blocked.
The vendor catalogue lists more models than the app names, so "known" here
means an id in the app's table, not every model NIIMBOT sells. A supported model
with a sensor refusal is different: the print job reads one heartbeat and prints
nothing. A request to support another model is welcome, but it needs evidence:
see [the support policy](docs/PRINTERS.md#how-to-propose-a-new-model). "It looks
the same" is not evidence, because a wrong print sequence can jam a head.

## What to expect

This is a small, volunteer project with no support contract and no warranty
(the licence is MIT). Issues are triaged when someone has time; the checks that
gate a change are in `.github/workflows/` and every pull request runs them.
Issues and pull requests with no activity for 60 days are marked stale, and a
maintainer decides whether to close them. Security reports are handled through
the private advisory channel described in [SECURITY.md](SECURITY.md).

## Not supported

- Firmware updates or repairs for the printer.
- Modifying or reflashing printer firmware.
- Third-party label stock that the printer's own sensors reject.
- A hosted version, an account or any sync service: the app is local-only by
  design.
