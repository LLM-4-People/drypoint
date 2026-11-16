import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMac, sleep, toHex } from '../src/core/format.js';
import { u16be } from '../src/protocol/frames.js';
import {
  FIXTURE_BLUETOOTH_ADDRESS,
  FIXTURE_BLUETOOTH_BYTES,
} from './fixtures/captured-unit.mjs';
import { listProjectFiles, readProjectFile } from './helpers/project-files.mjs';

const sources = listProjectFiles('src').filter((file) => file.endsWith('.js'));
const sourceText = Object.fromEntries(sources.map((file) => [file, readProjectFile(file)]));
const count = (pattern) => sources.reduce((total, file) => total + [...sourceText[file].matchAll(pattern)].length, 0);
const filesMatching = (pattern) => sources.filter((file) => pattern.test(sourceText[file]));
const importsFrom = (file, name, module) =>
  new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '${module}'`).test(sourceText[file]);

test('u16be emits the two big-endian payload bytes', () => {
  assert.deepEqual(u16be(0x0000), [0x00, 0x00]);
  assert.deepEqual(u16be(0x0001), [0x00, 0x01]);
  assert.deepEqual(u16be(0x0140), [0x01, 0x40]);
  assert.deepEqual(u16be(0x1234), [0x12, 0x34]);
  assert.deepEqual(u16be(0xffff), [0xff, 0xff]);
});

test('formatMac is the colon form of the shared hex formatter', () => {
  const bytes = Uint8Array.from(FIXTURE_BLUETOOTH_BYTES);
  assert.equal(toHex(bytes), FIXTURE_BLUETOOTH_ADDRESS.replaceAll(':', ' '));
  assert.equal(formatMac(bytes), FIXTURE_BLUETOOTH_ADDRESS);
  assert.equal(formatMac([0x01, 0x66]), '01:66');
  assert.equal(formatMac([]), '');
});

test('sleep defers to a timer turn instead of running inline', async () => {
  const order = [];
  const pending = sleep(0).then(() => order.push('timer'));
  order.push('sync');
  await pending;
  assert.deepEqual(order, ['sync', 'timer']);
});

test('u16be has exactly one definition and both encoders import it', () => {
  assert.equal(count(/\bfunction\s+u16be\s*\(/g), 1, 'one u16be definition');
  assert.equal(count(/\bconst\s+u16be\s*=/g), 0, 'no second assignment form');
  assert.deepEqual(filesMatching(/\bfunction\s+u16be\s*\(/), ['src/protocol/frames.js']);

  // The reply decoder reads at an offset and is deliberately a different
  // helper; nothing else may keep an encoder copy.
  assert.equal(count(/\b(?:const|function)\s+u16\b/g), 1, 'only the reply decoder keeps u16');
  assert.deepEqual(filesMatching(/\b(?:const|function)\s+u16\b/), ['src/protocol/replies.js']);
  assert.match(sourceText['src/protocol/replies.js'], /function u16\(data, offset\)/);

  for (const file of ['src/protocol/commands.js', 'src/device/print-job.js']) {
    assert.ok(importsFrom(file, 'u16be', "[^']*frames\\.js"), `${file} imports u16be`);
    assert.doesNotMatch(sourceText[file], /\b(?:const|function)\s+u16\b/, `${file} keeps no copy`);
  }
});

test('sleep has exactly one definition and every pacing caller imports it', () => {
  assert.equal(count(/\bfunction\s+sleep\s*\(/g), 1, 'one sleep definition');
  assert.equal(count(/\bconst\s+sleep\s*=/g), 0, 'no second assignment form');
  assert.deepEqual(filesMatching(/\bfunction\s+sleep\s*\(|\bconst\s+sleep\s*=/), ['src/core/format.js']);

  for (const file of ['src/device/print-job.js', 'src/device/transports/ble.js', 'src/device/transports/android.js']) {
    assert.ok(importsFrom(file, 'sleep', "[^']*core/format\\.js"), `${file} imports sleep`);
    assert.doesNotMatch(sourceText[file], /\b(?:const|function)\s+sleep\b/, `${file} keeps no copy`);
  }
});

test('formatMac has exactly one definition and replies uses it', () => {
  assert.equal(count(/\bfunction\s+formatMac\s*\(/g), 1, 'one formatMac definition');
  assert.deepEqual(filesMatching(/\bfunction\s+formatMac\s*\(/), ['src/core/format.js']);
  assert.equal(count(/padStart\(2, '0'\)\)\.join\(':'\)/g), 0, 'no second MAC formatter');

  assert.ok(importsFrom('src/protocol/replies.js', 'formatMac', '\\.\\./core/format\\.js'), 'replies imports formatMac');
  assert.match(sourceText['src/protocol/replies.js'], /bluetoothAddress:\s*formatMac\(data\.subarray\(0, 6\)\)/);
  // errors.js formats an error code, not a MAC: it keeps its own fallback.
  assert.doesNotMatch(sourceText['src/protocol/errors.js'], /formatMac/);
});
