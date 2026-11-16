import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHeartbeatSample,
  autoShutdownOptions,
  CAPABILITY_GROUP_LABELS,
  capabilityState,
  clampToRange,
  clearVolatileCapabilities,
  emptyCapabilities,
  mergeCapabilities,
  printBlockReason,
  supportGate,
} from '../src/device/capabilities.js';
import { decodeCapabilities } from '../src/protocol/replies.js';
import { geometry, mmToPx, resetGeometry, setGeometry } from '../src/core/geometry.js';
import { CONFIG } from '../src/core/config.js';
import { fromHex } from '../src/core/format.js';
import { FIXTURE_SERIAL, ROLL_BARCODE } from './fixtures/captured-unit.mjs';

const capabilities = {
  dpi: 200,
  densityRange: { min: 1, max: 5 },
  labelTypes: [1, 2, 3, 5],
  headWidthPx: 96,
  maxPrintHeightPx: 1600,
  autoShutdownRange: { min: 1, max: 4 },
  hasRtc: true,
  hasVolume: true,
  hasCutter: false,
  rfidRead: null,
};

/** A merged D110_M with reported geometry: the printable baseline the gate accepts. */
function printable({ capabilities: caps = capabilities, heartbeat = { headWidthPx: 96, dpi: 203 }, info = {} } = {}) {
  return mergeCapabilities({
    capabilities: caps,
    heartbeat,
    info: { deviceType: 0x0910, model: 'D110_M', modelSupport: 'confirmed', task: 'd110mv4', ...info },
  });
}

test('absent TLV booleans fall through to the heartbeat instead of reading as false', () => {
  const merged = mergeCapabilities({
    capabilities,
    heartbeat: { rfidRead: true, rfidWrite: false, headWidthPx: 96 },
    info: {},
  });
  assert.equal(merged.rfid.read, true);
  assert.equal(merged.hasRtc, true);
  assert.equal(merged.hasVolume, true);
  assert.equal(merged.hasCutter, false);
});

test('a colour or gray TLV never enters the merged capability model', () => {
  // One output: black dots. The raw TLVs stay inspectable in the 0xBF
  // diagnostic, but no merged field may suggest a colour control exists.
  const merged = mergeCapabilities({ capabilities: { supportsColor: true, supportsGray: true } });
  for (const field of ['supportsColor', 'supportsGray']) {
    assert.ok(!(field in merged), `${field} is not a capability field`);
  }
  for (const group of ['color', 'gray']) {
    assert.equal(merged.source[group], undefined, `${group} is not a source group`);
  }
  assert.equal(CAPABILITY_GROUP_LABELS.color, undefined);
  assert.equal(CAPABILITY_GROUP_LABELS.gray, undefined);
});

test('GetInfo values are merged into the capability model', () => {
  const merged = mergeCapabilities({
    capabilities,
    info: {
      density: 4,
      labelType: 5,
      autoShutdown: 3,
      batteryLevel: 3,
      batteryPercent: 75,
    },
  });
  assert.equal(merged.density, 4);
  assert.equal(merged.labelType, 5);
  assert.equal(merged.autoShutdown, 3);
  assert.deepEqual(merged.battery, { percent: 75, level: 3 });
  assert.equal(merged.source.battery, 'reported');
  assert.equal(merged.source.autoShutdown, 'reported');
});

test('heartbeat advanced wins over GetInfo for battery and sensors', () => {
  const merged = mergeCapabilities({
    capabilities,
    advanced: { batteryPercent: 50, batteryLevel: 2, voltageMv: 3900, temperatureRaw: 30, lidClosed: true, paperPresent: true, rfidOk: true },
    info: { batteryPercent: 75, batteryLevel: 3 },
  });
  assert.equal(merged.battery.percent, 50);
  assert.equal(merged.battery.voltageMv, 3900);
  assert.deepEqual(merged.sensors, { lidClosed: true, paperPresent: true, rfidOk: true });
  assert.equal(merged.source.sensors, 'reported');
});

test('defaulted capability groups are marked as guesses', () => {
  const merged = mergeCapabilities({ capabilities: { headWidthPx: 96 } });
  assert.equal(merged.source.geometry, 'reported');
  assert.equal(merged.source.density, 'default');
  assert.equal(merged.source.battery, 'default');
  assert.equal(merged.source.rtc, 'default');

  const empty = emptyCapabilities();
  assert.ok(Object.values(empty.source).every((source) => source === 'default'));
});

test('geometry is "reported" only when the head width itself was reported', () => {
  // A zero dpi, a truncated TLV, a lone max-print-height or a dpi without a
  // head width are not a head measurement: the gate must still call the 96-dot
  // fallback a guess.
  for (const caps of [{ dpi: 0 }, { dpi: null, headWidthPx: null }, { maxPrintHeightPx: 1600 }, { dpi: 200 }, {}]) {
    const merged = mergeCapabilities({ capabilities: caps });
    assert.equal(merged.source.geometry, 'default', `${JSON.stringify(caps)} is not reported geometry`);
  }
  assert.equal(mergeCapabilities({ capabilities: { dpi: 200, headWidthPx: 96 } }).source.geometry, 'reported');
  assert.equal(mergeCapabilities({ capabilities: { headWidthPx: 96 } }).source.geometry, 'reported');
  assert.equal(mergeCapabilities({ heartbeat: { headWidthPx: 96 } }).source.geometry, 'reported');

  // A silent discovery keeps the same session's earlier report.
  const prior = mergeCapabilities({ capabilities: { headWidthPx: 96 } });
  assert.equal(mergeCapabilities({ previous: prior, advanced: {} }).source.geometry, 'reported');
});

test('a truncated max-print-height TLV never shortens the label limit', () => {
  // 0b 01 06 used to decode as 1536 px = 192 mm and clamp a 200 mm label.
  const truncated = mergeCapabilities({ capabilities: decodeCapabilities(fromHex('0b 01 06')) });
  assert.equal(truncated.maxLengthMm, CONFIG.geometry.maxLengthMm);
});

test('device max length uses the reported dpi pitch', () => {
  const merged = mergeCapabilities({ capabilities: { dpi: 200, headWidthPx: 96, maxPrintHeightPx: 800 } });
  // 800 dots / (200/25.4) dots per mm = 101 mm, below the configured ceiling.
  assert.equal(merged.maxLengthMm, 101);
  const unlimited = mergeCapabilities({ capabilities: { dpi: 200, headWidthPx: 96, maxPrintHeightPx: 1600 } });
  assert.equal(unlimited.maxLengthMm, CONFIG.geometry.maxLengthMm);
});

test('clampToRange falls back for absent ranges and non-finite values', () => {
  assert.equal(clampToRange(Number.NaN, null, 3), 3);
  assert.equal(clampToRange(undefined, null, 3), 3);
  assert.equal(clampToRange(Number.NaN, { min: 1, max: 5 }, 3), 3);
  assert.equal(clampToRange(9, { min: 1, max: 5 }, 3), 5);
  assert.equal(clampToRange(0, { min: 1, max: 5 }, 3), 1);
  assert.equal(clampToRange(4, null, 3), 4);
});

test('auto power-off options come from the reported range', () => {
  assert.deepEqual(autoShutdownOptions({ autoShutdownRange: { min: 1, max: 4 } }), [
    ['1', 'Shortest'],
    ['2', 'Short'],
    ['3', 'Long'],
    ['4', 'Longest'],
  ]);
  assert.deepEqual(autoShutdownOptions({ autoShutdownRange: { min: 2, max: 3 } }), [
    ['2', 'Short'],
    ['3', 'Long'],
  ]);
  assert.equal(autoShutdownOptions({}).length, Object.keys(CONFIG.device.autoShutdownLabels).length);
});

test('auto power-off options always include the value the printer reports', () => {
  assert.deepEqual(autoShutdownOptions({ autoShutdownRange: { min: 1, max: 3 }, autoShutdown: 4 }).at(-1), ['4', 'Longest']);
  assert.deepEqual(autoShutdownOptions({ autoShutdownRange: { min: 1, max: 3 }, autoShutdown: 2 }), [
    ['1', 'Shortest'],
    ['2', 'Short'],
    ['3', 'Long'],
  ]);
});

test('printing is blocked by sensors and by a critical battery only when reported', () => {
  const base = printable();
  assert.equal(printBlockReason(base), null);
  assert.equal(printBlockReason({ ...base, sensors: { lidClosed: true, paperPresent: true } }), null);
  assert.match(printBlockReason({ ...base, sensors: { lidClosed: false, paperPresent: true } }), /lid/i);
  assert.match(printBlockReason({ ...base, sensors: { lidClosed: true, paperPresent: false } }), /roll|paper/i);
  assert.match(printBlockReason({ ...base, battery: { percent: 5 } }), /Battery is too low/);
  assert.equal(printBlockReason({ ...base, battery: { percent: 50 } }), null);
});

test('a sample without boolean sensor flags builds no sensors and blocks nothing', () => {
  const merged = mergeCapabilities({
    advanced: { batteryPercent: 75, batteryLevel: 3 },
    capabilities,
    info: { deviceType: 0x0910, model: 'D110_M', modelSupport: 'confirmed', task: 'd110mv4' },
  });
  assert.equal(merged.sensors, null, 'no lid/paper flags means no sensor claim');
  assert.equal(merged.source.sensors, 'default');
  assert.equal(printBlockReason(merged), null, 'an unreported lid must not block printing');

  const empty = mergeCapabilities({ advanced: {} });
  assert.equal(empty.sensors, null);
});

test('unreported feature booleans stay null instead of becoming false', () => {
  const merged = mergeCapabilities({});
  assert.equal(merged.hasRtc, null);
  assert.equal(merged.hasVolume, null);
  assert.equal(merged.hasCutter, null);
  assert.equal(merged.rfid.read, null, 'never reported is not "not supported"');
  assert.equal(merged.rfid.write, null);
  assert.equal(merged.source.rtc, 'default');
  assert.equal(merged.source.cutter, 'default');

  const empty = emptyCapabilities();
  assert.equal(empty.hasRtc, null);
  assert.equal(empty.hasVolume, null);
  assert.equal(empty.hasCutter, null);
});

test('a reported boolean has three distinct states', () => {
  assert.equal(capabilityState(true), 'reported-yes');
  assert.equal(capabilityState(false), 'reported-no');
  assert.equal(capabilityState(null), 'not-reported');
  assert.equal(capabilityState(undefined), 'not-reported');
});

test('a fresh heartbeat sample updates sensors and battery only when reported', () => {
  const base = mergeCapabilities({
    capabilities,
    advanced: { lidClosed: true, paperPresent: true, batteryPercent: 100, batteryLevel: 4, rfidOk: true },
  });
  const fresher = applyHeartbeatSample(base, {
    lidClosed: false,
    paperPresent: true,
    batteryPercent: 25,
    batteryLevel: 1,
    rfidOk: true,
  });
  assert.equal(fresher.sensors.lidClosed, false);
  assert.equal(fresher.battery.percent, 25);
  assert.equal(applyHeartbeatSample(base, null), base, 'an unanswered heartbeat keeps the model');

  const partial = applyHeartbeatSample(base, { batteryPercent: 50 });
  assert.equal(partial.sensors, base.sensors, 'a sample without flags cannot overwrite sensors');
  assert.equal(partial.battery.percent, 50);
});

test('clampToRange refuses a range that is not two finite numbers', () => {
  assert.equal(clampToRange(4, { max: 5 }, 3), 3);
  assert.equal(clampToRange(4, { min: Number.NaN, max: 5 }, 3), 3);
  assert.equal(clampToRange(4, { min: 1, max: Number.POSITIVE_INFINITY }, 3), 3);
  assert.equal(clampToRange(Number.NaN, { min: 1, max: 5 }, 3), 3);
  assert.equal(clampToRange(4, { min: 1, max: 5 }, 3), 4);
});

test('a group this discovery did not report falls through to the same session', () => {
  const previous = mergeCapabilities({
    capabilities,
    info: { density: 4, labelType: 5, autoShutdown: 3 },
    heartbeat: { softwareVersion: 4.23, headWidthPx: 96 },
    roll: { barcode: ROLL_BARCODE, remaining: 117 },
  });
  // The next pass answers nothing but the printer's own heartbeat.
  const refreshed = mergeCapabilities({ heartbeat: { softwareVersion: 4.23, headWidthPx: 96 }, previous });

  assert.equal(refreshed.hasVolume, true, 'volume is not forgotten by a silent TLV');
  assert.equal(refreshed.hasRtc, true);
  assert.equal(refreshed.hasCutter, false, 'a reported "no" survives too');
  assert.equal(refreshed.source.volume, 'reported');
  assert.equal(refreshed.density, 4);
  assert.equal(refreshed.labelType, 5);
  assert.equal(refreshed.autoShutdown, 3);
  assert.equal(refreshed.roll.barcode, ROLL_BARCODE);
  assert.deepEqual(refreshed.labelTypes, [1, 2, 3, 5], 'the label mask survives');
});

test('a reported device maximum length is not reset to the configured cap', () => {
  const previous = mergeCapabilities({ capabilities: { dpi: 200, headWidthPx: 96, maxPrintHeightPx: 800 } });
  assert.equal(previous.maxLengthMm, 101);
  const refreshed = mergeCapabilities({ heartbeat: { headWidthPx: 96 }, previous });
  assert.equal(refreshed.maxLengthMm, 101, 'an unanswered geometry TLV keeps the reported limit');
  const reported = mergeCapabilities({ capabilities: { dpi: 200, headWidthPx: 96, maxPrintHeightPx: 1600 }, previous });
  assert.equal(reported.maxLengthMm, 200, 'a reported maximum still wins over the previous value');
  assert.equal(mergeCapabilities({}).maxLengthMm, CONFIG.geometry.maxLengthMm, 'a fresh model keeps the default');
});

test('a fresh model never inherits a previous session’s groups', () => {
  const previous = mergeCapabilities({ capabilities, info: { density: 4 } });
  const fresh = mergeCapabilities({ heartbeat: { headWidthPx: 96 } });
  assert.equal(fresh.hasVolume, null);
  assert.equal(fresh.density, null);
  assert.equal(fresh.maxLengthMm, CONFIG.geometry.maxLengthMm);
  assert.equal(previous.hasVolume, true, 'the previous model itself is unchanged');
});

test('volatile readings are cleared when the link ends, identity and features stay', () => {
  const live = mergeCapabilities({
    capabilities,
    advanced: { lidClosed: true, paperPresent: true, batteryPercent: 100, batteryLevel: 4 },
    info: { model: 'D110_M', serial: FIXTURE_SERIAL, density: 3, labelType: 1 },
    heartbeat: { softwareVersion: 4.23, hardwareVersion: 4.01, rfidRead: true },
    roll: { barcode: ROLL_BARCODE, remaining: 117 },
  });
  const cleared = clearVolatileCapabilities(live);
  assert.equal(cleared.battery, null);
  assert.equal(cleared.sensors, null);
  assert.equal(cleared.roll, null);
  assert.equal(cleared.source.battery, 'default');
  assert.equal(cleared.source.sensors, 'default');
  assert.equal(cleared.source.rfid, 'default');
  assert.equal(cleared.model, 'D110_M');
  assert.equal(cleared.serial, FIXTURE_SERIAL);
  assert.equal(cleared.firmware, 4.23);
  assert.equal(cleared.labelType, 1);
  assert.equal(cleared.density, 3);
  assert.equal(cleared.hasVolume, true);
  assert.equal(cleared.maxLengthMm, live.maxLengthMm);
  assert.equal(live.battery.percent, 100, 'the input model is not mutated');
});

test('the battery gate blocks at the documented 15% boundary and allows 16%', () => {
  assert.equal(CONFIG.device.battery.criticalPercent, 15);
  const base = printable();
  assert.equal(printBlockReason({ ...base, battery: { percent: 15 } }), 'Battery is too low to print (15%); nothing was printed.');
  assert.equal(printBlockReason({ ...base, battery: { percent: 16 } }), null);
  assert.equal(printBlockReason({ ...base, battery: { percent: 0 } }), 'Battery is too low to print (0%); nothing was printed.');
});

test('the support gate is the one owner of allowed, reason and kind', () => {
  const base = printable();
  assert.deepEqual(supportGate(base), { allowed: true, reason: null, kind: null });
  assert.deepEqual(supportGate(null), { allowed: false, reason: CONFIG.device.printGate.unknownModel, kind: 'model' });

  const cases = [
    ['unsupported model', printable({ info: { deviceType: 0x1000, model: 'B1', modelSupport: 'unsupported', task: 'd110mv4' } }), 'model'],
    ['unknown model', { ...base, model: null, modelSupport: 'unknown' }, 'model'],
    ['guessed head', { ...base, source: { ...base.source, geometry: 'default' } }, 'geometry'],
    ['lid open', { ...base, sensors: { lidClosed: false, paperPresent: true } }, 'sensor'],
    ['no paper', { ...base, sensors: { lidClosed: true, paperPresent: false } }, 'sensor'],
    ['critical battery', { ...base, battery: { percent: 5 } }, 'sensor'],
  ];
  for (const [label, capabilities, kind] of cases) {
    const gate = supportGate(capabilities);
    assert.equal(gate.allowed, false, label);
    assert.equal(gate.kind, kind, label);
    assert.equal(typeof gate.reason, 'string', label);
    assert.ok(gate.reason.length > 0, label);
    assert.equal(printBlockReason(capabilities), gate.reason, `${label}: the print answer is the gate's reason`);
  }

  // A sensor prerequisite is scoped to paper-moving commands. A configuration
  // write on a printer with the lid open is still model- and geometry-eligible.
  const lidOpen = { ...base, sensors: { lidClosed: false, paperPresent: true } };
  assert.deepEqual(supportGate(lidOpen, { requiresPaper: false }), { allowed: true, reason: null, kind: null });
  assert.equal(printBlockReason(lidOpen), supportGate(lidOpen).reason, 'printing always asks for the paper prerequisites');
  for (const reason of [supportGate(lidOpen).reason, supportGate({ ...base, battery: { percent: 5 } }).reason]) {
    assert.match(reason, /nothing was printed/, 'a sensor refusal never claims nothing was sent');
    assert.doesNotMatch(reason, /nothing was sent/);
  }
});

test('a reported dpi above 600 is absent, makes geometry a guess and blocks printing', (t) => {
  t.after(resetGeometry);
  const info = { deviceType: 0x0910, model: 'D110_M', modelSupport: 'confirmed', task: 'd110mv4' };
  for (const dpi of [65535, 0, Number.NaN, 601]) {
    const merged = mergeCapabilities({ capabilities: { dpi, headWidthPx: 96 }, heartbeat: { headWidthPx: 96 }, info });
    assert.equal(merged.dpi, null, `${dpi} is not a resolution`);
    assert.equal(merged.source.geometry, 'default', `${dpi}: geometry is not reported`);
    assert.equal(printBlockReason(merged), CONFIG.device.printGate.guessedGeometry, `${dpi} blocks printing`);

    setGeometry(merged);
    assert.equal(geometry().dotsPerMm, CONFIG.geometry.dotsPerMm, `${dpi}: no hostile pitch reaches geometry`);
    assert.equal(mmToPx(CONFIG.geometry.maxLengthMm), CONFIG.geometry.maxLengthMm * CONFIG.geometry.dotsPerMm);
  }
  resetGeometry();

  for (const dpi of [600, 203]) {
    const merged = mergeCapabilities({ capabilities: { dpi, headWidthPx: 96 }, heartbeat: { headWidthPx: 96 }, info });
    assert.equal(merged.dpi, dpi, `${dpi} is usable`);
    assert.equal(merged.source.geometry, 'reported');
    assert.equal(printBlockReason(merged), null);
    setGeometry(merged);
    assert.ok(Math.abs(geometry().dotsPerMm - dpi / 25.4) < 1e-9);
  }
  resetGeometry();
});
