import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPLY_PARSERS,
  batteryPercent,
  decodeCapabilities,
  decodeHeartbeatAdvanced,
  decodeHeartbeatInfo,
  decodeInfo,
  decodeModelId,
  decodePaperInfo,
  decodePrintHistory,
  decodePrintStatus,
  decodeRfid,
  decodeStatusData,
  decodeVersion,
} from '../src/protocol/replies.js';
import { INFO_KEYS } from '../src/protocol/commands.js';
import { fromHex } from '../src/core/format.js';
import {
  FIXTURE_BLUETOOTH_ADDRESS,
  FIXTURE_BLUETOOTH_BYTES,
  FIXTURE_ROLL_SERIAL,
  FIXTURE_SERIAL,
  ROLL_BARCODE,
  rollTagBytes,
  serialBytes,
} from './fixtures/captured-unit.mjs';

test('version fields use major + fraction/100', () => {
  assert.equal(decodeVersion(fromHex('04 17')), 4.23);
  assert.equal(decodeVersion(fromHex('04 01')), 4.01);
  assert.equal(decodeVersion(fromHex('00 00')), 0);
  assert.equal(decodeVersion(null), null);
});

test('model id decodes two-byte and one-byte forms', () => {
  assert.deepEqual(decodeModelId(fromHex('09 10')), {
    deviceType: 0x0910,
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
  });
  assert.deepEqual(decodeModelId(fromHex('09')), {
    deviceType: 0x0900,
    model: 'D110',
    modelSupport: 'unsupported',
    task: 'd110mv4',
  });
  assert.deepEqual(decodeModelId(fromHex('12 34')), {
    deviceType: 0x1234,
    model: 'Unknown',
    modelSupport: 'unknown',
    task: null,
  });
});

test('a zero-length model reply reports no model beside the same headWidth rule', () => {
  // The empty reply is not an identity: u16([]) would say 0x0000 and the header
  // would name a model the printer never reported. The one-byte (high-byte)
  // form above is the documented reply and is untouched.
  assert.deepEqual(decodeModelId(fromHex('')), { deviceType: null, model: null });
  // The same "absent, not a shifted guess" rule headWidth already follows.
  assert.deepEqual(decodeInfo(INFO_KEYS.headWidth, fromHex('')), { headWidthPx: null });
});

test('GetInfo keys decode real payloads', () => {
  assert.deepEqual(decodeInfo(INFO_KEYS.density, fromHex('03')), { density: 3 });
  assert.deepEqual(decodeInfo(INFO_KEYS.labelType, fromHex('01')), { labelType: 1, labelTypeName: 'Gap labels' });
  assert.deepEqual(decodeInfo(INFO_KEYS.autoShutdown, fromHex('03')), { autoShutdown: 3 });
  assert.deepEqual(decodeInfo(INFO_KEYS.battery, fromHex('04')), { batteryLevel: 4, batteryPercent: 100 });
  assert.deepEqual(decodeInfo(INFO_KEYS.serial, Uint8Array.from(serialBytes())), { serial: FIXTURE_SERIAL });
  assert.deepEqual(decodeInfo(INFO_KEYS.hardwareVersion, fromHex('04 01')), { hardwareVersion: 4.01 });
  assert.deepEqual(decodeInfo(INFO_KEYS.bluetoothAddress, Uint8Array.from(FIXTURE_BLUETOOTH_BYTES)), { bluetoothAddress: FIXTURE_BLUETOOTH_ADDRESS });
  assert.deepEqual(decodeInfo(INFO_KEYS.modelId, fromHex('09 10')), {
    deviceType: 0x0910,
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
  });
});

test('heartbeat info decodes head geometry and RFID capability', () => {
  assert.deepEqual(decodeHeartbeatInfo(fromHex('04 01 04 17 00 60 02 02 01 00')), {
    hardwareVersion: 4.01,
    softwareVersion: 4.23,
    headWidthPx: 96,
    dpiClass: 2,
    dpi: 203,
    headAlignment: 2,
    rfidRead: true,
    rfidWrite: false,
  });
});

test('heartbeat advanced decodes battery and sensors', () => {
  const decoded = decodeHeartbeatAdvanced(fromHex('0f e6 04 49 00 00 01 00 00 00 00'));
  assert.equal(decoded.voltageMv, 4070);
  assert.equal(decoded.batteryLevel, 4);
  assert.equal(decoded.batteryPercent, 100);
  assert.equal(decoded.lidClosed, true);
  assert.equal(decoded.paperPresent, true);
  assert.equal(decoded.rfidOk, true);
});

test('a short 0xD9 decodes as null instead of an all-undefined sample', () => {
  assert.equal(decodeHeartbeatAdvanced(new Uint8Array(0)), null);
  assert.equal(decodeHeartbeatAdvanced(fromHex('0f e6 04 49 00 00 01 00')), null, '8 bytes is one short');
  assert.equal(REPLY_PARSERS[0xd9](fromHex('0f e6')), null);
  assert.ok(decodeHeartbeatAdvanced(fromHex('0f e6 04 49 00 00 01 00 00')));
});

test('status data exposes the protocol version', () => {
  const decoded = decodeStatusData(fromHex('30 30 23 28 00 c8 00 00 00 0a 00 03 01 12 ee 00'));
  assert.equal(decoded.protocolVersion, 301);
  assert.equal(decoded.packetIntervalMs, 10);
});

test('capabilities TLV decodes the real 90-byte reply', () => {
  const payload = fromHex(
    '01 01 00 02 01 01 03 01 00 04 02 00 c8 05 01 01 06 02 04 00 07 02 05 01 08 02 05 01 09 04 00 00 00 17 0a 02 00 60 0b 02 06 40 0c 01 01 0d 01 02 0e 01 01 0f 01 03 10 01 01 11 02 04 01 12 01 00 13 02 00 00 14 01 03 15 01 00 16 01 00 17 01 01 18 05 01 07 00 00 00 19 01 01'
  );
  const caps = decodeCapabilities(payload);
  assert.equal(caps.dpi, 200);
  assert.deepEqual(caps.densityRange, { max: 5, min: 1 });
  assert.deepEqual(caps.speedRange, { max: 5, min: 1 });
  assert.deepEqual(caps.labelTypes, [1, 2, 3, 5]);
  assert.equal(caps.headWidthPx, 96);
  assert.equal(caps.maxPrintHeightPx, 1600);
  assert.equal(caps.hasRtc, true);
  assert.equal(caps.hasCutter, false);
  assert.equal(caps.rfidRead, true);
  // Absent TLVs decode as null so the merge can fall through to another source.
  assert.equal(caps.supportsGray, null);
  assert.equal(caps.supportsColor, null);
});

test('a zero-length boolean TLV is unreported, never a reported "no"', () => {
  const empty = decodeCapabilities(fromHex('05 00 0e 00 12 00 17 00 1a 00 20 00'));
  for (const field of ['rfidRead', 'hasVolume', 'hasCutter', 'hasRtc', 'supportsColor', 'supportsGray']) {
    assert.equal(empty[field], null, `${field} is null for a zero-length TLV`);
  }
  assert.deepEqual(empty.raw.printColor, [], 'the empty TLV is still visible in the raw map');

  const reportedNo = decodeCapabilities(fromHex('05 01 00 0e 01 00 12 01 00 17 01 00 1a 01 00 20 01 00'));
  for (const field of ['rfidRead', 'hasVolume', 'hasCutter', 'hasRtc', 'supportsColor', 'supportsGray']) {
    assert.equal(reportedNo[field], false, `${field} is false for a one-byte 0`);
  }

  const reportedYes = decodeCapabilities(fromHex('1a 01 01 20 01 01'));
  assert.equal(reportedYes.supportsColor, true);
  assert.equal(reportedYes.supportsGray, true);
});

test('capabilities survive a truncated payload', () => {
  const caps = decodeCapabilities(fromHex('07 02 05'));
  assert.deepEqual(caps.raw, {});
  assert.equal(caps.densityRange, null);
});

test('a range TLV without both bytes decodes as absent, never as NaN', () => {
  // 07 01 05: densityRange declares one byte, but a range is (max, min).
  const caps = decodeCapabilities(fromHex('07 01 05'));
  assert.equal(caps.densityRange, null);
  assert.equal(caps.speedRange, null);
  assert.deepEqual(caps.raw.densityRange, [5], 'the raw TLV is still visible');

  const valid = decodeCapabilities(fromHex('07 02 05 01'));
  assert.deepEqual(valid.densityRange, { max: 5, min: 1 });
});

test('a 16-bit TLV needs both bytes; a truncated value is absent, never a guess', () => {
  // Each of these used to return a definite number because `u16` read the
  // missing second byte as zero: [] -> 0, [05] -> 1280, [06] -> 1536 (192 mm).
  for (const [tlv, name] of [
    ['04 00', 'dpi'],
    ['04 01 05', 'dpi'],
    ['0a 01 60', 'headWidthPx'],
  ]) {
    const caps = decodeCapabilities(fromHex(tlv));
    assert.equal(caps[name], null, `${name} is null for a truncated TLV`);
  }
  // The 1-byte max print height is the one that silently clamped a 200 mm
  // label to 192 mm. It must stay absent, and the merge must keep its default.
  const shortMax = decodeCapabilities(fromHex('0b 01 06'));
  assert.equal(shortMax.maxPrintHeightPx, null);

  for (const [tlv, expected] of [
    ['04 02 00 c8', { dpi: 200 }],
    ['0a 02 00 60', { headWidthPx: 96 }],
    ['0b 02 06 40', { maxPrintHeightPx: 1600 }],
  ]) {
    const caps = decodeCapabilities(fromHex(tlv));
    for (const [name, value] of Object.entries(expected)) assert.equal(caps[name], value, `${name} still decodes`);
  }
});

test('GetInfo head width needs both bytes, never a shifted byte', () => {
  assert.deepEqual(decodeInfo(INFO_KEYS.headWidth, fromHex('60')), { headWidthPx: null });
  assert.deepEqual(decodeInfo(INFO_KEYS.headWidth, fromHex('')), { headWidthPx: null });
  assert.deepEqual(decodeInfo(INFO_KEYS.headWidth, fromHex('00 60')), { headWidthPx: 96 });
});

test('an inverted range TLV decodes as absent instead of a backwards range', () => {
  // 07 02 05 06: max 5 < min 6. Clamping against it would always yield 6.
  const caps = decodeCapabilities(fromHex('07 02 05 06'));
  assert.equal(caps.densityRange, null);
  assert.deepEqual(caps.raw.densityRange, [5, 6], 'the raw bytes stay visible for diagnostics');

  const equal = decodeCapabilities(fromHex('07 02 03 03'));
  assert.deepEqual(equal.densityRange, { max: 3, min: 3 }, 'a single-value range is still valid');
});

test('print status reports pages, not progress', () => {
  const decoded = decodePrintStatus(fromHex('00 02 64 64 00 00 00 01'));
  assert.equal(decoded.pagesPrinted, 2);
  assert.equal(decoded.renderProgress, 100);
  assert.equal(decoded.busy, true);
  assert.equal(decodePrintStatus(new Uint8Array(0)).pagesPrinted, 0);
});

test('rfid tag decodes the captured roll payload', () => {
  const roll = decodeRfid(rollTagBytes());
  assert.equal(roll.barcode, ROLL_BARCODE);
  assert.equal(roll.serial, FIXTURE_ROLL_SERIAL);
  assert.equal(roll.total, 192);
  assert.equal(roll.used, 75);
  assert.equal(roll.remaining, 117);
  assert.equal(roll.type, 1);
  assert.equal(roll.typeName, 'Gap labels');
});

test('rfid tag absent and truncated payloads', () => {
  assert.equal(decodeRfid(fromHex('01')), null);
  assert.equal(decodeRfid(new Uint8Array(0)), null);
  const truncated = decodeRfid(fromHex('88 1d d2 f9 e2 8c 00 00 0d 41'));
  assert.equal(truncated.barcode, 'A');
  assert.equal(truncated.remaining, null);
});

test('battery percent has one clamp shared by both decoders', () => {
  assert.equal(batteryPercent(0), 0);
  assert.equal(batteryPercent(4), 100);
  assert.equal(batteryPercent(9), 100);
  assert.equal(batteryPercent(-1), 0);
  assert.equal(batteryPercent(null), null);
  assert.equal(decodeInfo(INFO_KEYS.battery, fromHex('09')).batteryPercent, 100);
  assert.equal(decodeHeartbeatAdvanced(fromHex('0f e6 09 49 00 00 01 00 00')).batteryPercent, 100);
});

test('the area key decodes as named raw bytes', () => {
  assert.deepEqual(decodeInfo(INFO_KEYS.area, fromHex('00 60 06 40')), {
    area: { length: 4, raw: [0x00, 0x60, 0x06, 0x40] },
  });
});

test('paper info and print history expose raw fields instead of guessed offsets', () => {
  const paper = decodePaperInfo(fromHex('00 60 00 00'));
  assert.equal(paper.opcode, 0x69);
  assert.equal(paper.length, 4);
  assert.deepEqual(paper.raw, [0x00, 0x60, 0x00, 0x00]);
  assert.deepEqual(paper.fields, {});
  assert.equal(paper.unverified, true);

  const history = decodePrintHistory(fromHex('01 02 03'));
  assert.equal(history.opcode, 0x62);
  assert.equal(history.length, 3);
  assert.deepEqual(history.fields, {});
  assert.equal(history.unverified, true);
});

test('paper info and history are registered reply parsers', () => {
  assert.equal(REPLY_PARSERS[0x69], decodePaperInfo);
  assert.equal(REPLY_PARSERS[0x62], decodePrintHistory);
});
