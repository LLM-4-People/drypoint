/**
 * PR-F5: the design canvas is an image with a name, not an unnamed drawing.
 * The name carries the size the badge shows and how much is on the label.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { labelCanvasName } from '../src/ui/canvas-name.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the canvas name states the size and the element count', () => {
  assert.equal(labelCanvasName({ widthMm: 12.19, lengthMm: 40, count: 3 }), 'Label design, 12.2 × 40 mm, 3 elements');
  assert.equal(labelCanvasName({ widthMm: 12, lengthMm: 60, count: 1 }), 'Label design, 12 × 60 mm, 1 element');
  assert.equal(labelCanvasName({ widthMm: 12, lengthMm: 40, count: 0 }), 'Label design, 12 × 40 mm, 0 elements');
  assert.equal(labelCanvasName(), 'Label design, 0 × 0 mm, 0 elements', 'a missing state never renders NaN');
  assert.equal(labelCanvasName({ widthMm: 12, lengthMm: 40, count: -3 }), 'Label design, 12 × 40 mm, 0 elements');
});

test('the canvas is a named image and the overlay is decorative', () => {
  const html = read('index.html');
  assert.match(html, /<canvas id="labelCanvas"[^>]*role="img"/);
  assert.match(html, /<canvas id="labelCanvas"[^>]*aria-label="Label design"/);
  assert.match(html, /<canvas id="overlayCanvas"[^>]*aria-hidden="true"/, 'the empty interaction layer is not a second image');
  const main = read('src/main.js');
  assert.match(main, /labelCanvasName\(\{/);
  assert.match(main, /getAttribute\('aria-label'\) !== canvasName/, 'identical names are not rewritten');
});
