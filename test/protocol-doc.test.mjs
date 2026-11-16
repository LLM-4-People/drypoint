/**
 * R7-6: the reply field maps in PROTOCOL.md are a contract, not prose.
 *
 * These tests parse the five hand-written decoder tables out of the document,
 * build one payload per table and assert the decoder's output against the
 * documented field names and encodings. Flipping "0 = closed" to "1 = closed"
 * in the document now fails the suite even though the decoder is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeCapabilities, decodeHeartbeatAdvanced, decodeHeartbeatInfo, decodePrintStatus, decodeRfid, decodeStatusData } from '../src/protocol/replies.js';
import { readProjectFile as read } from './helpers/project-files.mjs';

const doc = read('docs/PROTOCOL.md');

/** The table under a `### ` heading, up to the next heading. */
function section(heading) {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `PROTOCOL.md has ${heading}`);
  const next = doc.indexOf('\n### ', start + heading.length);
  return doc.slice(start, next < 0 ? undefined : next);
}

/** Field rows of one table: [{ offset, field, encoding }]. */
function rows(heading) {
  return section(heading)
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| ---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter(([offset, field]) => offset !== 'Offset' && field && field !== 'Field')
    .map(([offset, field, encoding = '']) => ({ offset, field: field.replaceAll('`', ''), encoding }));
}

const byField = (table) => new Map(table.map((row) => [row.field, row]));

/** The boolean the documented encoding names, and whether 0 or 1 means true. */
function flagPolarity(row) {
  const match = row.encoding.match(/`([01])`\s*=/);
  assert.ok(match, `${row.field} documents its true value as \`0\` = … or \`1\` = … (got ${row.encoding})`);
  return Number(match[1]);
}

const TABLES = {
  '0xDE': { heading: '### `0xDE` heartbeat info', decode: decodeHeartbeatInfo },
  '0xD9': { heading: '### `0xD9` heartbeat advanced', decode: decodeHeartbeatAdvanced },
  '0xB5': { heading: '### `0xB5` status data', decode: decodeStatusData },
  '0xB3': { heading: '### `0xB3` print status', decode: decodePrintStatus },
  '0x1B': { heading: '### `0x1B` roll tag', decode: decodeRfid },
};

test('every documented reply field is one the decoder returns', () => {
  const payload = {
    '0xDE': [4, 1, 4, 23, 0, 96, 2, 1, 1, 1],
    '0xD9': [0x0f, 0xa0, 3, 0x40, 0, 0, 1, 0, 0],
    '0xB5': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a, 1, 3, 1],
    '0xB3': [0, 2, 0x64, 0x64, 0, 0, 0, 1],
    '0x1B': [0, 0, 0, 0, 0, 0, 0, 0, 4, 0x36, 0x39, 0x37, 0x37, 3, 0x47, 0x35, 0x33, 0, 0xc0, 0, 0x4b, 1],
  };
  for (const [opcode, { heading, decode }] of Object.entries(TABLES)) {
    const decoded = decode(Uint8Array.from(payload[opcode]));
    assert.ok(decoded, `${opcode} decodes its documented minimum payload`);
    const fields = new Set(rows(heading).map((row) => row.field));
    // Derived or relocated keys are named here rather than guessed: the raw
    // barcode length is not a result, and typeName is the display form of type.
    if (opcode === '0x1B') {
      fields.delete('length');
      fields.add('typeName');
    }
    for (const field of fields) assert.ok(field in decoded, `${opcode} returns the documented field ${field}`);
    for (const key of Object.keys(decoded)) assert.ok(fields.has(key), `${opcode} has no undocumented field ${key}`);
  }
});

test('boolean fields keep the polarity the document states', () => {
  const table = (heading) => byField(rows(heading));
  const cases = [
    ['0xDE', ['rfidRead', 'rfidWrite'], (byte) => [4, 1, 4, 23, 0, 96, 2, 1, byte, byte]],
    ['0xD9', ['lidClosed', 'paperPresent', 'rfidOk'], (byte) => [0x0f, 0xa0, 3, 0x40, byte, byte, byte, 0, 0]],
    ['0xB5', ['supportsColor'], (byte) => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a, byte, 3, 1]],
    ['0xB3', ['busy'], (byte) => [0, 2, 0x64, 0x64, 0, 0, 0, byte]],
  ];
  for (const [opcode, fields, withByte] of cases) {
    const { decode } = TABLES[opcode];
    const documented = table(TABLES[opcode].heading);
    for (const field of fields) {
      const trueValue = flagPolarity(documented.get(field));
      assert.equal(decode(Uint8Array.from(withByte(trueValue)))[field], true, `${opcode}.${field} true on ${trueValue}`);
      assert.equal(decode(Uint8Array.from(withByte(trueValue === 1 ? 0 : 1)))[field], false, `${opcode}.${field} false on the other value`);
    }
  }
});

test('numeric fields decode exactly as the document describes', () => {
  const hw = decodeHeartbeatInfo(Uint8Array.from([4, 1, 4, 23, 0, 96, 2, 1, 1, 0]));
  assert.equal(hw.hardwareVersion, 4.01, 'major + fraction/100');
  assert.equal(hw.softwareVersion, 4.23);
  assert.equal(hw.headWidthPx, 96, 'u16 big-endian');

  const status = decodeStatusData(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 3, 1]));
  assert.equal(status.protocolVersion, 301, 'major × 100 + minor');
  assert.equal(status.packetIntervalMs, 10);

  const advanced = decodeHeartbeatAdvanced(Uint8Array.from([0x0f, 0xa0, 3, 0x40, 0, 0, 1, 0, 0]));
  assert.equal(advanced.voltageMv, 4000);
  assert.equal(advanced.batteryLevel, 3);
  assert.equal(advanced.batteryPercent, 75, 'level × 25');
  assert.equal(advanced.temperatureRaw, 0x40);

  const printed = decodePrintStatus(Uint8Array.from([0, 2, 0x64, 0x64, 0, 0, 0, 1]));
  assert.equal(printed.pagesPrinted, 2);
  assert.equal(printed.renderProgress, 0x64);
  assert.equal(printed.feedProgress, 0x64);

  const roll = decodeRfid(
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 4, 0x36, 0x39, 0x37, 0x37, 3, 0x47, 0x35, 0x33, 0, 0xc0, 0, 0x4b, 1])
  );
  assert.equal(roll.barcode, '6977');
  assert.equal(roll.serial, 'G53');
  assert.equal(roll.total, 192);
  assert.equal(roll.used, 75);
  assert.equal(roll.remaining, 117, 'max(0, total − used)');
  assert.equal(roll.type, 1);
});

/* ---------------- offset markers and the capability TLV table (R5G-2) ---------------- */

/** A numeric offset cell (`6`, `11–12`), or null for the prose cells of 0x1B. */
function offsetRange(cell) {
  const match = cell.match(/^(\d+)(?:–(\d+))?$/);
  if (!match) return null;
  return match[2] === undefined ? [Number(match[1])] : [Number(match[1]), Number(match[2])];
}

/** The value the documented encoding must produce from the marker bytes. */
function decodeMarker(row, bytes) {
  const { encoding } = row;
  // "same encoding" in 0xDE refers to the version row it follows.
  if (/major \+ fraction\/100|same encoding/.test(encoding)) return bytes[0] + bytes[1] / 100;
  if (/major × 100 \+ minor/.test(encoding)) return bytes[0] * 100 + bytes[1];
  if (/u16/.test(encoding)) return (bytes[0] << 8) | bytes[1];
  if (/level × 25/.test(encoding)) return bytes[0] * 25;
  if (/^0–4$/.test(encoding)) return bytes[0];
  const flag = encoding.match(/`([01])`\s*=/);
  if (flag) return bytes[0] === Number(flag[1]);
  if (/raw/.test(encoding)) return bytes[0];
  assert.fail(`${row.field}: unrecognised encoding "${encoding}"`);
}

const MARKER_LENGTH = { '0xDE': 10, '0xD9': 9, '0xB5': 13, '0xB3': 8 };

test('every decoder reads its markers from the documented offsets', () => {
  // The document's Offset column is the contract: marker bytes placed only at
  // those offsets must decode to the documented values. A decoder reading a
  // neighbouring byte returns the zero-filled rest of the payload instead.
  for (const [opcode, { heading, decode }] of Object.entries(TABLES)) {
    if (!MARKER_LENGTH[opcode]) continue;
    const table = rows(heading)
      .map((row) => ({ ...row, range: offsetRange(row.offset) }))
      .filter((row) => row.range);
    assert.ok(table.length > 0, `${opcode} documents numeric offsets`);

    const length = Math.max(MARKER_LENGTH[opcode], ...table.map((row) => row.range.at(-1) + 1));
    const payload = new Array(length).fill(0);
    for (const row of table) {
      row.bytes = row.range.length === 2 ? [0x12, 0x34] : [1];
      row.range.forEach((offset, index) => {
        assert.ok(
          payload[offset] === 0 || payload[offset] === row.bytes[index],
          `${opcode}: ${row.field} and an earlier row disagree about offset ${offset}`
        );
        payload[offset] = row.bytes[index];
      });
    }

    const decoded = decode(Uint8Array.from(payload));
    assert.ok(decoded, `${opcode} decodes the marker payload`);
    for (const row of table) {
      const expected = decodeMarker(row, row.bytes);
      const actual = decoded[row.field];
      if (typeof expected === 'number' && !Number.isInteger(expected)) {
        assert.ok(Math.abs(actual - expected) < 1e-9, `${opcode}.${row.field} at offset ${row.offset}: ${actual} vs ${expected}`);
      } else {
        assert.equal(actual, expected, `${opcode}.${row.field} at offset ${row.offset}`);
      }
    }
  }

  // The three offsets the round-5 mutations target are pinned in the document
  // as well as the decoder.
  assert.equal(byField(rows('### `0xDE` heartbeat info')).get('headWidthPx').offset, '4–5');
  assert.equal(byField(rows('### `0xB5` status data')).get('packetIntervalMs').offset, '9');
});

/** The 0xBF table rows: [{ id, field }] for every known TLV. */
function capabilityRows() {
  return section('### `0xBF` capability TLV')
    .split('\n')
    .filter((line) => line.startsWith('| `0x'))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return { id: Number.parseInt(cells[0].replaceAll('`', ''), 16), field: cells[1].replaceAll('`', '') };
    });
}

test('every documented capability TLV decodes under its field name', () => {
  const table = capabilityRows();
  assert.ok(table.length >= 20, 'the table lists the known TLV ids');
  for (const { id, field } of table) {
    const decoded = decodeCapabilities(Uint8Array.from([id, 1, 1]));
    assert.ok(field in decoded.raw, `TLV 0x${id.toString(16)} decodes as ${field}`);
  }

  const byId = new Map(table.map(({ id, field }) => [id, field]));
  assert.equal(byId.get(0x04), 'dpi', 'the document owns the dpi id');
  const dpi = decodeCapabilities(Uint8Array.from([0x04, 2, 0x00, 0x60]));
  assert.equal(dpi.raw.dpi[0], 0x00);
  assert.equal(dpi.dpi, 96, 'the u16 property comes from that same field');

  // An id the document does not list stays explicitly unknown.
  const other = decodeCapabilities(Uint8Array.from([0x7f, 1, 1]));
  assert.deepEqual(other.raw.unknown7f, [1]);
  assert.equal(other.dpi, null);
});
