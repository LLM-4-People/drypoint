/**
 * Interactive canvas: renders the document at printer resolution and handles
 * selection, dragging, resizing, snapping, grid and alignment guides on a
 * screen-space overlay.
 */

import { CONFIG } from '../core/config.js';
import { geometry } from '../core/geometry.js';
import { renderDocument, localBox, renderOptionsKey } from '../label/render.js';
import { documentHeightPx, documentWidthPx, boundsOf, pointInside } from '../label/schema.js';
import { createLogger } from '../core/log.js';
import { cornersOf, cursorForHandle, handleAt, handleHitRadius, resizeBox, snapPosition } from './manipulation.js';

const log = createLogger('editor.canvas');

const DEFAULT_PREFS = Object.freeze({
  snap: true,
  grid: false,
  gridMm: CONFIG.geometry.gridMm,
  showGuides: false,
});

/** The accent comes from CSS so the overlay follows the selected theme/accent. */
function readAccent() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return value || 'gray';
}

export function createCanvasEditor({
  labelCanvas,
  overlayCanvas,
  controller,
  getZoom,
  getEditorPrefs,
  getRenderOptions,
  scrollContainer = null,
}) {
  const overlayCtx = overlayCanvas.getContext('2d');
  let drag = null;
  /** Two-finger pan on touch: { x } is the last centroid in client pixels. */
  let pan = null;
  const touchPoints = new Map();
  /** One monotonic id per pointer gesture: a drag is one undo step, pauses included. */
  let gestureSequence = 0;
  let lastDocument = null;
  let lastOptionsKey = null;
  let lastWarnings = { warnings: [], hidden: 0 };
  let accent = readAccent();

  function zoom() {
    return getZoom();
  }

  function prefs() {
    return getEditorPrefs?.() ?? DEFAULT_PREFS;
  }

  function gridStepPx() {
    const mm = Number(prefs().gridMm);
    return (Number.isFinite(mm) && mm > 0 ? mm : CONFIG.geometry.gridMm) * geometry().dotsPerMm;
  }

  function layout() {
    const document = controller.document;
    const width = documentWidthPx(document);
    const height = documentHeightPx(document);
    const scale = zoom();
    const cssWidth = Math.round(width * scale);
    const cssHeight = Math.round(height * scale);

    if (labelCanvas.width !== width || labelCanvas.height !== height) {
      labelCanvas.width = width;
      labelCanvas.height = height;
      // Assigning width/height erases the backing store. Without dropping the
      // document cache the next render would skip the repaint and leave the
      // canvas blank after a head/dpi change.
      lastDocument = null;
      lastOptionsKey = null;
    }
    labelCanvas.style.width = `${cssWidth}px`;
    labelCanvas.style.height = `${cssHeight}px`;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const overlayWidth = Math.round(cssWidth * dpr);
    const overlayHeight = Math.round(cssHeight * dpr);
    if (overlayCanvas.width !== overlayWidth || overlayCanvas.height !== overlayHeight) {
      overlayCanvas.width = overlayWidth;
      overlayCanvas.height = overlayHeight;
    }
    overlayCanvas.style.width = `${cssWidth}px`;
    overlayCanvas.style.height = `${cssHeight}px`;
    return { scale, dpr, cssWidth, cssHeight, width, height };
  }

  function render() {
    // The renderer is a display path: answered migration notices stay in the
    // controller's history but must never be painted or announced again.
    const document = controller.documentForDisplay();
    const { scale, dpr } = layout();
    const options = renderOptions();
    const optionsKey = renderOptionsKey(options);
    // The cache key includes the resolved options: changing Image mode or
    // Threshold repaints immediately even though the document is unchanged.
    if (document !== lastDocument || optionsKey !== lastOptionsKey) {
      const rendered = renderDocument(document, options);
      const ctx = labelCanvas.getContext('2d');
      ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
      ctx.drawImage(rendered.canvas, 0, 0);
      lastDocument = document;
      lastOptionsKey = optionsKey;
      lastWarnings = { warnings: rendered.warnings, hidden: rendered.hidden ?? 0 };
    }
    if (!drag) accent = readAccent();
    drawOverlay(scale, dpr);
    return lastWarnings;
  }

  function renderOptions() {
    return getRenderOptions?.() ?? { dither: 'threshold', threshold: CONFIG.print.thresholdDefault };
  }

  function drawOverlay(scale, dpr) {
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, overlayCanvas.width / dpr, overlayCanvas.height / dpr);
    drawGrid(scale, dpr);
    drawGuides(dpr);
    const element = controller.selected;
    if (!element) return;

    const bounds = boundsOf(element);
    const x = bounds.x * scale;
    const y = bounds.y * scale;
    const w = bounds.w * scale;
    const h = bounds.h * scale;

    overlayCtx.save();
    overlayCtx.strokeStyle = accent;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([5, 4]);
    overlayCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    overlayCtx.setLineDash([]);

    if (!element.locked) {
      const size = CONFIG.geometry.handleSizePx;
      overlayCtx.fillStyle = '#0b0b0e';
      overlayCtx.strokeStyle = accent;
      for (const corner of cornersOf(x, y, w, h)) {
        overlayCtx.beginPath();
        overlayCtx.roundRect(corner.x - size / 2, corner.y - size / 2, size, size, 2);
        overlayCtx.fill();
        overlayCtx.stroke();
      }
    }
    overlayCtx.restore();
  }

  /** Faint grid, skipped when the lines would be closer than the minimum gap. */
  function drawGrid(scale, dpr) {
    if (!prefs().grid) return;
    const step = gridStepPx() * scale;
    if (step < CONFIG.geometry.gridMinScreenPx) return;
    const width = overlayCanvas.width / dpr;
    const height = overlayCanvas.height / dpr;
    overlayCtx.save();
    overlayCtx.strokeStyle = accent;
    overlayCtx.globalAlpha = 0.12;
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    for (let x = step; x < width; x += step) {
      const px = Math.round(x) + 0.5;
      overlayCtx.moveTo(px, 0);
      overlayCtx.lineTo(px, height);
    }
    for (let y = step; y < height; y += step) {
      const py = Math.round(y) + 0.5;
      overlayCtx.moveTo(0, py);
      overlayCtx.lineTo(width, py);
    }
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  /** Centre guides while dragging, so the middle of the label is easy to hit. */
  function drawGuides(dpr) {
    if (!drag || drag.mode !== 'move' || !prefs().showGuides) return;
    const element = controller.selected;
    if (!element) return;
    const width = documentWidthPx(controller.document);
    const height = documentHeightPx(controller.document);
    const tolerance = CONFIG.geometry.snapTolerancePx;
    const screenW = overlayCanvas.width / dpr;
    const screenH = overlayCanvas.height / dpr;

    overlayCtx.save();
    overlayCtx.strokeStyle = accent;
    overlayCtx.globalAlpha = 0.7;
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([4, 4]);
    overlayCtx.beginPath();
    if (Math.abs(element.x + element.w / 2 - width / 2) <= tolerance) {
      const x = Math.round(screenW / 2) + 0.5;
      overlayCtx.moveTo(x, 0);
      overlayCtx.lineTo(x, screenH);
    }
    if (Math.abs(element.y + element.h / 2 - height / 2) <= tolerance) {
      const y = Math.round(screenH / 2) + 0.5;
      overlayCtx.moveTo(0, y);
      overlayCtx.lineTo(screenW, y);
    }
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function pointerToScreen(event) {
    const rect = overlayCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * The corner handle under a screen point. A mouse gets half the drawn handle
   * size; the hit box is the handle, not a halo. A finger has no such
   * precision, so the touch target is larger while the drawing stays 18 px.
   */
  function hitHandle(screen, pointerType = 'mouse') {
    const element = controller.selected;
    if (!element || element.locked) return null;
    const scale = zoom();
    const bounds = boundsOf(element);
    const points = cornersOf(bounds.x * scale, bounds.y * scale, bounds.w * scale, bounds.h * scale);
    return handleAt(points, screen, handleHitRadius(pointerType));
  }

  function hitElement(point) {
    for (let i = controller.document.elements.length - 1; i >= 0; i--) {
      const element = controller.document.elements[i];
      if (!element.visible || element.locked) continue;
      if (pointInside(element, point)) return element;
    }
    return null;
  }

  function capturePointer(pointerId) {
    try {
      overlayCanvas.setPointerCapture(pointerId);
    } catch (error) {
      log.debug('pointer capture failed', { message: error.message });
    }
  }

  function releasePointer(pointerId) {
    try {
      if (overlayCanvas.hasPointerCapture?.(pointerId)) overlayCanvas.releasePointerCapture(pointerId);
    } catch (error) {
      log.debug('pointer release failed', { message: error.message });
    }
  }

  /**
   * Client-space centroid. Screen space is canvas-local, and the canvas rect
   * shifts by the scrollLeft this very gesture is producing, so differencing
   * screen coordinates cancels half of every delta.
   */
  function touchCentroidX() {
    let total = 0;
    for (const point of touchPoints.values()) total += point.clientX;
    return total / touchPoints.size;
  }

  /** One coalesce key per gesture: a pause inside it must not start a new step. */
  function gestureKey(mode, id) {
    return `${mode}:${id}:${gestureSequence}`;
  }

  /**
   * Two fingers on the label pan the stage. Element drags stay one-finger;
   * a second touch cancels a pending drag so a pinch/pan never moves a label.
   */
  function beginPan() {
    if (drag) cancelDrag();
    pan = { x: touchCentroidX() };
    overlayCanvas.dataset.mode = 'pan';
  }

  /** Abort a touch gesture the browser took over for scrolling. */
  function cancelDrag() {
    if (!drag) return;
    const { id, origin, coalesceKey, moved, pointerId } = drag;
    drag = null;
    releasePointer(pointerId);
    if (moved) {
      // The gesture never completed: put the element back where it started.
      // The same coalesce key keeps this inside the drag's single undo step.
      controller.updateElement(id, origin, { coalesceKey, coalesceMs: Infinity });
    }
    overlayCanvas.dataset.mode = 'default';
    overlayCanvas.style.cursor = '';
    render();
  }

  function onPointerDown(event) {
    if ((event.button ?? 0) !== 0) return;
    const screen = pointerToScreen(event);
    if (event.pointerType === 'touch') {
      touchPoints.set(event.pointerId, { ...screen, clientX: event.clientX });
      if (touchPoints.size >= 2) {
        beginPan();
        return;
      }
    }
    if (drag) return;
    const scale = zoom();
    const point = { x: screen.x / scale, y: screen.y / scale };
    const handle = hitHandle(screen, event.pointerType);

    if (handle) {
      const element = controller.selected;
      gestureSequence += 1;
      drag = {
        mode: 'resize',
        coalesceKey: gestureKey('resize', element.id),
        pointerId: event.pointerId,
        id: element.id,
        start: point,
        screenStart: screen,
        origin: { x: element.x, y: element.y, w: element.w, h: element.h },
        handle: handle.name,
        moved: false,
        // Touch waits for a deliberate drag before resizing: the first pixels
        // may be the browser starting a page scroll.
        pending: event.pointerType === 'touch',
      };
      overlayCanvas.dataset.mode = 'resize';
      overlayCanvas.style.cursor = cursorForHandle(handle.name);
      capturePointer(event.pointerId);
      return;
    }

    const element = hitElement(point);
    if (!element) {
      controller.select(null);
      render();
      return;
    }

    if (controller.selection !== element.id) {
      controller.select(element.id);
      render();
      // A page scroll often starts with a finger on the canvas. Select on the
      // first touch and only start moving on a touch that begins on an already
      // selected element, so scrolling cannot drag a label element by accident.
      if (event.pointerType === 'touch') return;
    }

    gestureSequence += 1;
    drag = {
      mode: 'move',
      coalesceKey: gestureKey('drag', element.id),
      pointerId: event.pointerId,
      id: element.id,
      start: point,
      screenStart: screen,
      origin: { x: element.x, y: element.y, w: element.w, h: element.h },
      moved: false,
      pending: event.pointerType === 'touch',
    };
    overlayCanvas.dataset.mode = 'move';
    capturePointer(event.pointerId);
  }

  function onPointerMove(event) {
    const screen = pointerToScreen(event);
    if (touchPoints.has(event.pointerId)) touchPoints.set(event.pointerId, { ...screen, clientX: event.clientX });

    if (pan && touchPoints.size >= 2) {
      const centroid = touchCentroidX();
      const dx = centroid - pan.x;
      pan.x = centroid;
      if (scrollContainer) scrollContainer.scrollLeft = Math.max(0, scrollContainer.scrollLeft - dx);
      return;
    }

    const scale = zoom();
    if (!drag) {
      const handle = hitHandle(screen, event.pointerType);
      overlayCanvas.dataset.mode = handle ? 'resize' : 'default';
      overlayCanvas.style.cursor = handle ? cursorForHandle(handle.name) : '';
      return;
    }
    if (event.pointerId !== drag.pointerId) return;

    if (drag.pending) {
      const screenDx = screen.x - drag.screenStart.x;
      const screenDy = screen.y - drag.screenStart.y;
      if (Math.hypot(screenDx, screenDy) < CONFIG.geometry.touchDragStartPx) return;
      // A vertical-dominant gesture belongs to the page scroll. The browser
      // cancels the pointer once it starts panning; until it does, the element
      // must not follow the finger.
      if (drag.mode === 'move' && Math.abs(screenDx) <= Math.abs(screenDy)) return;
      drag.pending = false;
    }

    const point = { x: screen.x / scale, y: screen.y / scale };
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    const width = documentWidthPx(controller.document);
    const height = documentHeightPx(controller.document);

    if (drag.mode === 'move') {
      const prefsNow = prefs();
      const xTargets = [0, Math.round((width - drag.origin.w) / 2), width - drag.origin.w];
      const yTargets = [0, Math.round((height - drag.origin.h) / 2), height - drag.origin.h];
      const stepPx = gridStepPx();
      const x = snapPosition({
        value: drag.origin.x + dx,
        limit: width,
        size: drag.origin.w,
        targets: xTargets,
        stepPx,
        tolerance: CONFIG.geometry.snapTolerancePx,
        enabled: prefsNow.snap,
      });
      const y = snapPosition({
        value: drag.origin.y + dy,
        limit: height,
        size: drag.origin.h,
        targets: yTargets,
        stepPx,
        tolerance: CONFIG.geometry.snapTolerancePx,
        enabled: prefsNow.snap,
      });
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;
      controller.updateElement(drag.id, { x, y }, { coalesceKey: drag.coalesceKey, coalesceMs: Infinity });
    } else {
      const box = resizeBox({
        origin: drag.origin,
        handle: drag.handle,
        dx,
        dy,
        minSize: CONFIG.geometry.minElementPx,
        maxWidth: width,
        maxHeight: height,
      });
      drag.moved = true;
      controller.updateElement(drag.id, box, { coalesceKey: drag.coalesceKey, coalesceMs: Infinity });
    }
    render();
  }

  function onPointerUp(event) {
    if (touchPoints.has(event.pointerId)) {
      touchPoints.delete(event.pointerId);
      if (touchPoints.size < 2 && pan) {
        pan = null;
        if (!drag) overlayCanvas.dataset.mode = 'default';
      }
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    const id = drag.id;
    drag = null;
    overlayCanvas.dataset.mode = 'default';
    overlayCanvas.style.cursor = '';
    releasePointer(event.pointerId);
    if (touchPoints.size === 0) pan = null;
    const element = controller.document.elements.find((item) => item.id === id);
    if (element) log.debug('element committed', { id, x: element.x, y: element.y, w: element.w, h: element.h });
    render();
  }

  function onPointerCancel(event) {
    if (touchPoints.has(event.pointerId)) touchPoints.delete(event.pointerId);
    if (pan && touchPoints.size < 2) {
      pan = null;
      if (!drag) overlayCanvas.dataset.mode = 'default';
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    cancelDrag();
  }

  overlayCanvas.addEventListener('pointerdown', onPointerDown);
  overlayCanvas.addEventListener('pointermove', onPointerMove);
  overlayCanvas.addEventListener('pointerup', onPointerUp);
  overlayCanvas.addEventListener('pointercancel', onPointerCancel);
  overlayCanvas.addEventListener('lostpointercapture', onPointerCancel);

  return {
    render,
    invalidate() {
      lastDocument = null;
      lastOptionsKey = null;
    },
    localBox,
  };
}
