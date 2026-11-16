import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampZoom,
  fitScale,
  fitZoom,
  placementPlan,
  shouldClampZoom,
  stepZoom,
  wheelZoom,
  zoomLimits,
  STAGE_MARGINS,
} from '../src/ui/stage-layout.js';
import { CONFIG } from '../src/core/config.js';

test('the compact plan moves the name, stage and inspector', () => {
  assert.deepEqual(placementPlan({ compact: true }), {
    docNameInStage: true,
    stageBeforeSidebar: true,
    inspectorAfterRail: true,
  });
  assert.deepEqual(placementPlan({ compact: false }), {
    docNameInStage: false,
    stageBeforeSidebar: false,
    inspectorAfterRail: false,
  });
  assert.deepEqual(placementPlan(), placementPlan({ compact: false }), 'desktop is the default');
});

test('each placement decision is asserted separately, so one inverted branch fails', () => {
  const compact = placementPlan({ compact: true });
  const desktop = placementPlan({ compact: false });
  // A copy that inverted only placeInspector (the round-3 finding) used to
  // keep the whole suite green because nothing asserted this decision.
  for (const key of ['docNameInStage', 'stageBeforeSidebar', 'inspectorAfterRail']) {
    assert.equal(compact[key], true, `compact: ${key}`);
    assert.equal(desktop[key], false, `desktop: ${key}`);
  }
});

test('the stage gutter has one owner per layout', () => {
  assert.deepEqual(STAGE_MARGINS.compact, { width: 24, height: 16 });
  // .stage-scroll padding is 8px 24px 20px: 2 × 24 across, 8 + 20 down.
  assert.deepEqual(STAGE_MARGINS.desktop, { width: 48, height: 28 });
});

test('fitScale subtracts the layout gutter before fitting', () => {
  const args = { docWidth: 96, docHeight: 320, availableWidth: 304, availableHeight: 336 };
  // Compact: 280/96 = 2.9167, 320/320 = 1 -> 1.
  assert.equal(fitScale({ ...args, compact: true }), 1);
  // Desktop: 256/96 = 2.6667, 308/320 = 0.9625 -> 0.9625.
  assert.equal(fitScale({ ...args, compact: false }), 0.9625);
});

test('fitScale refuses a viewport with no room left', () => {
  assert.equal(fitScale({ docWidth: 0, docHeight: 320, availableWidth: 300, availableHeight: 300 }), null);
  assert.equal(fitScale({ docWidth: 96, docHeight: 0, availableWidth: 300, availableHeight: 300 }), null);
  assert.equal(fitScale({ docWidth: 96, docHeight: 320, availableWidth: 300, availableHeight: 10, compact: true }), null);
  const narrow = fitScale({ docWidth: 96, docHeight: 320, availableWidth: 20, availableHeight: 300, compact: true });
  assert.equal(narrow, null, 'a 24px compact gutter consumes the whole viewport');
});

test('fitZoom floors the scale so a fitted label is never wider than the stage', () => {
  const tall = { docWidth: 96, docHeight: 320, availableHeight: 100000 };
  assert.equal(fitZoom({ ...tall, availableWidth: 400, compact: true }), 3.9);
  assert.equal(fitZoom({ ...tall, availableWidth: 111, compact: true }), 0.9);
  assert.equal(fitZoom({ ...tall, availableWidth: 40, compact: true }), CONFIG.ui.previewMinScale);
  assert.equal(fitZoom({ ...tall, availableWidth: 1000, compact: true }), CONFIG.ui.zoom.fitMax);

  // Desktop shares the same floored path; it may go below the manual floor,
  // because Fit must show the whole label even when the stage is small.
  assert.equal(fitZoom({ ...tall, availableWidth: 1000, compact: false }), CONFIG.ui.zoom.fitMax);
  assert.equal(fitZoom({ ...tall, availableWidth: 300, compact: false }), 2.6);
  assert.equal(fitZoom({ ...tall, availableWidth: 500, compact: false }), CONFIG.ui.zoom.fitMax);
  const small = fitZoom({ ...tall, availableWidth: 90, compact: false });
  assert.equal(small, 0.4, 'floored, and below the manual floor');
  assert.ok(small < CONFIG.ui.zoom.min, 'the fit path is not bounded by the manual floor');
  assert.ok(small >= CONFIG.ui.previewMinScale);
  assert.equal(fitZoom({ ...tall, availableWidth: 60, compact: false }), CONFIG.ui.previewMinScale);
});

test('a stored zoom is validated against the zoom bounds', () => {
  assert.equal(clampZoom(null), CONFIG.ui.zoom.default, 'no stored value');
  assert.equal(clampZoom(''), CONFIG.ui.zoom.default);
  assert.equal(clampZoom('Infinity'), CONFIG.ui.zoom.default, 'a non-finite value never renders as Infinity%');
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), CONFIG.ui.zoom.default);
  assert.equal(clampZoom('not a number'), CONFIG.ui.zoom.default);
  assert.equal(clampZoom('-300'), CONFIG.ui.zoom.min, 'a negative scale is clamped, not shown');
  assert.equal(clampZoom(0.0001), CONFIG.ui.zoom.min, 'a zero-size canvas is impossible');
  assert.equal(clampZoom(99), CONFIG.ui.zoom.max);
  assert.equal(clampZoom(2.5), 2.5, 'a valid stored value is kept');
});

test('a fractional fit floors rather than rounds', () => {
  // (741 - 48) / 471 = 1.4713: floor keeps the label inside the stage (1.4);
  // round would apply 1.5, which is wider than the available width.
  assert.equal(fitZoom({ docWidth: 471, docHeight: 100, availableWidth: 741, availableHeight: 1000 }), 1.4);
});

/* ---------------- zoom paths (R5C-1/R5C-3) ---------------- */

test('zoom limits follow the layout and the value already on screen', () => {
  assert.deepEqual(zoomLimits({ compact: false }), { min: CONFIG.ui.zoom.min, max: CONFIG.ui.zoom.max, step: CONFIG.ui.zoom.step });
  assert.equal(zoomLimits({ compact: true }).min, CONFIG.ui.previewMinScale);
});

test('zooming out from a below-floor Fit stays there instead of jumping up', () => {
  // A 200 mm label in a 901 px window fits at 20%; one Zoom out used to clamp
  // back to the 50% manual floor, zooming *in*.
  assert.equal(stepZoom(0.2, -CONFIG.ui.zoom.step, { compact: false }), 0.2);
  assert.equal(stepZoom(0.2, CONFIG.ui.zoom.step, { compact: false }), 0.4);
  assert.equal(stepZoom(1.7, -CONFIG.ui.zoom.step, { compact: true }), 1.5);
});

test('small wheel deltas accumulate instead of being re-rounded away', () => {
  let zoom = 2;
  for (let index = 0; index < 40; index++) zoom = wheelZoom(zoom, -1, { compact: false });
  assert.ok(zoom > 2, `40 trackpad events changed the zoom (${zoom})`);
  assert.equal(Math.round(zoom * 1000) / 1000, Number((2 + 40 * CONFIG.ui.wheelZoomStep).toFixed(3)));
  // The same clamp and the same below-floor rule as the buttons.
  assert.equal(wheelZoom(0.2, 100, { compact: false }), 0.2);
  assert.equal(wheelZoom(CONFIG.ui.zoom.max, -10000, { compact: false }), CONFIG.ui.zoom.max);
});

test('a deliberate user zoom survives a resize; an automatic fit and a breakpoint refit', () => {
  assert.equal(shouldClampZoom({ zoom: 1.7, autoZoom: 1.1, breakpointChanged: false }), false, 'user zoom survives');
  assert.equal(shouldClampZoom({ zoom: 1.1, autoZoom: 1.1, breakpointChanged: false }), true, 'the automatic fit follows');
  assert.equal(shouldClampZoom({ zoom: 1.7, autoZoom: 1.1, breakpointChanged: true }), true, 'a breakpoint refits');
});
