# Drypoint protocol notes

This is the NIIMBOT D110-family BLE protocol as implemented by Drypoint.
Drypoint is not affiliated with NIIMBOT.

Everything here is implemented in `src/protocol/` and exercised by
`test/frames.test.mjs`, `test/commands.test.mjs`, `test/replies.test.mjs` and
`test/manager.test.mjs`. Values marked **unverified** are exposed as raw bytes
on purpose; the app never guesses an offset for them.

## Frame layout

```
55 55  CMD  LEN  DATA[LEN]  CRC  AA AA
```

| Field | Size | Meaning |
| --- | --- | --- |
| head | 2 | `0x55 0x55` |
| CMD | 1 | request or reply opcode |
| LEN | 1 | payload length, 0–255 |
| DATA | LEN | payload bytes |
| CRC | 1 | XOR of CMD, LEN and every DATA byte |
| tail | 2 | `0xAA 0xAA` |

- The CRC is a plain 8-bit XOR; no mask is applied (an XOR result is already
  0–255).
- `encodeFrame` rejects payload elements that are not integers 0–255 and
  payloads longer than 255 bytes with a `RangeError`
  (`CONFIG.protocol.maxPayloadBytes`); `Uint8Array.from` would silently wrap
  `300` to `0x2c`.
- The parser (`FrameReader`) accepts arbitrary transport fragments, verifies the
  CRC and tail, and resynchronises one byte at a time after a bad frame. A
  corrupted length byte cannot stall the stream: an incomplete candidate is
  skipped as soon as a complete, valid frame follows it. The length byte is the
  only frame-size limit (0–255), so there is no second, unreachable threshold.
- The only framed request with a prefix is `Connect`: the bytes `03` precede the
  frame (`03 55 55 c1 01 01 c1 aa aa`). The BLE transport builds that frame from
  the command registry; no transport keeps a copy of the bytes.

## Opcode classes

`src/protocol/commands.js` owns three frozen tables:

- `OP` — every opcode this codebase can build or receive. It is not a claim
  that the app sends all of them; `OP_ROLE` is.
- `OP_ROLE` — every known opcode classified as `request` (a caller names the
  command), `unused` (registered and buildable, but nothing sends it),
  `inbound` or `unsupported`.
- `UNSUPPORTED_OPS` — opcodes known from the protocol family that this app
  deliberately does not send, each with a reason.

`test/op-registry.test.mjs` enforces that every known opcode is classified
exactly once, that numbers are unique, that every command builds from a
`request`/`unused` opcode, and that the classification matches which commands a
`src/` module actually names: a `request` command must have a caller, and an
`unused` command must not.

### Commands with no caller

These are classified `unused` in `OP_ROLE` and are kept (with their byte
layouts) instead of being deleted, so the registry stays a complete map of the
family:

| Command | Opcode | Why it is not sent |
| --- | --- | --- |
| `disconnect` | `0xD2` | closing the transport already frees the port; **no `COMMANDS` entry** — its documented reply `0xD3` is also the unsolicited row counter, so an exchange could be answered by a status frame (see the `0xD3` note below) |
| `printerFree` | `0xC3` | unverified on this unit; `CancelPrint` ends a job |
| `setSpeed` | `0x22` | speed is sent inside `PrintStart`; a standalone write is unproven |
| `setVolume` | `0x2E` | the sound switches use `SOUND_SETTINGS` (`0x58`) |
| `setLanguage` | `0x26` | not exposed by the UI |
| `setPrintMode` | `0x2C` | print mode is read, not written |
| `keyFunctions` | `0x09` | no UI consumer |
| `antiFake` | `0x0B` | no UI consumer |

## Requests

Timeouts come from `CONFIG.protocol.timeouts` unless the command overrides them.
Reply opcodes are the firmware's fixed answers; `GetInfo` is the one command
whose reply depends on its key (`0x40 + key`).

| Command | Opcode | Payload | Reply | Timeout | Notes |
| --- | --- | --- | --- | --- | --- |
| `connect` | `0xC1` | `01` | `0xC2` | control | prefixed with `0x03` |
| `getInfo` | `0x40` | key | `0x40 + key` | control | key table below |
| `heartbeatInfo` | `0xDC` | `03` | `0xDE` | control | versions, head, RFID flags |
| `heartbeatAdvanced` | `0xDC` | `04` | `0xD9` | identity (3 s) | battery, sensors |
| `capabilities` | `0xAF` | `01` | `0xBF` | control | TLV capability list |
| `statusData` | `0xA5` | `01` | `0xB5` | control | protocol version, colour |
| `rfid` | `0x1A` | `01` | `0x1B` | control | roll tag |
| `paperInfo` | `0x59` | `01` | `0x69` | control | layout unverified |
| `keyFunctions` | `0x09` | `02 01` | `0x0A` | control | |
| `printHistory` | `0x52` | `01` | `0x62` | control | layout unverified |
| `antiFake` | `0x0B` | `01` | `0x0C` | control | |
| `setDensity` | `0x21` | value | `0x31` | control | required byte |
| `setSpeed` | `0x22` | value | `0x32` | control | required byte |
| `setLabelType` | `0x23` | value | `0x33` | control | required byte |
| `setAutoShutdown` | `0x27` | value | `0x37` | control | required byte |
| `setVolume` | `0x2E` | value | `0x3E` | control | required byte |
| `soundSettings` | `0x58` | action, item, value | `0x68` | control | item required; see the sound map below |
| `setRtc` | `0x07` | `01 YYYY MM DD hh mm ss` | `0x08` | control | year is big-endian |
| `cancelPrint` | `0xDA` | `01` | `0xD0` | control | terminal frame on failure |
| `setLanguage` | `0x26` | value | `0x36` | control | required byte |
| `setPrintMode` | `0x2C` | value | `0x3C` | control | required byte |
| `reset` | `0x28` | `01` | `0x38` | control | destructive |
| `calibrate` | `0x8E` | `01` | `0x8F` | 20 s | feed / align one label |
| `testPage` | `0x5A` | `01` | `0x6A` | 20 s | printer self-test |
| `printerFree` | `0xC3` | `01` | `0xC4` | control | |
| `printStart` | `0x01` | pages u16, `00 00 00 00`, colour, speed, `00` | `0x02` | control | speed 0 = quality, 1 = normal |
| `pageSize` | `0x13` | rows u16, cols u16, copies u16, `00` ×7 | `0x14` | control | |
| `printStatus` | `0xA3` | `01` | `0xB3` | status (3 s) | polled during a job |
| `pageEnd` | `0xE3` | `01` | `0xE4` | control | |
| `printEnd` | `0xF3` | `01` | `0xF4` | control | success terminal frame |

Payload rules: `printStart` is 9 data bytes (`00 01 00 00 00 00 00 01 00` for
one page at normal speed); `pageSize` is 13 data bytes. Both are pinned
byte-for-byte by `test/commands.test.mjs`.

### `soundSettings` map

`SOUND_ITEMS` in `src/protocol/commands.js` owns the item ids; the action byte
is chosen by the caller:

| Byte | Values | Meaning |
| --- | --- | --- |
| action | `0x01` | set (the app's write path) |
| action | `0x02` | read (the panel's initial state) |
| item | `0x01` | Bluetooth connect/disconnect sound |
| item | `0x02` | power on/off sound |
| value | `0x00` / `0x01` | off / on |

The reply's third data byte is the resulting state (`0x01` = on). The sound
switches are only shown when the capability TLV did not report `0x0E`
(`volumeSupport`) as unsupported.

### Connect frame ownership

`Connect` is the only prefixed request (`03` + frame). `buildCommand('connect')`
is the single owner of those bytes: the BLE transport calls it, and no
transport keeps a second copy of the prefix or payload.

## Inbound opcodes

| Opcode | Meaning | Handling |
| --- | --- | --- |
| `0x00` | request not supported | rejects the single outstanding request as `unsupported` |
| `0xDB` | printer error | settles the outstanding request with the error; emits `printer-error` only when nothing is pending |

The `0xDB` rule gives one failure one reporter: the caller of the exchange that
received the error toasts it, and the session does not also emit an event. Only
an unsolicited error on an idle link (no request in flight, no print job owning
the link) reaches the main `printer-error` channel. While a print job owns the
link the job itself is that single reporter: it aborts with the printer error,
stops the raster, sends `CancelPrint` and surfaces the printer's message.

### `0x00` attribution rule

The firmware answers an unsupported request with `0x00` *instead of* the
expected reply, and the frame carries no request id. `Session` serialises
callers, so at most one request is outstanding: normally the `0x00` belongs to
it and rejects it as `unsupported`.

A request that timed out may still receive that answer afterwards, and so may a
request aborted after its write was issued (a print cancel or a discovery
deadline). The session therefore keeps a bounded FIFO of the request opcodes
that left the wire unanswered and consumes the next `0x00` for the oldest of
them, logging it as a late answer instead of rejecting the request that is now
in flight. The ledger is exact:

- One credit per request that left the wire unanswered: a timeout, or an abort
  after the exchange's write was issued. A queued request that never wrote gets
  no credit.
- At most `CONFIG.protocol.maxUnansweredReplies` (8) credits are held; the
  oldest is dropped beyond that bound.
- A successful reply to a later request retires every older credit: replies are
  in order, so nothing older can still arrive.
- A late `0x00` consumes exactly one credit and marks the current request so
  its own timeout reports the printer's answer instead of inventing a second
  negative.
- `0xDB` is **never** consumed this way. It is also an unsolicited printer
  error, so it always belongs to the current request (and is logged when there
  is none).
- A `0x00` with nothing pending and nothing to attribute is diagnostic only.

This is a wire-level heuristic, not a correlation id: a firmware that answers
out of order can still mis-attribute. The session never invents an id the
protocol does not carry.

### Discovery deadline

Every capability probe is optional, so a silent printer would otherwise cost one
control timeout per probe (8 `GetInfo` keys plus the core probes). The manager
gives a whole discovery one deadline — `CONFIG.protocol.timeouts.discovery`
(12 s) — as an `AbortSignal` passed to every exchange. When it fires, the
in-flight request is aborted and `connect()`/`refresh()` rejects with
"The printer did not finish discovery within 12000 ms" instead of holding the
manager (and the print-job lock) for a minute or more.

`GetInfo` keys are read through one projection table in
`src/device/manager.js`. A key is probed only when a capability consumes it;
keys that nothing consumes are diagnostic-only and are read on demand (Print
panel → Read device info) under the same discovery deadline. Adding a probe
therefore means naming its consumer in that table, and the matrix test fails if
a probe has none.

Unsolicited frames that are not the outstanding reply are emitted as a `frame`
event and otherwise ignored.

## Supported models and the print gate

`src/protocol/models.js` is the one model table. `support` is a product fact,
not a firmware guess:

| Id | Vendor name | Support |
| --- | --- | --- |
| `0x0900` | D110 | not supported |
| `0x0910` | D110_M | **confirmed** |
| `0x0210` | D11_H | experimental |
| `0x0200` | D11 | not supported |
| `0x0202` | D11S | not supported |
| `0x0213` | D11_Pro | not supported |
| `0x1000` | B1 | not supported |
| `0x1001` | B1 Pro | not supported |
| `0x1002` | B1 SE | not supported |
| `0x1B00` | B2 Pro | not supported |
| `0x1B01` | B2 | not supported |
| `0x0300` | B21 | not supported |
| `0x0309` | B21S | not supported |
| `0x0311` | B21 Pro | not supported |
| `0x0901` | D110 / Hi-D110 (vendor-ambiguous) | not supported |

- **confirmed** — the D110M V4 sequence is verified on that hardware.
- **experimental** — the sequence is offered, but the one pre-print confirmation
  says it is unverified on that model.
- **not supported** — the model is named and refused before any frame is sent.
- **unknown** — an id outside the table is `Unknown` and blocks printing.

`printBlockReason` runs at the print choke point and refuses, in order: an
unsupported model (with its real name), an unknown or absent model, and a head
width the printer did not report — including a malformed `0` or `65535` report,
which never becomes geometry. An experimental model is allowed after the
operator confirms. Lid, paper and battery checks follow and apply only when the
printer reported them.

The print task is named by behaviour: the app implements the **D110M V4**
sequence and never derives a task name from the protocol build number.

## D110M V4 print sequence

`src/device/print-job.js` is the single owner of the job order. It matches the
captured official-app session.

```
HeartbeatAdvanced (optional, and the print gate's sample)
SetLabelType
SetDensity
PrintStart
PrintStatus (optional probe)
SetPageSize
row frames (0x85 / 0x84)
PageEnd
poll PrintStatus until pagesPrinted >= copies
PrintEnd
```

1. **HeartbeatAdvanced** and the first **PrintStatus** are optional probes: an
   unsupported reply or a timeout is swallowed. Every other step is mandatory.
   The manager decides `printBlockReason` on the decoded heartbeat (lid, paper,
   battery) *inside* the job lock, before `SetLabelType`; discovery-time
   readings never gate a job. When the printer has reported sensors, an
   unanswered job heartbeat refuses the job ("The printer did not report its
   sensors; refusing to print") instead of falling back to the discovery-time
   model: "no answer" is not "all clear".
2. **PrintStart** carries the copy count and speed. After this point a failure
   or user cancel must send exactly one **CancelPrint** (`0xDA`).
3. **SetPageSize** sends `rows = raster.height`, `cols = raster.width`,
   `copies`.
4. Rows are run-length encoded at `ceil(width / 8)` bytes per row:
   - blank rows → `0x84`, `index u16`, `repeat` (max 255)
   - non-blank rows → `0x85`, `index u16`, ink counts for three horizontal
     thirds, `repeat` (max 200), then the row bytes
5. **PageEnd** closes the page. The job then polls **PrintStatus** every 90 ms
   until the page counter reaches `copies`. The 60 s completion timeout is a
   **per-page stall threshold**, not a budget for the whole job: the deadline is
   pushed forward whenever `pagesPrinted` increases, so a 99-copy batch on
   200 mm tape is never cancelled mid-roll. Only "no new page for 60000 ms"
   fails the job, with that exact wording.
6. **PrintEnd** is the success terminal frame. A job that fails after
   `PrintStart` sends **CancelPrint** instead and never sends `PrintEnd`; a
   cancelled job never sends a success frame afterwards. The job publishes its
   terminal commit immediately before it starts the **PrintEnd** exchange, so a
   Cancel during that ack reports "already settled" instead of aborting a
   decided outcome.

## Reply field maps

Offsets are zero-based inside the frame payload. A payload shorter than a
decoder's documented minimum is not decoded at all: `0xD9` returns `null` (so
the merge cannot build sensors from an all-undefined sample), while `0xDE` and
`0xB5` return `{ raw }` and `0xB3` falls back to `0` for its progress bytes.
Only the offset field-map decoder reports a *missing field* as `null`; the
hand-written decoders above never invent an offset. A TLV range that does not
carry both bytes decodes as absent.

### `0xDE` heartbeat info (requires ≥10 bytes)

| Offset | Field | Encoding |
| --- | --- | --- |
| 0–1 | `hardwareVersion` | major + fraction/100 (e.g. `04 01` → 4.01) |
| 2–3 | `softwareVersion` | same encoding |
| 4–5 | `headWidthPx` | u16 big-endian |
| 6 | `dpiClass` | raw class byte (`2` → 203 dpi, `3` → 300 dpi) |
| 6 (derived) | `dpi` | resolution decoded from the class; `null` for an unknown class |
| 7 | `headAlignment` | raw byte |
| 8 | `rfidRead` | `1` = supported |
| 9 | `rfidWrite` | `1` = supported |

### `0xD9` heartbeat advanced (requires ≥9 bytes)

| Offset | Field | Encoding |
| --- | --- | --- |
| 0–1 | `voltageMv` | u16 |
| 2 | `batteryLevel` | 0–4 |
| 2 | `batteryPercent` | `level × 25`, clamped 0–100 |
| 3 | `temperatureRaw` | raw byte |
| 4 | `lidClosed` | `0` = closed |
| 5 | `paperPresent` | `0` = present |
| 6 | `rfidOk` | `1` = ok |

### `0xB5` status data (requires ≥13 bytes)

| Offset | Field | Encoding |
| --- | --- | --- |
| 9 | `packetIntervalMs` | raw byte |
| 10 | `supportsColor` | `1` = supported |
| 11–12 | `protocolVersion` | `major × 100 + minor` (`03 01` → 301) |

### `0xBF` capability TLV

Repeated `id (1) length (1) value (length)`. The app builds its feature surface
from this reply rather than a model table.

| ID | Field | Decoded as |
| --- | --- | --- |
| `0x01` | `language` | raw |
| `0x02` | `printMode` | raw |
| `0x03` | `uhfRfid` | raw |
| `0x04` | `dpi` | u16 |
| `0x05` | `rfidSupport` | `1` = read supported |
| `0x06` | `batteryRange` | `{ max: byte0, min: byte1 }` |
| `0x07` | `densityRange` | `{ max: byte0, min: byte1 }` |
| `0x08` | `speedRange` | `{ max: byte0, min: byte1 }` |
| `0x09` | `labelTypeMask` | 32-bit big-endian; bit 0 (LSB) = type 1 |
| `0x0A` | `headWidthPx` | u16 |
| `0x0B` | `maxPrintHeightPx` | u16 |
| `0x0C` | `labelHeightAndGap` | raw |
| `0x0D` | `headPosition` | raw |
| `0x0E` | `volumeSupport` | `1` = supported |
| `0x0F` | `hostStyle` | raw |
| `0x10` | `printProtocol` | raw |
| `0x11` | `autoShutdownRange` | `{ max: byte0, min: byte1 }` |
| `0x12` | `cutterSupport` | `1` = supported |
| `0x13` | `cutterDepthRange` | raw |
| `0x14` | `printControl` | raw |
| `0x15` | `pauseTimeSupport` | raw |
| `0x16` | `paperDetection` | raw |
| `0x17` | `realTimeClock` | `1` = supported |
| `0x18` | `keyFunctions` | raw |
| `0x1A` | `printColor` | `1` = supported |
| `0x1C` | `tubeCalibration` | raw |
| `0x1F` | `tubeSupport` | raw |
| `0x20` | `grayBuffer` | `1` = supported |
| other | `unknown<hex>` | raw array |

An absent boolean TLV decodes as `null`, not `false`, so the capability merge
can fall through to another source (for example `rfidRead` from the heartbeat).
A boolean TLV must carry at least one byte: a zero-length value is malformed and
also decodes as `null`, never as "reported no". This applies to
`rfidSupport`, `volumeSupport`, `cutterSupport`, `realTimeClock`, `printColor`
and `grayBuffer`.

### `0xB3` print status

| Offset | Field | Encoding |
| --- | --- | --- |
| 0–1 | `pagesPrinted` | u16; completion is this counter, never progress |
| 2 | `renderProgress` | raw byte |
| 3 | `feedProgress` | raw byte |
| 7 | `busy` | `1` = busy |

### `0x1B` roll tag (requires ≥9 bytes)

The first eight payload bytes are not decoded; offset 8 holds the barcode
length, so a shorter payload cannot be read at all and returns `null`.

| Offset | Field | Encoding |
| --- | --- | --- |
| 8 | length | barcode length |
| 9… | `barcode` | ASCII |
| next | length | serial length |
| next… | `serial` | ASCII |
| next 2 | `total` | u16 label capacity |
| next 2 | `used` | u16 labels used |
| next 1 | `type` | label-type id |
| derived | `remaining` | `max(0, total − used)` |

### `0x69` paper info and `0x62` print history

**Unverified.** Both decoders return `{ opcode, length, fields, raw,
unverified: true }`. `PAPER_INFO_FIELDS` and `PRINT_HISTORY_FIELDS` are empty
maps: adding a real offset there is the one place that documents it.

### `GetInfo` keys (`0x40 + key`)

The projection table in `src/device/manager.js` decides which keys discovery
probes. "Consumer" is the capability the decoded value feeds; `diagnostic` keys
are never probed during discovery and are read only by the Print panel's
"Read device info" action. The table has all 15 keys: 8 are probed during
discovery and 7 are diagnostic-only.

| Key | Field | Encoding | Consumer |
| --- | --- | --- | --- |
| `0x01` | `density` | byte | density control, detected-settings mirror |
| `0x02` | `speed` | byte | diagnostic only (the app's job speed is a separate enum) |
| `0x03` | `labelType` | byte + name | tape-type control, detected-settings mirror |
| `0x04` | `headWidthPx` | u16 | diagnostic only (the capability TLV reports the head) |
| `0x05` | `accuracy` | not decoded | diagnostic only |
| `0x06` | `language` | not decoded | diagnostic only |
| `0x07` | `autoShutdown` | byte | auto power-off control |
| `0x08` | `modelId` | u16 (or one byte) → `deviceType`, `model`; a zero-length reply reports `null` | printer identity rows |
| `0x09` | `softwareVersion` | major + fraction/100 | firmware row |
| `0x0A` | `battery` | level 0–4 → percent | battery row |
| `0x0B` | `serial` | ASCII (≥8 bytes) or 4-byte hex | serial row |
| `0x0C` | `hardwareVersion` | major + fraction/100 | firmware row |
| `0x0D` | `bluetoothAddress` | 6 bytes → colon-hex | diagnostic only |
| `0x0E` | `printMode` | byte | diagnostic only |
| `0x0F` | `area` | raw (`{ length, raw }`) — layout unverified | diagnostic only |

## Error codes (`0xDB` payload byte 0)

| Code | Meaning |
| --- | --- |
| `0x01` | Cover open |
| `0x02` | Out of paper |
| `0x03` | Low battery |
| `0x04` | Battery error |
| `0x05` | Cancelled by user |
| `0x06` | Data error |
| `0x07` | Overheating |
| `0x08` | Paper out |
| `0x09` | Printer busy |
| `0x0A` | Print head missing |
| `0x0B` | Temperature too low |
| `0x0C` | Print head loose |
| `0x0D` | No ribbon |
| `0x0E` | Wrong ribbon |
| `0x0F` | Ribbon already used |
| `0x10` | Wrong paper |
| `0x11` | Tape type rejected |
| `0x12` | Print mode rejected |
| `0x13` | Density rejected |
| `0x14` | RFID write failed |
| `0x15` | Margin rejected |
| `0x16` | Communication error |
| `0x17` | Disconnected |
| `0x18` | Canvas parameter error |
| `0x19` | Rotation parameter error |
| `0x1A` | Template parameter error |
| `0x1B` | Abnormal paper output |
| `0x1C` | Paper check required |
| `0x1D` | RFID tag not written |
| `0x1E` | Density not supported |
| `0x1F` | Print mode not supported |
| `0x20` | Label material error |
| `0x21` | Label material not supported |
| `0x22` | RFID writing not supported |
| `0x32` | Illegal page |
| `0x33` | Illegal ribbon page |
| `0x34` | Receive data timeout |
| `0x35` | Non-dedicated ribbon |

Unknown codes are reported as `Printer error 0xNN`.

## Verified facts (captured unit)

Captured from a retail D110_M unit used for development and pinned in
`test/manager.test.mjs`. The unit's serial number and the roll tag's serial are
hardware identifiers, so this repository does not publish them: the fixtures
use the clearly synthetic values owned by `test/fixtures/captured-unit.mjs`.

| Fact | Value |
| --- | --- |
| Model ID | `0x0910` → `D110_M` (confirmed) |
| Serial | not published; the decoder accepts ASCII (≥8 bytes) or 4-byte hex |
| Firmware / hardware | 4.23 / 4.01 |
| Head | 96 dots, reported 200 dpi class → 200 / 25.4 = 7.87 dots/mm; tape width derives to 12.19 mm |
| Protocol build | 301 → D110M V4 print task |
| Density range | 1–5 |
| Speed range | 1–5 |
| Label types | 1, 2, 3, 5 (gap, black mark, continuous, transparent) |
| Max print height | 1600 px → 203 mm at 200 dpi (the app caps documents at 200 mm) |
| Auto power-off range | 1–4 |
| RTC / volume / RFID read | supported |
| Cutter / colour / grey buffer | not reported |
| Battery | level 4 → 100 %, 4070 mV in the captured frame |
| Sensors | lid closed, paper present, RFID ok |
| Roll tag | barcode `6977031214406` (a product EAN), 192 total, 75 used (117 remaining), type 1 |

`test/capabilities.test.mjs` covers the merge rules for absent versus zero
values; the capability TLV is the authority when it reports a value.

## Unsupported opcodes

These are known from the protocol family but are not sent by this app:

| Opcode | Name | Why |
| --- | --- | --- |
| `0x03` | PageStart | legacy V1 page flow; D110M V4 uses PrintStart + SetPageSize |
| `0x1C` | GetRfid2 | second RFID query; the roll tag answers `0x1A` |
| `0x2D` | SetLabelMaterial | material selection is not exposed by this unit |
| `0x83` | PrintBitmapRowIndexed | indexed row variant; the job uses `0x85` / `0x84` |
| `0x86` | PrinterCheckLine | head check line; not used by the print flow |
| `0xD3` | RowCounter | unsolicited counter; informational frames are ignored |

`0xD3` is also the reply opcode the protocol table associates with `Disconnect`.
The app never sends `Disconnect`, and `src/protocol/commands.js` deliberately
has no command entry for it, so no request in this app ever matches an inbound
`0xD3`; the frame is treated as informational.
