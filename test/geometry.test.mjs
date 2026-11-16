import test from 'node:test';
import assert from 'node:assert/strict';

import { blockTop, fitFontSize, layoutText, lineAnchor, splitLines } from '../src/label/text-layout.js';
import { clampElement, createDocument, defaultTextFrame, documentHeightPx, documentWidthPx, migrateDocument, validateDocument } from '../src/label/schema.js';
import { resolvePrintOptions, resolveRenderOptions, JOB_SPEED } from '../src/device/print-options.js';
import { buildCommand } from '../src/protocol/commands.js';
import { atkinson, floydSteinberg, thresholdGray, toGray } from '../src/label/dither.js';
import { code128Modules, validateBarcode } from '../src/label/barcode.js';
import { CONFIG } from '../src/core/config.js';

const measure = (text, size) => text.length * size * 0.55;

test('fitFontSize grows until the text no longer fits', () => {
  const size = fitFontSize({ lines: ['Hello'], boxW: 200, boxH: 40, measure, max: 44 });
  assert.ok(measure('Hello', size) <= 200);
  assert.ok(size <= 44);
  const bigger = fitFontSize({ lines: ['Hello'], boxW: 400, boxH: 90, measure, max: 44 });
  assert.ok(bigger >= size);
});

test('fitFontSize clamps to the minimum when nothing fits', () => {
  const size = fitFontSize({ lines: ['a very long line of text'], boxW: 10, boxH: 10, measure, min: 7, max: 44 });
  assert.equal(size, 7);
});

test('layoutText reports overflow and line metrics', () => {
  const layout = layoutText({ text: 'ab\ncd', fontPx: 20, boxW: 200, boxH: 60, measure });
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.fontPx, 20);
  assert.equal(layout.overflow, false);
  const tight = layoutText({ text: 'abcdef', fontPx: 40, boxW: 20, boxH: 20, measure });
  assert.equal(tight.overflow, true);
});

test('layoutText clamps an explicit size into the printable range', () => {
  const tiny = layoutText({ text: 'x', fontPx: 2, boxW: 400, boxH: 200, measure });
  assert.equal(tiny.fontPx, CONFIG.geometry.minFontPx);
  const huge = layoutText({ text: 'x', fontPx: 999, boxW: 4000, boxH: 4000, measure });
  assert.equal(huge.fontPx, CONFIG.geometry.maxFontPx);
});

test('layoutText reports a source that exceeds the printable line count', () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
  const layout = layoutText({ text, fontPx: 8, boxW: 500, boxH: 400, measure });
  assert.equal(layout.lines.length, 24);
  assert.equal(layout.truncated, true);
});

test('line and block anchors honour alignment', () => {
  assert.equal(lineAnchor('left', 100), 0);
  assert.equal(lineAnchor('right', 100), 100);
  assert.equal(lineAnchor('center', 100), 50);
  assert.equal(blockTop('top', 100, 40), 0);
  assert.equal(blockTop('bottom', 100, 40), 60);
  assert.equal(blockTop('middle', 100, 40), 30);
});

test('splitLines keeps empty lines, splits on any newline and caps the count', () => {
  assert.deepEqual(splitLines('a\n\nb').lines, ['a', '', 'b']);
  assert.deepEqual(splitLines('a\r\nb\rc').lines, ['a', 'b', 'c']);
  assert.equal(splitLines('a\nb').truncated, false);
  const long = splitLines(Array.from({ length: 40 }, () => 'x').join('\n'));
  assert.equal(long.lines.length, 24);
  assert.equal(long.truncated, true);
});

test('documents are landscape: length is width, 12 mm is height', () => {
  const doc = createDocument({ lengthMm: 40 });
  assert.equal(documentWidthPx(doc), 320);
  assert.equal(documentHeightPx(doc), 96);
});

test('validateDocument clamps geometry, drops unknown types and keeps one element', () => {
  const doc = validateDocument({
    lengthMm: 5000,
    copies: 999,
    elements: [
      { id: 'a', type: 'text', x: -50, y: -50, w: 9999, h: 9999, text: 'x' },
      { id: 'b', type: 'unknown', x: 0, y: 0, w: 10, h: 10 },
    ],
  });
  // The one unit test for the length clamp; controller.test.mjs covers the
  // device-geometry integration path.
  assert.equal(doc.lengthMm, CONFIG.geometry.maxLengthMm);
  assert.equal(validateDocument({ lengthMm: 1, elements: [] }).lengthMm, CONFIG.geometry.minLengthMm);
  assert.equal(doc.copies, CONFIG.print.copies.max);
  assert.equal(doc.elements.length, 1);
  const element = doc.elements[0];
  assert.ok(element.x >= 0 && element.y >= 0);
  assert.ok(element.x + element.w <= documentWidthPx(doc));
  assert.ok(element.y + element.h <= documentHeightPx(doc));
});

test('validateDocument keeps an explicitly empty document empty', () => {
  const doc = validateDocument({ lengthMm: 30, elements: [] });
  assert.deepEqual(doc.elements, []);
});

test('clampElement keeps a minimum size', () => {
  const doc = createDocument({ lengthMm: 20 });
  const clamped = clampElement({ id: 'x', type: 'rect', x: 0, y: 0, w: 0, h: 0 }, doc);
  assert.equal(clamped.w, CONFIG.geometry.minElementPx);
  assert.equal(clamped.h, CONFIG.geometry.minElementPx);
});

test('portrait documents migrate to landscape by swapping axes', () => {
  const migrated = migrateDocument({
    version: 3,
    lengthMm: 40,
    elements: [{ id: 'a', type: 'text', x: 4, y: 4, w: 88, h: 312, rotation: 90, text: 'Hi' }],
  });
  assert.equal(migrated.version, CONFIG.app.documentVersion);
  assert.equal(migrated.elements[0].w, 312);
  assert.equal(migrated.elements[0].h, 88);
  assert.equal(migrated.elements[0].rotation, 0);
});

test('print options clamp density and label type to the device', () => {
  const settings = { 'print.density': 9, 'print.labelType': '9', 'print.speed': 'quality' };
  const options = resolvePrintOptions({ settings, capabilities: { densityRange: { min: 1, max: 5 }, labelTypes: [1, 5] }, copies: 0 });
  assert.equal(options.density, 5);
  assert.equal(options.labelType, 1);
  assert.equal(options.speed, JOB_SPEED.quality);
  assert.equal(options.copies, 1);
});

test('print options fall back when the device reports nothing', () => {
  const options = resolvePrintOptions({ settings: { 'print.density': 3, 'print.labelType': '5', 'print.speed': 'normal' }, capabilities: null, copies: 3 });
  assert.deepEqual(options, { density: 3, labelType: 5, speed: 1, copies: 3 });
});

test('print options survive a non-finite density', () => {
  const options = resolvePrintOptions({ settings: { 'print.density': Number.NaN, 'print.labelType': '1', 'print.speed': 'normal' }, capabilities: null, copies: 1 });
  assert.equal(options.density, CONFIG.print.density.default);
});

test('threshold settings convert percent to a luminance cut', () => {
  assert.equal(resolveRenderOptions({ 'print.dither': 'threshold', 'print.threshold': 55 }).threshold, 140);
  assert.equal(resolveRenderOptions({ 'print.dither': 'threshold', 'print.threshold': 0 }).threshold, 13);
  assert.equal(resolveRenderOptions({ 'print.dither': 'threshold', 'print.threshold': 200 }).threshold, 242);
  assert.equal(resolveRenderOptions({ 'print.dither': 'floyd', 'print.threshold': 'x' }).threshold, 140);
});

test('dithering converts a gradient to binary and differs per algorithm', () => {
  const width = 16;
  const height = 8;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (i % width) * 16;

  const thresholded = thresholdGray(gray, 128);
  const floyd = floydSteinberg(gray, width, height, 128);
  const atk = atkinson(gray, width, height, 128);
  for (const output of [thresholded, floyd, atk]) {
    assert.equal(output.length, gray.length);
    for (const value of output) assert.ok(value === 0 || value === 255);
  }
  assert.notDeepEqual([...floyd], [...thresholded]);
  assert.notDeepEqual([...atk], [...floyd]);
});

test('toGray treats transparent pixels as white', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
  const gray = toGray({ data, width: 2, height: 1 });
  assert.equal(gray[0], 255);
  assert.equal(gray[1], 0);
});

test('code128 fixtures are stable and validated', () => {
  assert.equal(
    code128Modules('Hello').join(''),
    '110100100001100010100010110010000110010100001100101000010001111010110010100001100011101011'
  );
  assert.equal(validateBarcode('code128', 'ABC-123'), true);
  assert.throws(() => validateBarcode('code128', 'café'), /printable ASCII/);
  assert.throws(() => validateBarcode('ean13', '123'), /Unsupported/);
});

test('auto-sized text keeps real vertical travel at the default box', () => {
  const frame = defaultTextFrame(createDocument({ lengthMm: 40 }));
  // The default 40 mm label's text frame is the box the user actually edits in.
  assert.equal(frame.h, 62);
  for (const count of [1, 2, 4]) {
    const text = Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
    const layout = layoutText({ text, fontPx: 0, boxW: frame.w, boxH: frame.h, measure });
    assert.ok(layout.fontPx <= CONFIG.geometry.autoFontMaxPx);
    const travel = frame.h - layout.totalHeight;
    // Half the documented reserve is the floor: the old auto-size left ~1.7 px
    // for 2-4 lines, which made valign invisible.
    assert.ok(
      travel >= frame.h * CONFIG.geometry.alignmentSlackRatio * 0.5,
      `${count} line(s) keep alignment travel (got ${travel.toFixed(2)} px)`
    );
    const top = blockTop('top', frame.h, layout.totalHeight);
    const middle = blockTop('middle', frame.h, layout.totalHeight);
    const bottom = blockTop('bottom', frame.h, layout.totalHeight);
    assert.ok(middle - top > 1, 'Middle really moves the block');
    assert.equal(bottom - top, travel, 'Bottom uses the whole slack');
  }
});

test('single-line auto-size still reaches the configured cap at the default box', () => {
  const frame = defaultTextFrame(createDocument({ lengthMm: 40 }));
  const layout = layoutText({ text: 'Hi', fontPx: 0, boxW: frame.w, boxH: frame.h, measure });
  assert.equal(layout.fontPx, CONFIG.geometry.autoFontMaxPx);
});

test('overflow allows the documented sub-pixel tolerance', () => {
  const at = (width) => layoutText({ text: 'x', fontPx: 20, boxW: 100, boxH: 100, measure: () => width });
  assert.equal(at(100.4).overflow, false, 'a rounding hair is not an overflow');
  assert.equal(at(100.6).overflow, true, 'a real overflow is reported');
});

test('vertical alignment moves the block by the slack inside the box', () => {
  const layout = layoutText({ text: 'Hi', fontPx: 20, boxW: 400, boxH: 80, measure });
  const top = blockTop('top', 80, layout.totalHeight);
  const middle = blockTop('middle', 80, layout.totalHeight);
  const bottom = blockTop('bottom', 80, layout.totalHeight);
  assert.equal(top, 0);
  assert.ok(middle > top);
  assert.ok(bottom > middle);
  assert.equal(bottom, 80 - layout.totalHeight);
});

/* ---------------- pinned dither weights (R5G-9) ---------------- */

test('a 4×4 Floyd-Steinberg fixture pins the 7/16 weight exactly', () => {
  // A field where the 7/16 right-neighbour weight changes the outcome: with
  // 6/16 row 2 keeps a dot at column 2 that 7/16 diffuses away. The weights are
  // current behaviour, not a tunable, so this fixture fails on any change.
  const gray = Float32Array.from([
    10, 90, 170, 250,
    40, 120, 200, 220,
    70, 150, 230, 200,
    100, 180, 210, 160,
  ]);
  assert.deepEqual(
    [...floydSteinberg(gray, 4, 4, 128)],
    [
      0, 0, 255, 255,
      0, 255, 255, 255,
      0, 255, 0, 255,
      0, 255, 255, 255,
    ]
  );
});

/* ---------------- the quality switch on the wire (R5G-3) ---------------- */

test('the quality setting is the literal 0 that PrintStart carries', () => {
  assert.equal(JOB_SPEED.quality, 0, 'quality is the enum value the official app sends');
  assert.equal(JOB_SPEED.normal, 1);

  for (const [setting, expected] of [
    ['quality', 0],
    ['normal', 1],
  ]) {
    const options = resolvePrintOptions({
      settings: { 'print.density': 3, 'print.labelType': '1', 'print.speed': setting },
      capabilities: null,
      copies: 2,
    });
    assert.equal(options.speed, expected, `${setting} resolves to ${expected}`);
    const frame = buildCommand('printStart', { pages: options.copies, speed: options.speed });
    const data = [...frame.subarray(4, 4 + frame[3])];
    assert.equal(data[7], expected, `${setting} reaches PrintStart payload byte 7`);
  }
});
