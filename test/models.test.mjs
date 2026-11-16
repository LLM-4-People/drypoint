/**
 * A4: the printer-model table is the single owner of model names and support,
 * the dpi class is the pitch, and the print gate refuses what the app cannot
 * print. Every expectation is table-driven over the vendor catalogue so a
 * wrong entry fails here, not on a printer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/core/config.js';
import { pitchFor } from '../src/core/geometry.js';
import { mergeCapabilities, printBlockReason } from '../src/device/capabilities.js';
import { decodeHeartbeatInfo, decodeModelId } from '../src/protocol/replies.js';
import { MODELS, PRINT_TASKS, modelFor, supportLabel, taskName } from '../src/protocol/models.js';
import { fromHex } from '../src/core/format.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The vendor catalogue this release implements. */
const CATALOGUE = Object.freeze({
  0x0900: ['D110', 'unsupported'],
  0x0910: ['D110_M', 'confirmed'],
  0x0210: ['D11_H', 'experimental'],
  0x0200: ['D11', 'unsupported'],
  0x0202: ['D11S', 'unsupported'],
  0x0213: ['D11_Pro', 'unsupported'],
  0x1000: ['B1', 'unsupported'],
  0x1001: ['B1 Pro', 'unsupported'],
  0x1002: ['B1 SE', 'unsupported'],
  0x1b00: ['B2 Pro', 'unsupported'],
  0x1b01: ['B2', 'unsupported'],
  0x0300: ['B21', 'unsupported'],
  0x0309: ['B21S', 'unsupported'],
  0x0311: ['B21 Pro', 'unsupported'],
  0x0901: ['D110 / Hi-D110', 'unsupported'],
});

/** A merged D110_M with reported geometry: the printable reference path. */
function printable(overrides = {}) {
  const caps = overrides.capabilities === undefined ? { dpi: 200, headWidthPx: 96 } : overrides.capabilities;
  const heartbeat = overrides.heartbeat === undefined ? { headWidthPx: 96, dpi: 203 } : overrides.heartbeat;
  const info = {
    deviceType: 0x0910,
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
    ...(overrides.info ?? {}),
  };
  return mergeCapabilities({ capabilities: caps, heartbeat, info });
}

test('the model table matches the vendor catalogue exactly', () => {
  assert.equal(MODELS.length, Object.keys(CATALOGUE).length);
  assert.equal(new Set(MODELS.map((entry) => entry.code)).size, MODELS.length, 'no duplicate id');
  for (const entry of MODELS) {
    const expected = CATALOGUE[entry.code];
    assert.ok(expected, `0x${entry.code.toString(16)} is a known vendor id`);
    assert.equal(entry.name, expected[0], `0x${entry.code.toString(16)} name`);
    assert.equal(entry.support, expected[1], `0x${entry.code.toString(16)} support`);
    assert.equal(entry.task, 'd110mv4', 'every entry names the one implemented task');
  }
  for (const code of Object.keys(CATALOGUE).map(Number)) {
    assert.ok(MODELS.some((entry) => entry.code === code), `0x${code.toString(16)} is in the table`);
  }
  assert.deepEqual(Object.keys(PRINT_TASKS), ['d110mv4'], 'only one print task exists');
  assert.equal(taskName('d110mv4'), 'D110M V4', 'the task is named by behaviour');
  assert.equal(taskName('unknown'), null);
});

test('only D110_M is confirmed and only D11_H is experimental', () => {
  assert.deepEqual(
    MODELS.filter((entry) => entry.support === 'confirmed').map((entry) => entry.name),
    ['D110_M']
  );
  assert.deepEqual(
    MODELS.filter((entry) => entry.support === 'experimental').map((entry) => entry.name),
    ['D11_H']
  );
  assert.equal(MODELS.filter((entry) => entry.support === 'unsupported').length, 13);
});

test('the one-byte model reply still resolves the high-byte id', () => {
  assert.equal(decodeModelId(fromHex('09')).model, 'D110');
  assert.equal(decodeModelId(fromHex('')).model, null, 'an empty reply is not an identity');
});

test('the operator support words are one translation', () => {
  assert.equal(supportLabel('confirmed'), 'tested');
  assert.equal(supportLabel('experimental'), 'experimental');
  assert.equal(supportLabel('unsupported'), 'not supported');
  assert.equal(supportLabel('unknown'), 'unknown');
  assert.equal(supportLabel(null), 'unknown');
});

test('modelFor reports every code, and never invents a model', () => {
  for (const entry of MODELS) {
    const resolved = modelFor(entry.code);
    assert.equal(resolved.name, entry.name);
    assert.equal(resolved.support, entry.support);
    assert.equal(resolved.task, 'd110mv4');
  }
  for (const hostile of [0x1234, 0, 0xffff, -1, 1.5, Number.NaN, '0x0910', {}, [], null, undefined]) {
    const resolved = modelFor(hostile);
    assert.equal(resolved.name, 'Unknown', `${String(hostile)} is unknown`);
    assert.equal(resolved.support, 'unknown');
    assert.equal(resolved.task, null);
  }
});

test('the heartbeat dpi class maps 2 and 3 and leaves every other class unknown', () => {
  const frame = (dpiClass) => {
    const bytes = fromHex('04 01 04 17 00 60 02 02 01 00');
    bytes[6] = dpiClass;
    return decodeHeartbeatInfo(bytes);
  };
  assert.equal(frame(2).dpi, 203);
  assert.equal(frame(3).dpi, 300);
  for (const unknown of [0, 1, 4, 0xff]) assert.equal(frame(unknown).dpi, null, `class ${unknown} is unknown`);
  assert.equal(frame(2).dpiClass, 2, 'the raw class stays inspectable');
});

test('the dot pitch is dpi / 25.4, not the head over a presumed 12 mm tape', () => {
  assert.ok(Math.abs(pitchFor({ dpi: 203 }) - 203 / 25.4) < 1e-9);
  assert.ok(Math.abs(pitchFor({ dpi: 300 }) - 300 / 25.4) < 1e-9);
  assert.ok(Math.abs(pitchFor({ dpi: 300 }) - 11.81) < 0.005, '144 dots at 300 dpi is 11.81 dots/mm, not 12');
  assert.ok(
    Math.abs(pitchFor({ headWidthPx: 144, dpi: 300 }) - 11.81) < 0.005,
    'a head width never overrides the reported dpi class'
  );
  assert.equal(pitchFor({}), CONFIG.geometry.dotsPerMm);
  assert.equal(pitchFor({ dpi: 0 }), CONFIG.geometry.dotsPerMm);
  assert.equal(pitchFor({ dpi: Number.NaN }), CONFIG.geometry.dotsPerMm);
});

test('the capability TLV dpi wins over the heartbeat class, and the class is the fallback', () => {
  const fromTlv = mergeCapabilities({ capabilities: { dpi: 200 }, heartbeat: { dpi: 203 } });
  assert.equal(fromTlv.dpi, 200);
  const fromHeartbeat = mergeCapabilities({ heartbeat: { dpi: 203 } });
  assert.equal(fromHeartbeat.dpi, 203);
  const kept = mergeCapabilities({ previous: { ...fromTlv, dpi: 200 } });
  assert.equal(kept.dpi, 200, 'an unanswered probe keeps the session value');
});

test('the gate blocks an unsupported model with its real name and sends nothing', () => {
  for (const [code, name] of [
    [0x1000, 'B1'],
    [0x0900, 'D110'],
    [0x0210, 'D11_H'],
  ]) {
    const entry = modelFor(code);
    const merged = printable({
      info: { deviceType: code, model: entry.name, modelSupport: entry.support, task: entry.task },
    });
    if (entry.support === 'experimental') {
      assert.equal(printBlockReason(merged), null, 'experimental is allowed');
      continue;
    }
    const reason = printBlockReason(merged);
    assert.ok(reason, `${name} is blocked`);
    assert.match(reason, new RegExp(`${name} is not supported`));
    assert.equal(reason.endsWith(CONFIG.device.printGate.unsupported), true, 'the one configured reason is quoted');
    assert.match(reason, /nothing was sent/);
  }
});

test('the gate blocks an unknown model and a guessed head width', () => {
  assert.equal(printBlockReason(null), CONFIG.device.printGate.unknownModel);
  assert.equal(printBlockReason({}), CONFIG.device.printGate.unknownModel);
  assert.equal(
    printBlockReason({ model: 'Printer', modelSupport: 'unknown', source: { geometry: 'reported' } }),
    CONFIG.device.printGate.unknownModel
  );
  assert.equal(
    printBlockReason({ model: 'D110_M', modelSupport: 'confirmed', source: { geometry: 'default' } }),
    CONFIG.device.printGate.guessedGeometry
  );
});

test('a 0 or 65535 head report is not geometry and blocks as a guess', () => {
  for (const head of [0, 0xffff]) {
    const heartbeat = { headWidthPx: head, dpi: 203 };
    const merged = printable({ capabilities: { headWidthPx: head, dpi: 200 }, heartbeat });
    assert.equal(merged.source.geometry, 'default', `${head}: a malformed head is not a report`);
    assert.equal(merged.headWidthPx, CONFIG.geometry.widthPx, `${head}: the fallback width is used`);
    assert.equal(printBlockReason(merged), CONFIG.device.printGate.guessedGeometry);
  }
});

test('the gate allows the D110_M reference path and D11_H experimental', () => {
  assert.equal(printBlockReason(printable()), null);
  const experimental = printable({
    info: { deviceType: 0x0210, model: 'D11_H', modelSupport: 'experimental' },
  });
  assert.equal(printBlockReason(experimental), null);
});

test('hostile capability shapes block without throwing', () => {
  const hostile = [
    null,
    undefined,
    {},
    { model: 'X' },
    { model: 42, modelSupport: 'confirmed', source: { geometry: 'reported' } },
    { model: 'X', modelSupport: 'unsupported' },
    { model: 'X', modelSupport: 'unknown', source: null },
    { model: 'X', modelSupport: 'confirmed', source: { geometry: 'reported' }, sensors: 7, battery: 'x' },
  ];
  for (const value of hostile) {
    let reason;
    assert.doesNotThrow(() => {
      reason = printBlockReason(value);
    }, JSON.stringify(value));
    assert.equal(typeof reason === 'string' || reason === null, true);
  }
});

test('the UI and the app never call the sequence V5', () => {
  for (const file of ['src/protocol/models.js', 'src/device/capabilities.js', 'src/ui/print-panel.js']) {
    assert.doesNotMatch(read(file), /\bV5\b/, `${file} names the task by behaviour`);
  }
});
