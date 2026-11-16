import test from 'node:test';
import assert from 'node:assert/strict';

import { cornersOf, cursorForHandle, handleAt, handleHitRadius, resizeBox, snapPosition } from '../src/editor/manipulation.js';
import { CONFIG } from '../src/core/config.js';

const origin = { x: 10, y: 10, w: 40, h: 20 };

test('resizing from a corner keeps the opposite edge fixed when clamped', () => {
  const west = resizeBox({ origin, handle: 'w', dx: -100, dy: 0, minSize: 6, maxWidth: 100, maxHeight: 96 });
  assert.deepEqual(west, { x: 0, y: 10, w: 50, h: 20 }, 'the east edge stays at 50');

  const east = resizeBox({ origin, handle: 'e', dx: 100, dy: 0, minSize: 6, maxWidth: 60, maxHeight: 96 });
  assert.deepEqual(east, { x: 10, y: 10, w: 50, h: 20 }, 'the west edge stays at 10');

  const north = resizeBox({ origin, handle: 'n', dx: 0, dy: -100, minSize: 6, maxWidth: 100, maxHeight: 96 });
  assert.deepEqual(north, { x: 10, y: 0, w: 40, h: 30 }, 'the bottom edge stays at 30');

  const south = resizeBox({ origin, handle: 's', dx: 0, dy: 100, minSize: 6, maxWidth: 100, maxHeight: 40 });
  assert.deepEqual(south, { x: 10, y: 10, w: 40, h: 30 }, 'the top edge stays at 10');
});

test('resizing never shrinks below the minimum element size', () => {
  const tiny = resizeBox({ origin, handle: 'e', dx: -1000, dy: 0, minSize: 6, maxWidth: 100, maxHeight: 96 });
  assert.deepEqual(tiny, { x: 10, y: 10, w: 6, h: 20 });
});

test('each corner has a diagonal resize cursor', () => {
  assert.equal(cursorForHandle('nw'), 'nwse-resize');
  assert.equal(cursorForHandle('se'), 'nwse-resize');
  assert.equal(cursorForHandle('ne'), 'nesw-resize');
  assert.equal(cursorForHandle('sw'), 'nesw-resize');
  assert.equal(cursorForHandle('elsewhere'), 'default');
});

test('handles are hit-tested at half the drawn size', () => {
  const corners = cornersOf(0, 0, 100, 50);
  assert.equal(handleAt(corners, { x: 109, y: 50 }, 9).name, 'se');
  assert.equal(handleAt(corners, { x: 109.1, y: 50 }, 9), null);
  assert.equal(handleAt(corners, { x: 0, y: 0 }, 9).name, 'nw');
});

test('snapping uses the configured grid step and stays inside the label', () => {
  // 1 mm at 8 dots/mm is an 8-dot step; 2 mm is 16 dots.
  assert.equal(snapPosition({ value: 21, limit: 320, size: 40, stepPx: 8, tolerance: 5, enabled: true }), 24);
  assert.equal(snapPosition({ value: 21, limit: 320, size: 40, stepPx: 16, tolerance: 5, enabled: true }), 16);
  assert.equal(
    snapPosition({ value: 21, limit: 320, size: 40, targets: [24], stepPx: 8, tolerance: 5, enabled: true }),
    24,
    'alignment targets win inside the tolerance'
  );
  assert.equal(snapPosition({ value: 319, limit: 320, size: 40, stepPx: 8, tolerance: 5, enabled: true }), 280);
  assert.equal(snapPosition({ value: 319, limit: 320, size: 40, stepPx: 8, tolerance: 5, enabled: false }), 280);
});

/* ---------------- touch handle target (R5C-6) ---------------- */

test('a finger gets a 22 px handle target while the drawing stays 18 px', () => {
  const corners = cornersOf(0, 0, 80, 60);
  const nearMiss = { x: 80 - 12, y: 60 - 12 };
  assert.equal(handleHitRadius('mouse'), CONFIG.geometry.handleSizePx / 2);
  assert.equal(handleHitRadius('touch'), 22);
  assert.equal(handleHitRadius('pen'), 22, 'a pen is a precise-ish coarse pointer, but not a mouse');
  assert.equal(handleAt(corners, nearMiss, handleHitRadius('mouse')), null, 'the mouse misses the 12 px gap');
  assert.equal(handleAt(corners, nearMiss, handleHitRadius('touch'))?.name, 'se', 'the finger still grabs the handle');
  assert.equal(CONFIG.geometry.handleSizePx, 18, 'the painted handle is unchanged');
});
