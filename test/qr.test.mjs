import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { QR_MAX_BYTES, QR_MIN_MODULE_PX, QR_QUIET_MODULES, qrFits, qrLayout, qrMatrix } from '../src/label/qr.js';

// Load the real vendored generator the same way the browser does: as a script
// with a CommonJS-style export, not as an ES module.
const source = readFileSync(new URL('../src/vendor/qrcode.js', import.meta.url), 'utf8');
const context = { exports: {}, module: { exports: {} } };
vm.runInNewContext(source, context);
const vendor = context.module.exports;
globalThis.qrcode = vendor;

test('the vendored encoder produces UTF-8 bytes for accented text and emoji', () => {
  const utf8 = vendor.stringToBytesFuncs['UTF-8'];
  assert.deepEqual([...utf8('café')], [0x63, 0x61, 0x66, 0xc3, 0xa9]);
  assert.deepEqual([...utf8('😀')], [0xf0, 0x9f, 0x98, 0x80]);
});

test('qrMatrix installs UTF-8 before generating', () => {
  qrMatrix('café');
  assert.equal(vendor.stringToBytes, vendor.stringToBytesFuncs['UTF-8']);
  assert.deepEqual([...vendor.stringToBytes('café')], [0x63, 0x61, 0x66, 0xc3, 0xa9]);
  const emoji = qrMatrix('😀');
  assert.ok(emoji.count > 0);
});

test('qrMatrix rejects empty content', () => {
  assert.throws(() => qrMatrix(''), /empty/);
  assert.throws(() => qrMatrix('   '), /empty/);
  assert.throws(() => qrMatrix(null), /empty/);
});

test('qrMatrix tolerates an unknown correction level by falling back to M', () => {
  const matrix = qrMatrix('https://example.com', 'Z');
  assert.ok(matrix.count > 0);
  assert.equal(typeof matrix.isDark(0, 0), 'boolean');
});

test('qrLayout reserves a four-module quiet zone and needs two dots per module', () => {
  const count = 25;
  const size = 88;
  const layout = qrLayout(size, count);
  assert.equal(layout.modulePx, Math.floor(size / (count + QR_QUIET_MODULES * 2)));
  assert.equal(layout.quietPx, layout.modulePx * QR_QUIET_MODULES);
  assert.equal(layout.drawnPx, layout.modulePx * count);
  assert.ok(layout.drawnPx + layout.quietPx * 2 <= size);
  assert.equal(layout.fits, layout.modulePx >= QR_MIN_MODULE_PX);

  const cramped = qrLayout(40, count);
  assert.equal(cramped.modulePx, 1);
  assert.equal(cramped.fits, false);
  assert.equal(qrFits('https://example.com', 'M', 40), false);
});

test('qrMatrix refuses an over-capacity value before constructing the encoder', () => {
  // Version 40, EC M, byte mode holds 2331 bytes. The bound is checked from the
  // UTF-8 length, so a 5 MB paste costs a byte count instead of a full encode.
  assert.equal(QR_MAX_BYTES, 2331);
  const started = Date.now();
  assert.throws(() => qrMatrix('A'.repeat(QR_MAX_BYTES + 1)), /QR content is too long: 2332 bytes, the largest symbol holds 2331/);
  assert.ok(Date.now() - started < 100, 'the refusal is immediate');
  // Multi-byte text counts bytes, not UTF-16 units: 1200 emoji are 4800 bytes.
  assert.throws(() => qrMatrix('😀'.repeat(1200)), /4800 bytes/);
  // At the cap the real encoder still runs.
  assert.ok(qrMatrix('A'.repeat(QR_MAX_BYTES)).count > 0);
});
