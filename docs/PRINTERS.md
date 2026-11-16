# Printers

This page is the public support matrix: which NIIMBOT printers Drypoint will
talk to, which model ids it recognises, how much head and tape a model has, why
the state is what it is, and what evidence a new model would need. The code's
one model table is `src/protocol/models.js`; `test/docs.test.mjs` compares this
page with it, so an invented name or a mismatched state fails the build.

## What the three states mean

| State | Behaviour |
| --- | --- |
| **Tested** | Discovery, the print sequence, sensors, battery and the roll tag were captured from and verified on retail hardware. |
| **Experimental** | The model reports a known id and shares the protocol family, but the D110M V4 print sequence has not been verified on it. The app asks for confirmation before it prints or runs the self-test. |
| **Not supported** | The id is recognised and named; every command that writes to the printer is refused before a frame. Read-only diagnostics stay available. |

A model id outside the table is **unknown**. The app never guesses a model, and
every mutating command stays disabled until the printer reports one it knows.

A model or geometry refusal sends no frame at all. A sensor refusal is different:
the model is supported and the geometry real, so the print job reads one
heartbeat, prints nothing and runs no further discovery.

## Support matrix

The pitch is the reported resolution divided by 25.4. "Derived" tape
width is the reported head width in dots divided by that pitch; it is a
property of the head, not a claim about the roll in the printer.

The table names 21 ids. The vendor catalogue has more models; an id outside the
table is `Unknown` and blocked, never guessed from a neighbouring name.

| Model | Id | Status | Head and pitch | Tape | Why | What would be needed |
| --- | --- | --- | --- | --- | --- | --- |
| **D110_M** | `0x0910` | Tested | 96 dots at the capability TLV's 200 dpi → 7.87 dots/mm | 12.19 mm derived from the head (12 mm stock) | The reference unit; every protocol fact in this repository was captured on it. | Nothing. |
| **D11_H** | `0x0210` | Experimental | Not measured | Not measured | Reports a known id in the same family, but no print was captured on this model, so its task and page sequence are unverified. | A captured discovery handshake and a test print, and the print task its firmware expects. |
| D110 | `0x0900` | Not supported | Not measured | Not measured | A separate catalogue id from the D110_M; this release has no captured evidence for its print task. | A captured handshake and print sequence for this exact id, plus a hardware test. |
| D11 | `0x0200` | Not supported | Not measured | Not measured | Known id outside the verified path; the D110M V4 sequence is not established for it. | The same evidence as above. |
| D11S | `0x0202` | Not supported | Not measured | Not measured | Known id outside the verified path. | The same evidence as above. |
| D11_Pro | `0x0213` | Not supported | Not measured | Not measured | Known id outside the verified path. | The same evidence as above. |
| B18 | `0x0e00` | Not supported | Vendor: 96 dots at 203 dpi; not measured here | Not measured | A 12 mm sibling from the vendor catalogue; its print task is not established and no D110M V4 print was captured. | A captured handshake and print, and the task its firmware accepts. |
| B18S | `0x0e01` | Not supported | Vendor: 96 dots at 203 dpi; not measured here | Not measured | The same 12 mm sibling family; the print task is not established. | The same evidence as B18. |
| N1 | `0x0e02` | Not supported | Vendor: 96 dots at 203 dpi; no head-width report on the device | Not measured | An independent capture shows its firmware refusing the 13-byte `SetPageSize`/`PageEnd` of the D110M V4 sequence (`0xDB 06`) and printing with the `b1` task; it reports no head width on the `0xDC[0x03]` probe. | A captured handshake and the task its firmware accepts; head-width evidence. |
| H1 | `0x0f00` | Not supported | Vendor: 96 dots at 203 dpi; not measured here | Not measured | A 12 mm sibling from the vendor catalogue; its print task is not established. | A captured handshake and print. |
| H1S | `0x1100` | Not supported | Vendor: 96 dots at 203 dpi; not measured here | Not measured | It uses its own task (2-byte `PrintStart`, 9-byte `SetPageSize`, `PageStart`), not the D110M V4 sequence. | A model-specific implementation and a hardware test. |
| D101 | `0x0a00` | Not supported | Vendor: 192 dots at 203 dpi; 24 mm head | 24 mm stock | The D110M V4 sequence is reported to work, but the D101 head is 24 mm and this app is scoped to 12 mm; the geometry gate would refuse the label. This is a scope refusal, not a protocol failure. | A 24 mm product scope decision and a capture in this repo. |
| B1 | `0x1000` | Not supported | Not measured | Not measured | A different printer family; this app only speaks the 12 mm D110 path. | A model-specific protocol implementation, not just an id. |
| B1 Pro | `0x1001` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B1 SE | `0x1002` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B2 | `0x1b01` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B2 Pro | `0x1b00` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B21 | `0x0300` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B21S | `0x0309` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| B21 Pro | `0x0311` | Not supported | Not measured | Not measured | A different printer family. | A model-specific protocol implementation. |
| D110 / Hi-D110 | `0x0901` | Not supported | Not measured | Not measured | The vendor reports this one id under two names, so the model behind it is ambiguous. | Evidence of which device answers it, then a captured handshake and print. |

No model other than the D110_M has been tested. The D11_H is listed as
experimental because it reports a known id in the same family, not because a
print was verified on it.

## Head, pitch and tape

The app reads the head width and the reported resolution from the printer, then
derives the rest:

- **Pitch** = `dpi / 25.4`. 203 dpi → 7.99 dots/mm, 300 dpi → 11.81 dots/mm.
  The D110_M's capability TLV reported 200 dpi, which gives 7.87 dots/mm. Its
  heartbeat's resolution class byte is `2`, which decodes to 203 dpi; the TLV
  is the pitch authority when it has a usable value.
- **Tape width** = `headWidthPx / pitch`. For the reference unit,
  `96 / 7.87` = 12.19 mm — slightly wider than the 12 mm stock, because the
  head is wider than the printable area of the label.
- **Maximum length** comes from the printer's reported maximum print height
  (1600 px on the reference unit → 203 mm at 200 dpi), capped by the app at
  200 mm.

Before a printer is discovered, or when it reports no usable head width, the
app uses the configured fallback (203 dpi, 96 dots, 8 dots/mm), labels it as
assumed, and keeps printing disabled. A reported `0` or `65535` is treated as a
malformed reply, not as geometry.

## Page margin and padding

The app pads each new label by **4 dots on every side**
(`CONFIG.geometry.paddingPx`), which is **0.51 mm** at the reference unit's
measured 7.87 dots/mm. This is a layout inset, not a printer margin: the app
sends a full-height raster and does not compensate for the printer's own
non-printable leading or trailing margin, which was not measured for this
release. If prints sit consistently high or low on the tape, use **Feed /
Align one label**, then set the document length to match the stock.

## How to propose a new model

A model is added when there is evidence, never when a name looks close. The two
additions have different bars.

**A supported model** (tested or experimental) needs all of:

1. The id the printer reports (`GetInfo` key `0x08`, the `0xDE` heartbeat, and
   the capability TLV `0x0A` head width if it answers them).
2. The discovery transcript, with any serial number removed.
3. The print sequence its firmware expects, captured from a real print.
4. A hardware test of the full flow: discovery, one label, sensors and the roll
   tag.
5. The change in `src/protocol/models.js` plus this page, and a test that pins
   the new id.

**A named refusal** may be added from the vendor catalogue's `codes[]`
(`https://print.niimbot.com/api/hardware/list`), because it only ever blocks:
the row must say the print task is unestablished and that no print was
captured here. Promotion to experimental or tested still needs the full
evidence above. This is why B18, B18S, N1, H1, H1S and D101 are listed as
named refusals.

An unsupported id is not a bug. Refusing every write to a model whose task is
unknown is the safety property: a guessed sequence can feed the wrong rows to a
head and produce an unreadable label or a jam. Reads remain available so the
operator and a report can still identify the printer.
