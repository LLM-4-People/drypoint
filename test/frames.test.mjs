import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameReader, crc8, encodeFrame } from '../src/protocol/frames.js';
import { CONFIG } from '../src/core/config.js';
import { fromHex, toHex } from '../src/core/format.js';

test('frames match the captured hardware session byte for byte', () => {
  assert.equal(toHex(encodeFrame(0x23, [0x01])), '55 55 23 01 01 23 aa aa');
  assert.equal(toHex(encodeFrame(0x21, [0x03])), '55 55 21 01 03 23 aa aa');
  assert.equal(toHex(encodeFrame(0xe3, [0x01])), '55 55 e3 01 01 e3 aa aa');
  assert.equal(toHex(encodeFrame(0xf3, [0x01])), '55 55 f3 01 01 f3 aa aa');
  assert.equal(toHex(encodeFrame(0xa3, [0x01])), '55 55 a3 01 01 a3 aa aa');
  assert.equal(toHex(encodeFrame(0xdc, [0x04])), '55 55 dc 01 04 d9 aa aa');
  assert.equal(toHex(encodeFrame(0x40, [0x08])), '55 55 40 01 08 49 aa aa');
  assert.equal(toHex(encodeFrame(0xaf, [0x01])), '55 55 af 01 01 af aa aa');
  assert.equal(toHex(encodeFrame(0x8e, [0x01])), '55 55 8e 01 01 8e aa aa');
});

test('crc8 is an xor over cmd, length and payload', () => {
  assert.equal(crc8([0x13, 0x0d, 0x01, 0x40, 0x00, 0x60, 0x00, 0x01]), 0x3e);
  assert.equal(crc8([0x40, 0x01, 0x08]), 0x49);
  assert.equal(crc8([0x1b, 0x02, 0x09, 0x10]), 0x00);
});

test('reader reassembles a frame split across chunks', () => {
  const reader = new FrameReader();
  const frame = encodeFrame(0x48, [0x09, 0x10]);
  assert.deepEqual(reader.push(frame.subarray(0, 3)), []);
  assert.deepEqual(reader.push(frame.subarray(3, 5)), []);
  const frames = reader.push(frame.subarray(5));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmd, 0x48);
  assert.deepEqual([...frames[0].data], [0x09, 0x10]);
});

test('reader parses back-to-back frames and skips leading noise', () => {
  const reader = new FrameReader();
  const stream = Uint8Array.from([0x00, 0x55, 0x13, ...encodeFrame(0xe4, [0x01]), ...encodeFrame(0xf4, [0x01])]);
  assert.deepEqual(reader.push(stream).map((frame) => frame.cmd), [0xe4, 0xf4]);
});

test('reader resynchronises after a corrupted checksum', () => {
  const reader = new FrameReader();
  const broken = encodeFrame(0xe4, [0x01]);
  broken[4] ^= 0xff;
  const frames = reader.push(Uint8Array.from([...broken, ...encodeFrame(0xf4, [0x01])]));
  assert.deepEqual(frames.map((frame) => frame.cmd), [0xf4]);
  assert.ok(reader.dropped > 0);
});

test('reader resynchronises past a corrupted length byte', () => {
  const reader = new FrameReader();
  // A length byte of 255 promises 262 bytes; the stream only has 8, so the
  // candidate is incomplete until a complete frame follows it.
  const bogus = Uint8Array.from([0x55, 0x55, 0x85, 0xff, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual(reader.push(bogus), []);
  const frames = reader.push(encodeFrame(0x02, [0x01]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmd, 0x02);
});

test('encodeFrame rejects payload elements that are not bytes', () => {
  assert.throws(() => encodeFrame(0x85, [300]), RangeError);
  assert.throws(() => encodeFrame(0x85, [-1]), RangeError);
  assert.throws(() => encodeFrame(0x85, [1.5]), RangeError);
  assert.throws(() => encodeFrame(0x85, [Number.NaN]), RangeError);
  assert.throws(() => encodeFrame(0x85, ['7']), RangeError);
  assert.equal(encodeFrame(0x85, [0, 255]).length, 9);
});

test('reader ignores empty chunks and a lone 0x55 across chunks', () => {
  const reader = new FrameReader();
  assert.deepEqual(reader.push(new Uint8Array(0)), []);
  assert.deepEqual(reader.push(Uint8Array.from([0x55])), []);
  const frames = reader.push(Uint8Array.from([0x55, ...encodeFrame(0x14, [0x01, 0x00]).subarray(2)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cmd, 0x14);
});

test('a payload wider than the length byte is rejected, not truncated', () => {
  const max = CONFIG.protocol.maxPayloadBytes;
  assert.equal(encodeFrame(0x85, new Array(max).fill(0)).length, max + 7);
  assert.throws(() => encodeFrame(0x85, new Array(max + 1).fill(0)), RangeError);
});

test('real capability reply parses through the reader', () => {
  const reader = new FrameReader();
  const payload = fromHex(
    '01 01 00 02 01 01 03 01 00 04 02 00 c8 05 01 01 06 02 04 00 07 02 05 01 08 02 05 01 09 04 00 00 00 17 0a 02 00 60 0b 02 06 40 0c 01 01 0d 01 02 0e 01 01 0f 01 03 10 01 01 11 02 04 01 12 01 00 13 02 00 00 14 01 03 15 01 00 16 01 00 17 01 01 18 05 01 07 00 00 00 19 01 01'
  );
  const frames = reader.push(encodeFrame(0xbf, [...payload]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.length, 90);
});
