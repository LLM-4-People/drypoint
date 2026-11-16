import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { CONFIG } from '../src/core/config.js';
import { alphaMask, ditherImageData } from '../src/label/dither.js';
import {
  BARCODE_MIN_MODULE_PX,
  BARCODE_QUIET_MODULES,
  barcodeLayout,
  barcodeFrame,
  barcodeMinimumWidth,
  barcodeModules,
} from '../src/label/barcode.js';
import { qrLayout, qrMatrix } from '../src/label/qr.js';
import { canvasToRaster, rasterInk } from '../src/label/raster.js';
import { layoutText, layoutTextElement, splitLines } from '../src/label/text-layout.js';
import { layoutWarnings, rectGeometry, normaliseRenderOptions, renderDocument, renderOptionsKey, summariseWarnings } from '../src/label/render.js';
import { preloadImage } from '../src/label/images.js';
import { ELEMENT_TYPES, createDocument, createElement, validateDocument } from '../src/label/schema.js';
import { createEditor } from '../src/editor/controller.js';
import { TEMPLATES } from '../src/label/templates.js';
import { FakeCanvas, installDom } from './helpers/fake-dom.mjs';

// The renderer resolves QR content through the same vendored generator the
// browser loads as a script.
const vendorSource = readFileSync(new URL('../src/vendor/qrcode.js', import.meta.url), 'utf8');
const vendorContext = { exports: {}, module: { exports: {} } };
vm.runInNewContext(vendorSource, vendorContext);
globalThis.qrcode = vendorContext.module.exports;

const dom = installDom();

/** A wider bold face than the light face, as real fonts are. */
const measureFor = (bold) => (text, px) => text.length * px * (bold ? 0.75 : 0.55);

/** Render and collect the draw calls of every canvas the renderer created. */
function renderWithOps(labelDocument) {
  dom.created.length = 0;
  const result = renderDocument(labelDocument);
  const ops = dom.created.flatMap((node) => (node instanceof FakeCanvas ? node.getContext().ops : []));
  return { ...result, ops };
}

function documentWith(elements, lengthMm = CONFIG.geometry.defaultLengthMm) {
  return validateDocument({ lengthMm, elements });
}

test('bold text is measured with the bold face it is painted with', () => {
  const element = { text: 'HELLO WORLD', fontPx: 0, bold: true };
  const layout = layoutTextElement({ element, boxW: 200, boxH: 60, measureFor, min: 7, max: 72 });
  assert.ok(measureFor(true)(element.text, layout.fontPx) <= 200, 'the painted bold line fits its box');

  // This is the old behaviour: layout sized the text against the light face
  // and the painter then drew it bold, overflowing the box.
  const asIfLight = layoutText({ text: element.text, fontPx: 0, boxW: 200, boxH: 60, measure: measureFor(false), min: 7, max: 72 });
  assert.ok(measureFor(true)(element.text, asIfLight.fontPx) > 200);
  assert.ok(layout.fontPx < asIfLight.fontPx);
});

test('renderDocument paints text with the auto-sized bold face and no warnings', () => {
  const document = documentWith([createElement(ELEMENT_TYPES.TEXT, { text: 'Hi', bold: true, x: 4, y: 4, w: 200, h: 60 })]);
  const { warnings, ops } = renderWithOps(document);
  const painted = ops.filter((op) => op.op === 'fillText');
  assert.equal(painted.length, 1);
  assert.equal(painted[0].text, 'Hi');
  assert.match(painted[0].font, /^700 \d+px /, 'the painted face is bold');
  assert.ok(Number(painted[0].font.match(/^700 (\d+)px/)[1]) > 0);
  assert.deepEqual(warnings, []);
});

test('renderDocument applies rotation around the element centre and clips the local box', () => {
  const document = documentWith([createElement(ELEMENT_TYPES.RECT, { x: 10, y: 10, w: 40, h: 20, rotation: 90, filled: true })]);
  const { ops } = renderWithOps(document);
  const translate = ops.find((op) => op.op === 'translate');
  assert.deepEqual({ x: translate.x, y: translate.y }, { x: 30, y: 20 });
  const rotate = ops.find((op) => op.op === 'rotate');
  assert.equal(rotate.angle, Math.PI / 2);
  const clip = ops.find((op) => op.op === 'rect');
  assert.deepEqual({ w: clip.w, h: clip.h }, { w: 20, h: 40 }, 'the clip uses the rotated local box');
  assert.ok(ops.some((op) => op.op === 'clip'));
  assert.ok(ops.some((op) => op.op === 'fill'));
});

test('QR modules land on whole dots at an odd box width', () => {
  const value = 'https://example.com';
  const element = createElement(ELEMENT_TYPES.QR, { value, ecLevel: 'M', x: 0, y: 0, w: 95, h: 95 });
  const document = documentWith([element]);
  const { ops, warnings } = renderWithOps(document);

  const matrix = qrMatrix(value, 'M');
  const layout = qrLayout(95, matrix.count);
  assert.equal(layout.fits, true);
  // 'https://example.com' at level M is 25 modules; a 95 px box gives 2 px
  // modules, an 8 px quiet zone and a 50 px symbol.
  assert.deepEqual(
    { modulePx: layout.modulePx, quietPx: layout.quietPx, drawnPx: layout.drawnPx },
    { modulePx: 2, quietPx: 8, drawnPx: 50 }
  );

  const quiet = ops.find(
    (op) => op.op === 'fillRect' && op.fillStyle === '#ffffff' && op.w === layout.drawnPx + layout.quietPx * 2
  );
  assert.ok(quiet, 'the quiet zone is painted');
  for (const value of [quiet.x, quiet.y, quiet.w, quiet.h]) assert.ok(Number.isInteger(value), 'quiet-zone edges are whole dots');

  const modules = ops.filter((op) => op.op === 'fillRect' && op.fillStyle === '#000000');
  assert.ok(modules.length > 0);
  const moduleLeft = quiet.x + layout.quietPx;
  const moduleTop = quiet.y + layout.quietPx;
  for (const op of modules) {
    assert.ok(Number.isInteger(op.x) && Number.isInteger(op.y), 'module origins are whole dots');
    assert.ok(Number.isInteger(op.w) && Number.isInteger(op.h), 'module sizes are whole dots');
    assert.equal((op.x - moduleLeft) % layout.modulePx, 0, 'modules share one integer origin');
    assert.equal((op.y - moduleTop) % layout.modulePx, 0, 'modules share one integer origin');
    assert.ok(op.x >= moduleLeft && op.y >= moduleTop);
    assert.ok(op.x + op.w <= moduleLeft + layout.drawnPx);
  }
  assert.equal(quiet.x, 14, 'a 50 px symbol centred in 95 px starts at 22, minus the 8 px quiet zone');
  assert.equal(quiet.y, 14);
  assert.deepEqual(warnings, []);
});

test('barcode bars land on whole dots and keep the quiet zone at an odd box width', () => {
  const modules = barcodeModules('code128', 'ABC-123');
  const width = barcodeMinimumWidth(modules.length) + 1;
  const document = documentWith([
    createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 0, y: 0, w: width, h: 75, showText: true }),
  ]);
  const { ops, warnings } = renderWithOps(document);

  const layout = barcodeLayout(width, modules.length);
  assert.equal(layout.fits, true);
  // 'ABC-123' is 112 modules; the 265 px box gives 2 px modules, a 20 px
  // quiet zone and a 224 px symbol.
  assert.deepEqual(
    { modulePx: layout.modulePx, quietPx: layout.quietPx, drawnPx: layout.drawnPx },
    { modulePx: 2, quietPx: 20, drawnPx: 224 }
  );

  const bars = ops.filter((op) => op.op === 'fillRect' && op.fillStyle === '#000000');
  assert.ok(bars.length > 0);
  for (const bar of bars) {
    assert.ok(Number.isInteger(bar.x), 'bar origins are whole dots');
    assert.ok(Number.isInteger(bar.w), 'bar widths are whole dots');
    assert.ok(bar.x >= layout.quietPx, 'the left quiet zone is reserved');
    assert.ok(bar.x + bar.w <= width - layout.quietPx, 'the right quiet zone is reserved');
  }
  assert.ok(bars.some((bar) => bar.w === BARCODE_MIN_MODULE_PX));
  const text = ops.find((op) => op.op === 'fillText');
  assert.equal(text.text, 'ABC-123', 'the human-readable line is painted');
  assert.deepEqual(warnings, []);
});

test('a frame whose stroke swallows the box warns instead of vanishing', () => {
  // The hole is min(boxW, boxH) - 2 * stroke: on a 10 px side a 4 px stroke
  // still leaves 2 px of paper, a 5 px stroke leaves none.
  for (const [strokePx, collapsed] of [
    [2, false],
    [4, false],
    [5, true],
    [9, true],
    [12, true],
  ]) {
    assert.equal(rectGeometry({ filled: false, strokePx }, 96, 10).collapsed, collapsed, `stroke ${strokePx}`);
  }
  const framed = renderWithOps(
    documentWith([createElement(ELEMENT_TYPES.RECT, { x: 0, y: 0, w: 96, h: 10, strokePx: 4 })])
  );
  assert.deepEqual(framed.warnings, [], 'a 4 px stroke still prints a visible outline');
  const solid = renderWithOps(
    documentWith([createElement(ELEMENT_TYPES.RECT, { x: 0, y: 0, w: 96, h: 10, strokePx: 5 })])
  );
  assert.deepEqual(solid.warnings, ['Frame stroke is wider than the box, so it prints as a solid block']);
});

test('overlapping visible content is reported; a frame around content is not', () => {
  const overlapping = documentWith([
    createElement(ELEMENT_TYPES.TEXT, { name: 'Front', text: 'Hi', x: 4, y: 4, w: 200, h: 60 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Back', text: 'Hi', x: 150, y: 40, w: 200, h: 60 }),
  ]);
  assert.deepEqual(layoutWarnings(overlapping), ['Text "Front" and Text "Back" overlap']);

  // The framed template draws a rect fully around the text: that is the frame,
  // not content painted on top of content.
  const framed = validateDocument(TEMPLATES.find((template) => template.id === 'frame').build());
  assert.deepEqual(layoutWarnings(framed), []);

  // A frame that only partly covers another element is a real overlap.
  const pokingOut = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Edge', x: 2, y: 2, w: 100, h: 40, strokePx: 2 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Out', text: 'Hi', x: 20, y: 20, w: 200, h: 40 }),
  ]);
  assert.deepEqual(layoutWarnings(pokingOut), ['Frame "Edge" and Text "Out" overlap']);

  const hidden = documentWith([
    createElement(ELEMENT_TYPES.TEXT, { text: 'hidden', x: 4, y: 4, w: 100, h: 40, visible: false }),
    createElement(ELEMENT_TYPES.TEXT, { text: 'shown', x: 4, y: 4, w: 100, h: 40 }),
  ]);
  assert.deepEqual(layoutWarnings(hidden), [], 'an invisible element cannot overlap anything');
});

test('a filled frame paints over its content, so it is a reported overlap', () => {
  const filled = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Backdrop', x: 4, y: 4, w: 300, h: 80, strokePx: 2, filled: true }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Inside', text: 'Hi', x: 20, y: 20, w: 100, h: 40 }),
  ]);
  assert.deepEqual(layoutWarnings(filled), ['Frame "Backdrop" and Text "Inside" overlap']);
});

test('a collapsed stroke cannot be a frame', () => {
  const collapsed = documentWith([
    // 2 × 6 px of stroke over a 10 px side leaves no paper: it paints solid.
    createElement(ELEMENT_TYPES.RECT, { name: 'Bar', x: 4, y: 4, w: 100, h: 10, strokePx: 6 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Inside', text: 'Hi', x: 20, y: 5, w: 40, h: 6 }),
  ]);
  assert.deepEqual(layoutWarnings(collapsed), ['Frame "Bar" and Text "Inside" overlap']);
});

test('a thick stroke leaves no frame around a barcode that reaches into it', () => {
  const thick = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Thick', x: 0, y: 0, w: 320, h: 96, strokePx: 12 }),
    createElement(ELEMENT_TYPES.BARCODE, { name: 'Code', value: 'ABC-123', x: 2, y: 2, w: 280, h: 60, showText: false }),
  ]);
  assert.deepEqual(layoutWarnings(thick), ['Frame "Thick" and Barcode "Code" overlap']);
});

test('a filled rectangle may back a later QR code, which paints its own white field', () => {
  const backing = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Backdrop', x: 100, y: 4, w: 90, h: 90, filled: true }),
    createElement(ELEMENT_TYPES.QR, { name: 'Code', value: 'https://example.test', x: 105, y: 8, w: 80, h: 80 }),
  ]);
  assert.deepEqual(layoutWarnings(backing), [], 'the symbol clears its own field');
});

test('no template reports a frame overlap at its own length or longer', () => {
  for (const template of TEMPLATES) {
    for (const lengthMm of [40, 60]) {
      const built = validateDocument({ ...template.build(), lengthMm });
      const frameOverlaps = layoutWarnings(built).filter((warning) => /^Frame .* overlap$| and Frame .* overlap$/.test(warning));
      assert.deepEqual(frameOverlaps, [], `${template.id} at ${lengthMm} mm`);
    }
  }
});

test('squeezing the framed template onto a 20 mm page reports the content under its stroke', () => {
  // The template is authored at 40 mm; clamping it to 20 mm pins both boxes to
  // the page edge, so the text is painted over the left and right stroke. The
  // frame exemption must not hide that.
  const frame = TEMPLATES.find((template) => template.id === 'frame');
  const squeezed = validateDocument({ ...frame.build(), lengthMm: 20 });
  assert.deepEqual(layoutWarnings(squeezed), ['Frame and Text overlap']);
});

test('a symbol below two dots per module is reported with the numbers', () => {
  const narrow = documentWith([createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 0, y: 0, w: 200, h: 60, showText: false })]);
  assert.deepEqual(layoutWarnings(narrow), [
    'Barcode is too narrow: 112 modules plus a 10-module quiet zone on each side need 264 px at 2 px per module; the box is 200 px',
  ]);

  const dense = documentWith([createElement(ELEMENT_TYPES.QR, { value: 'https://example.com', x: 0, y: 0, w: 40, h: 40 })]);
  assert.deepEqual(layoutWarnings(dense), [
    'QR code is too dense: a 25-module symbol plus its 4-module quiet zone needs 66 px at 2 px per module; the box is 40 px',
  ]);

  // Rotation swaps the box axes: a 60 px wide, 88 px tall element rotated 90°
  // has 88 px to draw the symbol in (and 60 px of bar height), and still
  // cannot hold the 264 px symbol.
  const rotated = documentWith([
    createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 0, y: 0, w: 60, h: 88, rotation: 90, showText: false }),
  ]);
  assert.deepEqual(layoutWarnings(rotated), [
    'Barcode is too narrow: 112 modules plus a 10-module quiet zone on each side need 264 px at 2 px per module; the box is 88 px',
  ]);

  const badBarcode = documentWith([createElement(ELEMENT_TYPES.BARCODE, { value: 'café', x: 0, y: 0, w: 200, h: 60 })]);
  assert.deepEqual(layoutWarnings(badBarcode), ['Barcode: Code 128 B supports printable ASCII (32–126) only']);

  const badQr = documentWith([createElement(ELEMENT_TYPES.QR, { value: '', x: 0, y: 0, w: 80, h: 80 })]);
  assert.deepEqual(layoutWarnings(badQr), ['QR code: QR content is empty']);
});

test('shrinking the tape reports the overlap it causes instead of hiding it', () => {
  const cable = validateDocument(TEMPLATES.find((template) => template.id === 'cable').build());
  assert.deepEqual(renderWithOps(cable).warnings, [], 'the 60 mm cable label is clean');

  const squeezed = validateDocument({ ...cable, lengthMm: 55 });
  assert.deepEqual(renderWithOps(squeezed).warnings, ['Text and Barcode overlap']);

  const qr = validateDocument(TEMPLATES.find((template) => template.id === 'qr').build());
  assert.deepEqual(renderWithOps(qr).warnings, [], 'the 40 mm QR label is clean');
  const narrow = validateDocument({ ...qr, lengthMm: 25 });
  assert.deepEqual(renderWithOps(narrow).warnings, ['QR code and Text overlap']);

  // Shrinking also clamps the box: a 25 mm label cannot hold the cable
  // barcode at two dots per module, and that is reported, not silent.
  const tiny = validateDocument({ ...cable, lengthMm: 25 });
  assert.deepEqual(renderWithOps(tiny).warnings, [
    'Text and Barcode overlap',
    'Barcode is too narrow: 112 modules plus a 10-module quiet zone on each side need 264 px at 2 px per module; the box is 200 px',
  ]);
});

test('text breaks only at explicit newlines and shrinks instead of wrapping', () => {
  const long = 'A'.repeat(36);
  const layout = layoutTextElement({
    element: { text: long, fontPx: 0, bold: false },
    boxW: 96,
    boxH: 60,
    measureFor,
    min: 7,
    max: 72,
  });
  assert.equal(layout.lines.length, 1, 'a single line is never word-wrapped, however narrow the box');
  assert.equal(layout.lines[0], long);
  // 96 px / (36 chars * 0.55) is 4.8 px, below the 7 px auto-size floor, so
  // the line overflows instead of reflowing (see ARCHITECTURE.md).
  assert.equal(layout.fontPx, 7);
  assert.equal(layout.overflow, true);
  assert.deepEqual(splitLines('one\ntwo').lines, ['one', 'two']);
});

test('every starter template is free of layout warnings at its own length', () => {
  for (const template of TEMPLATES) {
    const document = validateDocument(template.build());
    assert.deepEqual(renderWithOps(document).warnings, [], `${template.id} must not warn before a single edit`);
  }
});

test('migration notices reach the renderer warnings', () => {
  const notice = 'The legacy barcode was dropped during migration: Code 128 B supports printable ASCII (32–126) only.';
  const document = validateDocument({ lengthMm: 40, notices: [notice], elements: [] });
  assert.deepEqual(renderDocument(document).warnings, [notice]);
});

test('a failed image decode is named and distinguished from a pending source', async () => {
  class BrokenImage {
    set src(_value) {
      queueMicrotask(() => this.onerror?.({}));
    }
  }
  globalThis.Image = BrokenImage;
  await assert.rejects(preloadImage('broken-render.png'), /could not be decoded/);

  const failed = renderWithOps(documentWith([createElement(ELEMENT_TYPES.IMAGE, { src: 'broken-render.png' })]));
  assert.ok(failed.warnings.some((warning) => warning.includes('broken-render.png') && /could not be decoded/.test(warning)));

  const pending = renderWithOps(documentWith([createElement(ELEMENT_TYPES.IMAGE, { src: 'never-requested.png' })]));
  assert.ok(pending.warnings.some((warning) => warning.includes('never-requested.png') && /still loading/.test(warning)));
});

test('ditherImageData turns tone into opaque black and white pixels', () => {
  const image = new ImageData(2, 1);
  image.data.set([0, 0, 0, 255, 255, 255, 255, 255]);
  const thresholded = ditherImageData(image, 'threshold', 128);
  assert.deepEqual([...thresholded.data], [0, 0, 0, 255, 255, 255, 255, 255]);

  const gradient = new ImageData(8, 1);
  for (let x = 0; x < 8; x++) {
    const value = Math.round((x / 7) * 255);
    gradient.data.set([value, value, value, 255], x * 4);
  }
  for (const mode of ['threshold', 'floyd', 'atkinson']) {
    const output = ditherImageData(gradient, mode, 128);
    assert.equal(output.data.length, gradient.data.length);
    for (let p = 0; p < output.data.length; p += 4) {
      assert.ok(output.data[p] === 0 || output.data[p] === 255, `${mode} emits 1-bit ink`);
      assert.equal(output.data[p + 3], 255, `${mode} keeps pixels opaque`);
    }
  }
});

function grayCanvas(width, height, inkAt) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (!inkAt(x, y)) continue;
      const p = (y * width + x) * 4;
      // A 110-luminance pixel stands in for an antialiased 8 px bold glyph:
      // darker than the fixed cut, lighter than a low user threshold.
      data[p] = 110;
      data[p + 1] = 110;
      data[p + 2] = 110;
    }
  }
  return {
    width,
    height,
    getContext: () => ({ getImageData: () => ({ data, width, height }) }),
  };
}

/** A canvas with one pixel at a chosen luminance; everything else is white. */
function pixelCanvas(luminance) {
  const width = 1;
  const height = 96;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const p = (40 * width) * 4;
  data[p] = luminance;
  data[p + 1] = luminance;
  data[p + 2] = luminance;
  return { width, height, getContext: () => ({ getImageData: () => ({ data, width, height }) }) };
}

test('the print raster cut is a fixed luminance boundary, not the user threshold', () => {
  const canvas = grayCanvas(40, 96, (x, y) => x >= 12 && x < 20 && y >= 40 && y < 48);
  const baseline = rasterInk(canvasToRaster(canvas));
  assert.ok(baseline > 0, 'mid-grey text produces ink at the fixed cut');
  assert.equal(CONFIG.print.rasterCut, 128);

  // 126 and 129 straddle the cut: darker is ink, lighter is paper. The user
  // threshold tops out at 95% (242), which would erase the 110-luminance
  // antialiased pixel below; the fixed cut keeps it, so small text survives
  // whatever image threshold the label uses.
  assert.equal(rasterInk(canvasToRaster(pixelCanvas(126))), 1);
  assert.equal(rasterInk(canvasToRaster(pixelCanvas(127))), 1);
  assert.equal(rasterInk(canvasToRaster(pixelCanvas(129))), 0);
  assert.equal(rasterInk(canvasToRaster(pixelCanvas(110))), 1);
  assert.ok(110 < Math.round((CONFIG.print.threshold.max / 100) * 255), 'the highest user threshold would erase it');
});

test('the stock cable template leaves room for a readable barcode', () => {
  const cable = validateDocument(TEMPLATES.find((template) => template.id === 'cable').build());
  const barcode = cable.elements.find((element) => element.type === 'barcode');
  const modules = barcodeModules(barcode.symbology, barcode.value);
  assert.equal(barcodeLayout(barcode.w, modules.length).fits, true);
});

test('the glyph alpha mask turns colour emoji into solid black silhouettes', () => {
  const data = new Uint8ClampedArray([
    255, 200, 0, 255, // opaque colour emoji pixel (bright yellow)
    255, 255, 255, 127, // fringe just below the cut
    0, 0, 0, 128, // exactly at the cut
    255, 255, 255, 0, // transparent
  ]);
  alphaMask({ data, width: 4, height: 1 }, 128);
  assert.deepEqual([...data], [0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]);
});

test('render options and their cache key share one owner', () => {
  assert.deepEqual(normaliseRenderOptions({}), { dither: 'threshold', threshold: CONFIG.print.thresholdDefault });
  assert.equal(renderOptionsKey({ dither: 'floyd', threshold: 90 }), 'floyd:90');
  assert.notEqual(
    renderOptionsKey({ dither: 'threshold', threshold: 140 }),
    renderOptionsKey({ dither: 'floyd', threshold: 140 }),
    'changing Image mode changes the key'
  );
  assert.notEqual(
    renderOptionsKey({ dither: 'threshold', threshold: 140 }),
    renderOptionsKey({ dither: 'threshold', threshold: 120 }),
    'changing Threshold changes the key'
  );
});

test('filled rectangles cover the full box and strokes are inset by half a line', () => {
  const filled = rectGeometry({ filled: true, strokePx: 2, radiusPx: 6 }, 96, 40);
  assert.deepEqual({ x: filled.x, y: filled.y, w: filled.w, h: filled.h, radius: filled.radius }, { x: 0, y: 0, w: 96, h: 40, radius: 6 });

  const stroke = rectGeometry({ filled: false, strokePx: 3, radiusPx: 6 }, 96, 40);
  assert.deepEqual(
    { x: stroke.x, y: stroke.y, w: stroke.w, h: stroke.h, lineWidth: stroke.lineWidth, radius: stroke.radius },
    { x: 1.5, y: 1.5, w: 93, h: 37, lineWidth: 3, radius: 6 }
  );

  const square = rectGeometry({ filled: false, strokePx: 2, radiusPx: 0 }, 96, 40);
  assert.equal(square.radius, 0);
  assert.equal(square.x, 1);

  const clampedRadius = rectGeometry({ filled: false, strokePx: 2, radiusPx: 999 }, 96, 40);
  assert.equal(clampedRadius.radius, 20, 'radius is clamped to half the short side');
});

test('QR and barcode layouts refuse a non-positive box', () => {
  for (const size of [0, -5, Number.NaN, Infinity]) {
    const qr = qrLayout(size, 21);
    assert.equal(qr.fits, false);
    assert.equal(qr.modulePx, 0);
    const barcode = barcodeLayout(size, 112);
    assert.equal(barcode.fits, false);
    assert.equal(barcode.modulePx, 0);
  }
  assert.equal(qrLayout(88, 0).fits, false);
  assert.equal(barcodeLayout(200, 0).fits, false);
  assert.ok(BARCODE_QUIET_MODULES > 0);
});

/* ---------------- barcode caption height (R2-6) ---------------- */

test('the barcode caption fits its strip and disappears below the readable minimum', () => {
  const cases = [
    { boxH: 6, hriPx: null },
    { boxH: 8, hriPx: null },
    { boxH: 10, hriPx: null },
    { boxH: 20, hriPx: null },
    { boxH: 60, hriPx: 15 },
  ];
  for (const { boxH, hriPx } of cases) {
    const { ops, warnings } = renderWithOps(
      documentWith([createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 4, y: 4, w: 280, h: boxH, showText: true })])
    );
    const caption = ops.find((op) => op.op === 'fillText');
    const bars = ops.filter((op) => op.op === 'fillRect' && op.fillStyle === '#000000');
    const barBottom = Math.max(...bars.map((bar) => bar.y + bar.h));
    if (hriPx == null) {
      assert.equal(caption, undefined, `no caption in a ${boxH} px box`);
      assert.equal(barBottom, boxH, `the bars keep the whole ${boxH} px box`);
      assert.ok(
        warnings.includes('Barcode text is hidden: the box is too short for a readable caption'),
        `the hidden caption is reported at ${boxH} px`
      );
    } else {
      assert.equal(caption.text, 'ABC-123');
      assert.equal(Number(/(\d+)px/.exec(caption.font)[1]), hriPx, 'the caption is sized from its strip');
      assert.ok(caption.y < boxH, 'the caption sits inside the box');
      assert.ok(barBottom <= boxH - hriPx, 'the bars stop above the caption');
      // The caption strip leaves 42 px of bars, below the 51 px Code 128
      // minimum, so the height warning is expected alongside a valid caption.
      assert.deepEqual(warnings, [
        'Barcode is too short: a barcode needs at least 51 px of bar height (6.35 mm); the box gives 42 px',
      ]);
    }
  }
});

/* ---------------- barcode bar height (R5B-9, USS-128) ---------------- */

test('a barcode bar height of 50 px warns and 51 px does not', () => {
  const at = (h) =>
    layoutWarnings(documentWith([createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 0, y: 0, w: 300, h, showText: false })]));
  assert.deepEqual(at(50), [
    'Barcode is too short: a barcode needs at least 51 px of bar height (6.35 mm); the box gives 50 px',
  ]);
  assert.deepEqual(at(51), [], '6.35 mm at 8 dots/mm is exactly the minimum');
});

test('the HRI strip is excluded from the bar height, so 60 px with a caption warns', () => {
  const warnings = layoutWarnings(
    documentWith([createElement(ELEMENT_TYPES.BARCODE, { value: 'ABC-123', x: 0, y: 0, w: 300, h: 60, showText: true })])
  );
  assert.deepEqual(warnings, [
    'Barcode is too short: a barcode needs at least 51 px of bar height (6.35 mm); the box gives 42 px',
  ]);
});

test('a long symbol needs 15% of its length even when 51 px is satisfied', () => {
  // 20 characters → 255 modules. A 550 px box gives 2 px modules: the drawn
  // symbol is 510 px, so 15% is 76.5 px — above the 51 px floor.
  const value = 'ABCDEFGHIJKLMNOPQRST';
  const warnings = layoutWarnings(
    documentWith([createElement(ELEMENT_TYPES.BARCODE, { value, x: 0, y: 0, w: 550, h: 60, showText: false })], 200)
  );
  assert.deepEqual(warnings, [
    'Barcode is too short: 60 px of bar height is below 15% of the 510 px symbol length (77 px needed)',
  ]);
});

test('the stock barcode template keeps its bar height at 40 and 60 mm', () => {
  const cable = TEMPLATES.find((template) => template.id === 'cable');
  assert.deepEqual(layoutWarnings(validateDocument(cable.build())), [], 'the stock cable label is clean at its 60 mm length');
  // The same stock barcode geometry on a 40 mm label: barcodeFrame is the one
  // owner of "the box a barcode needs", so this is the template's own sizing.
  const frame = barcodeFrame({ labelWidthPx: 320, labelHeightPx: 96, paddingPx: 4, value: 'CBL-001' });
  const short = documentWith([
    createElement(ELEMENT_TYPES.BARCODE, { value: 'CBL-001', x: 4, y: 4, w: frame.w, h: frame.h, showText: false }),
  ]);
  assert.deepEqual(layoutWarnings(short), [], 'the stock barcode geometry is clean at 40 mm');
});

/* ---------------- bounded warnings and footer text (R5H-3/R5H-4) ---------------- */

test('layoutWarnings caps its list, dedupes on insert and counts the remainder', () => {
  const elements = Array.from({ length: 8 }, (_, index) =>
    createElement(ELEMENT_TYPES.TEXT, { name: `a${index}`, text: 'x', x: 4, y: 4, w: 80, h: 40 })
  );
  const warnings = layoutWarnings(documentWith(elements, 200));
  // 8 overlapping boxes produce C(8,2) = 28 distinct pair messages.
  assert.equal(warnings.length, CONFIG.bounds.maxWarnings + 1);
  assert.equal(warnings.at(-1), '… and 8 more');
  assert.equal(new Set(warnings.slice(0, -1)).size, CONFIG.bounds.maxWarnings, 'no duplicate entries');
});

test('a repeated warning is stored once', () => {
  const elements = [
    createElement(ELEMENT_TYPES.QR, { name: 'A', value: '', x: 4, y: 4, w: 40, h: 40 }),
    createElement(ELEMENT_TYPES.QR, { name: 'B', value: '', x: 4, y: 4, w: 40, h: 40 }),
  ];
  const warnings = layoutWarnings(documentWith(elements, 200));
  assert.deepEqual(warnings, ['QR code "A" and QR code "B" overlap', 'QR code "A": QR content is empty', 'QR code "B": QR content is empty']);
});

test('an element name is truncated in a warning instead of being rendered whole', () => {
  const long = 'N'.repeat(5000);
  const warnings = layoutWarnings(
    documentWith([
      createElement(ELEMENT_TYPES.TEXT, { name: long, text: 'x', x: 4, y: 4, w: 80, h: 40 }),
      createElement(ELEMENT_TYPES.TEXT, { name: 'Other', text: 'y', x: 4, y: 4, w: 80, h: 40 }),
    ], 200)
  );
  const overlap = warnings.find((warning) => warning.includes('overlap'));
  assert.ok(overlap.length < 200, `the warning is bounded (${overlap.length} chars)`);
  assert.ok(overlap.includes(`${long.slice(0, CONFIG.bounds.warningNameChars - 1)}…`));
});

test('summariseWarnings is the one footer/dialog summary', () => {
  assert.equal(summariseWarnings([]), '');
  assert.equal(summariseWarnings(['a']), 'a');
  assert.equal(summariseWarnings(['a', 'b', 'c']), 'a · b · c');
  assert.equal(summariseWarnings(['a', 'b', 'c', 'd', 'e']), 'a · b · c · … and 2 more');
  assert.equal(summariseWarnings(['a', 'b', 'c', 'd', 'e'], { limit: 20 }), 'a · b · c · d · e');
  assert.equal(summariseWarnings(['a', 'b', 'c', 'd', 'e'], { limit: 20 }), 'a · b · c · d · e');
  assert.equal(summariseWarnings(['a', 'b'], { limit: 1 }), 'a · … and 1 more');
});

/* ---------------- empty text (R5B-8) ---------------- */

test('an empty text element is reported instead of printing a blank label', () => {
  for (const text of ['', '   ', '\n\t']) {
    const { warnings } = renderWithOps(documentWith([createElement(ELEMENT_TYPES.TEXT, { text, x: 4, y: 4, w: 88, h: 40 })]));
    assert.ok(warnings.includes('Text is empty'), JSON.stringify(text));
  }
  const filled = renderWithOps(documentWith([createElement(ELEMENT_TYPES.TEXT, { text: 'Hi', x: 4, y: 4, w: 88, h: 40 })]));
  assert.equal(filled.warnings.includes('Text is empty'), false);
});

/* ---------------- frame opening and rotation (R5B-5/R5B-6) ---------------- */

test('a frame opening starts at the full stroke width, not half of it', () => {
  // The stroke paints from the outer edge to lineWidth, so content 6 px inside
  // a 12 px stroke sits on top of the ink. The old half-width opening called
  // this clean.
  const doc = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Frame', x: 0, y: 0, w: 200, h: 96, strokePx: 12 }),
    createElement(ELEMENT_TYPES.IMAGE, { name: 'Photo', src: 'data:image/png;base64,x', x: 6, y: 6, w: 100, h: 40 }),
  ], 60);
  assert.deepEqual(layoutWarnings(doc), ['Frame "Frame" and Image "Photo" overlap']);

  const inside = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Frame', x: 0, y: 0, w: 200, h: 96, strokePx: 12 }),
    createElement(ELEMENT_TYPES.IMAGE, { name: 'Photo', src: 'data:image/png;base64,x', x: 12, y: 12, w: 100, h: 40 }),
  ], 60);
  assert.deepEqual(layoutWarnings(inside), [], 'content at the real inner edge is clean');
});

test('a quarter-turned frame paints the same rectangle and still backs its content', () => {
  const doc = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Frame', x: 2, y: 2, w: 300, h: 92, strokePx: 2, rotation: 90 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Inside', text: 'Hi', x: 8, y: 8, w: 280, h: 80 }),
  ], 200);
  assert.deepEqual(layoutWarnings(doc), []);
});

test('a rounded frame is tested against its inner rounded contour', () => {
  const corner = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Rounded', x: 2, y: 2, w: 316, h: 92, strokePx: 2, radiusPx: 30 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Corner', text: 'Hi', x: 8, y: 8, w: 40, h: 30 }),
  ], 200);
  assert.deepEqual(layoutWarnings(corner), ['Frame "Rounded" and Text "Corner" overlap'], 'the corner arc covers that box');

  const clear = documentWith([
    createElement(ELEMENT_TYPES.RECT, { name: 'Rounded', x: 2, y: 2, w: 316, h: 92, strokePx: 2, radiusPx: 30 }),
    createElement(ELEMENT_TYPES.TEXT, { name: 'Clear', text: 'Hi', x: 40, y: 8, w: 200, h: 80 }),
  ], 200);
  assert.deepEqual(layoutWarnings(clear), [], 'content clear of the arcs is clean');
});

/* ---------------- asymmetric raster fixture (R5G-1) ---------------- */

test('the raster maps landscape dots onto the portrait head without swapping axes', () => {
  // A 3 px long × 4 px high landscape canvas becomes a 4 dot wide × 3 row
  // portrait bitmap. Black at landscape (0,3), (1,0), (2,2): each row is one
  // feed position (x), each column one head dot (y, measured from the bottom).
  const width = 3;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of [
    [0, 3],
    [1, 0],
    [2, 2],
  ]) {
    const p = (y * width + x) * 4;
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
  }
  const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data, width, height }) }) };
  const raster = canvasToRaster(canvas);
  assert.equal(raster.width, 4);
  assert.equal(raster.height, 3);
  assert.deepEqual(
    raster.rows.map((row) => [...row]),
    [[0x80], [0x10], [0x40]],
    'an x/col or y/row swap moves every dot'
  );
});

/* ---------------- the renderer reads the display document (R1) ---------------- */

test('a dismissed notice is painted by neither the renderer nor the display path', () => {
  const notice = 'One legacy element was dropped because it was not a valid element.';
  const editor = createEditor({ document: createDocument({ lengthMm: 40, notices: [notice] }) });
  editor.dismissNotices();
  editor.updateElement(editor.selection, { text: 'Changed' });
  assert.ok(editor.undo());

  // The raw document still carries the answered notice (history is untouched);
  // this is the repro path that used to reach the stage footer and the print
  // confirmation.
  assert.ok(renderDocument(editor.document).warnings.includes(notice));
  assert.equal(renderDocument(editor.documentForDisplay()).warnings.includes(notice), false);
});
