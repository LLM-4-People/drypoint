import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvasEditor } from '../src/editor/canvas.js';
import { createEditor } from '../src/editor/controller.js';
import { createDocument, createElement } from '../src/label/schema.js';
import { CONFIG } from '../src/core/config.js';
import { resetGeometry, setGeometry } from '../src/core/geometry.js';
import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();

/**
 * A real controller, fake canvases and a fake scroll container. Zoom stays at
 * 1 so screen pixels equal label dots and the pointer coordinates are literal.
 */
function harness({ lengthMm = 40, zoom = 1, scrollLeft = 0 } = {}) {
  const labelCanvas = dom.createElement('canvas');
  const overlayCanvas = dom.createElement('canvas');
  const scroll = dom.createElement('div');
  scroll.scrollLeft = scrollLeft;
  const options = { dither: 'threshold', threshold: CONFIG.print.thresholdDefault };
  const editor = createEditor({ document: createDocument({ lengthMm }) });
  const canvasEditor = createCanvasEditor({
    labelCanvas,
    overlayCanvas,
    controller: editor,
    getZoom: () => zoom,
    getEditorPrefs: () => ({ snap: false, grid: false, gridMm: 1, showGuides: false }),
    getRenderOptions: () => options,
    scrollContainer: scroll,
  });
  return { editor, canvasEditor, labelCanvas, overlayCanvas, scroll, options };
}

function pointer(type, pointerId, x, y, pointerType = 'touch') {
  return { type, pointerId, clientX: x, clientY: y, pointerType, button: 0 };
}

function selectedBox(editor) {
  const element = editor.selected;
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

test('the first touch selects without moving the element', () => {
  const { editor, overlayCanvas } = harness();
  const id = editor.selection;
  editor.select(null);
  const before = { ...editor.document.elements[0] };

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48));
  assert.equal(editor.selection, id, 'the first touch selects');

  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 220, 50));
  const after = editor.document.elements[0];
  assert.equal(after.x, before.x, 'the selecting touch never drags');
  assert.equal(after.y, before.y);
});

test('a horizontal touch drag moves the element and is one undo step', () => {
  const { editor, overlayCanvas } = harness();
  const id = editor.selection;
  const before = selectedBox(editor);

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 200, 52));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 210, 52));
  const moved = selectedBox(editor);
  assert.ok(moved.x > before.x, 'the drag follows the finger');
  overlayCanvas.dispatch('pointerup', pointer('pointerup', 1, 210, 52));

  editor.undo();
  assert.deepEqual(selectedBox(editor), before, 'the whole drag is one undo step');
  assert.equal(editor.selection, id);
});

test('a vertical touch gesture does not move the selected element', () => {
  const { editor, overlayCanvas } = harness();
  const before = selectedBox(editor);

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 163, 88));
  assert.deepEqual(selectedBox(editor), before, 'a scroll that starts on the label is not a drag');
  overlayCanvas.dispatch('pointercancel', pointer('pointercancel', 1, 163, 88));
  assert.deepEqual(selectedBox(editor), before);
});

test('a few pixels of finger jitter are not a drag', () => {
  const { editor, overlayCanvas } = harness();
  const before = selectedBox(editor);
  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 165, 50));
  assert.deepEqual(selectedBox(editor), before, `less than ${CONFIG.geometry.touchDragStartPx}px stays a tap`);
  overlayCanvas.dispatch('pointerup', pointer('pointerup', 1, 165, 50));
  assert.deepEqual(selectedBox(editor), before);
});

test('a cancelled resize restores the original box', () => {
  const { editor, overlayCanvas } = harness();
  const before = selectedBox(editor);
  const cornerX = before.x + before.w;
  const cornerY = before.y + before.h;

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, cornerX, cornerY));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, cornerX - 30, cornerY - 10));
  const resized = selectedBox(editor);
  assert.ok(resized.w < before.w, 'the handle resizes once the drag is deliberate');

  overlayCanvas.dispatch('pointercancel', pointer('pointercancel', 1, cornerX - 30, cornerY - 10));
  assert.deepEqual(selectedBox(editor), before, 'the aborted gesture is rolled back');
});

test('two fingers pan the stage without moving the element', () => {
  const { editor, overlayCanvas, scroll } = harness({ scrollLeft: 20 });
  const before = selectedBox(editor);

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48));
  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 2, 220, 48));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 130, 48));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 2, 180, 48));
  assert.equal(scroll.scrollLeft, 55, 'the centroid moved 35px left, so the content moves right');
  assert.deepEqual(selectedBox(editor), before, 'panning never drags the element');

  overlayCanvas.dispatch('pointerup', pointer('pointerup', 1, 130, 48));
  overlayCanvas.dispatch('pointerup', pointer('pointerup', 2, 180, 48));
});

test('a resized backing store repaints the document even when it is unchanged', (t) => {
  t.after(resetGeometry);
  const { canvasEditor, labelCanvas, options } = harness();
  const ctx = labelCanvas.getContext('2d');
  const draws = () => ctx.ops.filter((op) => op.op === 'drawImage').length;

  canvasEditor.render();
  assert.equal(labelCanvas.width, 320);
  assert.equal(draws(), 1, 'the first paint reaches the canvas');

  setGeometry({ discovered: true, dpi: 300, headWidthPx: 128, maxLengthMm: 100 });
  canvasEditor.render();
  assert.equal(labelCanvas.width, 472, 'the backing store follows the reported 300 dpi pitch');
  assert.equal(draws(), 2, 'resizing the store erased it, so the same document paints again');

  options.dither = 'floyd';
  canvasEditor.render();
  assert.equal(draws(), 3, 'a render-settings change repaints after the resize too');
});

test('a mouse drag still moves immediately', () => {
  const { editor, overlayCanvas } = harness();
  const before = selectedBox(editor);
  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 160, 48, 'mouse'));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 180, 50, 'mouse'));
  assert.ok(selectedBox(editor).x > before.x);
  overlayCanvas.dispatch('pointerup', pointer('pointerup', 1, 180, 50, 'mouse'));
});

test('two fingers move the label one-to-one, even while the canvas scrolls', () => {
  const { overlayCanvas, scroll } = harness({ scrollLeft: 100 });
  // A real stage scrolls the canvas with the content: its rect moves left by
  // exactly the scrollLeft this gesture is producing. A screen-space centroid
  // cancels half of every delta against that moving frame.
  overlayCanvas.getBoundingClientRect = () => ({ left: -scroll.scrollLeft, top: 0, width: 96, height: 96 });
  const press = (id, x) => overlayCanvas.dispatch('pointerdown', pointer('pointerdown', id, x, 48));
  const drag = (id, x) => overlayCanvas.dispatch('pointermove', pointer('pointermove', id, x, 48));

  press(1, 200);
  press(2, 300);
  // Each finger travels 50 px right, in two alternating steps (100 px of
  // combined finger travel): the content must follow exactly 50 px.
  drag(1, 225);
  drag(2, 325);
  drag(1, 250);
  drag(2, 350);
  assert.equal(scroll.scrollLeft, 50, 'finger travel maps 1:1 to scrollLeft');
});

test('a drag with a long pause is still one undo step', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { editor, overlayCanvas } = harness();
  // A box wide enough that its middle is clear of the 22 px touch handle halo:
  // a press near a corner is a resize by design.
  editor.replaceDocument(createDocument({ lengthMm: 40, elements: [createElement('text', { x: 20, y: 20, w: 80, h: 40 })] }));
  const before = selectedBox(editor);

  overlayCanvas.dispatch('pointerdown', pointer('pointerdown', 1, 60, 40));
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 100, 42));
  const halfway = selectedBox(editor);
  assert.notDeepEqual(halfway, before, 'the drag started');
  t.mock.timers.tick(5000);
  overlayCanvas.dispatch('pointermove', pointer('pointermove', 1, 140, 42));
  overlayCanvas.dispatch('pointerup', pointer('pointerup', 1, 140, 42));
  assert.notDeepEqual(selectedBox(editor), halfway, 'the drag continued after the pause');

  editor.undo();
  assert.deepEqual(selectedBox(editor), before, 'a pause inside one gesture does not split the undo step');
});

/* ---------------- the renderer reads the display document (R1) ---------------- */

test('the canvas renderer never repaints an answered notice', () => {
  const notice = 'One legacy element was dropped because it was not a valid element.';
  const labelCanvas = dom.createElement('canvas');
  const overlayCanvas = dom.createElement('canvas');
  const editor = createEditor({ document: createDocument({ lengthMm: 40, notices: [notice] }) });
  const canvasEditor = createCanvasEditor({
    labelCanvas,
    overlayCanvas,
    controller: editor,
    getZoom: () => 1,
    getEditorPrefs: () => ({ snap: false, grid: false, gridMm: 1, showGuides: false }),
    getRenderOptions: () => ({ dither: 'threshold', threshold: CONFIG.print.thresholdDefault }),
    scrollContainer: dom.createElement('div'),
  });

  assert.ok(canvasEditor.render().warnings.includes(notice), 'the live migration notice is painted once');
  editor.dismissNotices();
  editor.updateElement(editor.selection, { text: 'Changed' });
  assert.ok(editor.undo());
  assert.equal(canvasEditor.render().warnings.includes(notice), false, 'the undo snapshot must not resurrect the notice in the renderer');
});
