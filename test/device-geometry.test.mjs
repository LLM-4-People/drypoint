import test from 'node:test';
import assert from 'node:assert/strict';

import { geometry, maxLengthFor, mmToPx, pxToMm, resetGeometry, setGeometry } from '../src/core/geometry.js';
import { documentHeightPx, documentWidthPx } from '../src/label/schema.js';
import { CONFIG } from '../src/core/config.js';
import { mergeCapabilities, printBlockReason } from '../src/device/capabilities.js';

test('the fallback coordinate system is the configured 8 dots/mm and 96 dots', (t) => {
  t.after(resetGeometry);
  const active = resetGeometry();
  assert.equal(active.dotsPerMm, CONFIG.geometry.dotsPerMm);
  assert.equal(active.widthPx, CONFIG.geometry.widthPx);
  assert.equal(active.reported, false);
  assert.equal(mmToPx(40), 320);
  assert.equal(documentHeightPx(), 96);
});

test('geometry is reported only when the source says so, not when a width is finite', (t) => {
  t.after(resetGeometry);
  const model = (source) => ({ discovered: true, dpi: CONFIG.geometry.dpi, headWidthPx: CONFIG.geometry.widthPx, maxLengthMm: 200, ...(source ? { source } : {}) });

  setGeometry(model({ geometry: 'default' }));
  assert.equal(geometry().reported, false, 'the fallback width is not a printer report');

  setGeometry(model({ geometry: 'reported' }));
  assert.equal(geometry().reported, true);

  setGeometry(model(null));
  assert.equal(geometry().reported, false, 'a model without a source is still a guess');
});

test('the reported dpi drives the pitch and the head width derives the tape width', (t) => {
  t.after(resetGeometry);
  setGeometry({
    discovered: true,
    dpi: 200,
    headWidthPx: 96,
    maxLengthMm: 100,
    source: { geometry: 'reported' },
  });
  const active = geometry();
  assert.equal(active.reported, true);
  // The resolution class is the pitch: 200/25.4, not 96 dots over a presumed
  // 12 mm tape. The tape width is derived from the head instead.
  assert.ok(Math.abs(active.dotsPerMm - 200 / 25.4) < 1e-9);
  assert.equal(mmToPx(40), 315);
  assert.ok(Math.abs(pxToMm(315) - 40) < 0.01);
  assert.equal(documentWidthPx({ lengthMm: 40 }), 315);
  assert.equal(documentHeightPx(), 96);
  assert.ok(Math.abs(active.widthMm - 96 / (200 / 25.4)) < 1e-9);
  assert.equal(active.dpi, 200);
});

test('a 144-dot 300-dpi head resolves to 11.81 dots/mm, not 12', (t) => {
  t.after(resetGeometry);
  setGeometry({ discovered: true, dpi: 300, headWidthPx: 144, maxLengthMm: 200, source: { geometry: 'reported' } });
  const active = geometry();
  assert.ok(Math.abs(active.dotsPerMm - 300 / 25.4) < 1e-9);
  assert.ok(Math.abs(active.dotsPerMm - 11.81) < 0.005, 'not the 144/12 = 12 the old head-width formula produced');
  assert.ok(Math.abs(active.widthMm - 144 / (300 / 25.4)) < 1e-9);
  assert.equal(active.widthPx, 144);
});

test('a reported head width changes the tape width, not the pitch', (t) => {
  t.after(resetGeometry);
  setGeometry({ discovered: true, dpi: 300, headWidthPx: 128, maxLengthMm: 200 });
  const active = geometry();
  assert.ok(Math.abs(active.dotsPerMm - 300 / 25.4) < 1e-9);
  assert.equal(active.widthPx, 128);
  assert.equal(mmToPx(12), 142);
  assert.ok(Math.abs(active.widthMm - 128 / (300 / 25.4)) < 1e-9);
});

test('maxLengthFor accepts only a usable length and caps at the app maximum', () => {
  for (const [reported, expected] of [
    [1, null],
    [19.9, null],
    [20, 20],
    [100, 100],
    [1000, 200],
    [Number.NaN, null],
    [Infinity, null],
  ]) {
    assert.equal(maxLengthFor(reported), expected, `${reported} mm -> ${expected}`);
  }
});

test('the pitch owns the dpi bound, so any caller is bounded', (t) => {
  t.after(resetGeometry);
  // mergeCapabilities filters the report, but setGeometry is also called by
  // tests and future callers; the conversion itself must refuse a hostile dpi.
  for (const dpi of [CONFIG.geometry.maxDpi + 1, 65535, Infinity, 0, -1, Number.NaN]) {
    setGeometry({ discovered: true, dpi, headWidthPx: 96, maxLengthMm: 200, source: { geometry: 'reported' } });
    const active = geometry();
    assert.equal(active.dotsPerMm, CONFIG.geometry.dotsPerMm, `${dpi} falls back to the configured pitch`);
    assert.equal(active.dpi, null, `${dpi} is not shown as a reported resolution`);
    assert.equal(mmToPx(200), 1600, `${dpi}: a 200 mm label stays a 1600-row raster`);
  }
  setGeometry({ discovered: true, dpi: CONFIG.geometry.maxDpi, headWidthPx: 96, maxLengthMm: 200 });
  assert.ok(Math.abs(geometry().dotsPerMm - CONFIG.geometry.maxDpi / 25.4) < 1e-9, 'the bound itself is usable');
  assert.equal(geometry().dpi, CONFIG.geometry.maxDpi);
});

test('a forged reported geometry cannot keep a hostile dpi on screen', (t) => {
  t.after(resetGeometry);
  // V6: `source.geometry: 'reported'` is a claim, not a checked fact. The
  // geometry owner must not display or rasterise a value the pitch refuses.
  for (const dpi of [65535, 601, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '203']) {
    const active = setGeometry({ discovered: true, dpi, headWidthPx: 96, maxLengthMm: 200, source: { geometry: 'reported' } });
    assert.equal(active.dpi, null, `${String(dpi)} is not a resolution this app can show`);
    assert.equal(active.dotsPerMm, CONFIG.geometry.dotsPerMm);
    assert.equal(active.widthPx, 96, 'the reported head width is still usable');
  }
  // The real merge path sets dpi null and the gate refuses to print. A usable
  // heartbeat class is still a report; an invalid TLV alone is not.
  const merged = mergeCapabilities({
    capabilities: { dpi: 65535, headWidthPx: 96 },
    info: { deviceType: 0x0910, model: 'D110_M', modelSupport: 'confirmed' },
  });
  assert.equal(merged.dpi, null, 'an invalid TLV dpi is not a report');
  assert.equal(printBlockReason(merged), CONFIG.device.printGate.missingResolution);
  assert.equal(mergeCapabilities({ capabilities: { dpi: 65535, headWidthPx: 96 }, heartbeat: { dpi: 203 } }).dpi, 203, 'a usable class still answers');
});
