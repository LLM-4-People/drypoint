import test from 'node:test';
import assert from 'node:assert/strict';

import {
  barcodeFitMessage,
  barcodeFrame,
  barcodeLayout,
  barcodeMinimumWidth,
  barcodeModules,
} from '../src/label/barcode.js';
import { ELEMENT_TYPES, createElement, documentHeightPx, documentWidthPx, validateDocument } from '../src/label/schema.js';
import { CONFIG } from '../src/core/config.js';

/** The barcode a user gets from "Add barcode": the schema default value. */
function defaultBarcode() {
  return createElement(ELEMENT_TYPES.BARCODE);
}

test('the barcode layout reserves a ten-module quiet zone on both sides', () => {
  const barcode = defaultBarcode();
  assert.equal(barcode.value, 'ABC-123');
  const modules = barcodeModules(barcode.symbology, barcode.value);
  assert.equal(modules.length, 112, 'the fixture the literal numbers below describe');

  // 112 modules + two 10-module quiet zones at 2 px per module = 264 px.
  const minimum = barcodeMinimumWidth(modules.length);
  assert.equal(minimum, 264);

  const exact = barcodeLayout(minimum, modules.length);
  assert.equal(exact.fits, true);
  assert.equal(exact.modulePx, 2);
  assert.equal(exact.quietPx, 20);
  assert.equal(exact.drawnPx, 224);
  assert.equal(minimum - exact.drawnPx, 40, 'the box keeps both quiet zones outside the bars');

  // The old rule (bars only, no quiet zone) must no longer be enough.
  const withoutQuietZone = barcodeLayout(224, modules.length);
  assert.equal(withoutQuietZone.fits, false);
});

test('the barcode layout refuses non-positive and non-finite inputs', () => {
  for (const [width, count] of [
    [0, 112],
    [-10, 112],
    [Number.NaN, 112],
    [Infinity, 112],
    [200, 0],
    [200, -3],
    [200, Number.NaN],
  ]) {
    const layout = barcodeLayout(width, count);
    assert.equal(layout.fits, false, `barcodeLayout(${width}, ${count}) must not fit`);
    for (const value of [layout.modulePx, layout.quietPx, layout.drawnPx]) {
      assert.ok(Number.isFinite(value), 'geometry stays finite');
    }
  }
});

test('a 20 mm label refuses the default barcode with a clear message', () => {
  const barcode = defaultBarcode();
  const document = validateDocument({ lengthMm: CONFIG.geometry.minLengthMm, elements: [] });
  const frame = barcodeFrame({
    labelWidthPx: documentWidthPx(document),
    labelHeightPx: documentHeightPx(document),
    paddingPx: CONFIG.geometry.paddingPx,
    value: barcode.value,
    symbology: barcode.symbology,
  });
  assert.equal(frame.fits, false, 'the shortest label cannot hold ABC-123');
  assert.ok(frame.minimumWidthPx > frame.availableWidthPx);

  const message = barcodeFitMessage({
    minimumWidthPx: frame.minimumWidthPx,
    availableWidthPx: frame.availableWidthPx,
    dotsPerMm: CONFIG.geometry.dotsPerMm,
  });
  assert.match(message, /needs at least \d+ px/);
  assert.match(message, /this label has \d+ px/);
  assert.match(message, /Lengthen the label/);
  assert.ok(message.includes(String(frame.minimumWidthPx)), 'the message names the required width');
});

test('a 40 mm label sizes a new barcode so it renders', () => {
  const barcode = defaultBarcode();
  const document = validateDocument({ lengthMm: CONFIG.geometry.defaultLengthMm, elements: [] });
  const frame = barcodeFrame({
    labelWidthPx: documentWidthPx(document),
    labelHeightPx: documentHeightPx(document),
    paddingPx: CONFIG.geometry.paddingPx,
    value: barcode.value,
    symbology: barcode.symbology,
  });
  assert.equal(frame.fits, true);
  assert.equal(frame.w, frame.minimumWidthPx);
  assert.equal(frame.h, documentHeightPx(document) - CONFIG.geometry.paddingPx * 2);
  const modules = barcodeModules(barcode.symbology, barcode.value);
  assert.equal(barcodeLayout(frame.w, modules.length).fits, true, 'the box it returns renders');
  // The element the app adds is clamped to the label, not past its edge.
  const element = validateDocument({ lengthMm: document.lengthMm, elements: [{ ...barcode, w: frame.w, h: frame.h }] });
  assert.ok(element.elements[0].w <= documentWidthPx(document));
});
