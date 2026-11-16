/**
 * Pure canvas manipulation rules: corner handles, snapping and anchor-aware
 * resizing. Kept free of DOM so the editor's geometry is unit-testable.
 */

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/format.js';

/** Resize cursor for each corner: the diagonal the handle moves along. */
const HANDLE_CURSORS = Object.freeze({
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
});

export function cornersOf(x, y, w, h) {
  return [
    { x, y, name: 'nw' },
    { x: x + w, y, name: 'ne' },
    { x, y: y + h, name: 'sw' },
    { x: x + w, y: y + h, name: 'se' },
  ];
}

export function cursorForHandle(handle) {
  return HANDLE_CURSORS[handle] ?? 'default';
}

/** The corner within `radius` screen pixels of a point, or null. */
export function handleAt(corners, point, radius) {
  return corners.find((corner) => Math.abs(corner.x - point.x) <= radius && Math.abs(corner.y - point.y) <= radius) ?? null;
}

/**
 * Hit radius for a resize handle. A mouse gets half the 18 px drawn handle;
 * the hit box is the handle, not a halo. A coarse pointer has no such
 * precision, so a finger gets the larger touch target; the drawing stays 18 px.
 */
export function handleHitRadius(pointerType) {
  return pointerType === 'mouse' ? CONFIG.geometry.handleSizePx / 2 : CONFIG.geometry.touchHandleRadiusPx;
}

/**
 * Snap a moving box's origin. Alignment targets win inside the tolerance;
 * otherwise the value lands on the grid step. The result stays in bounds.
 */
export function snapPosition({ value, limit, size, targets = [], stepPx, tolerance, enabled }) {
  if (enabled && Number.isFinite(stepPx) && stepPx > 0) {
    for (const target of targets) {
      if (Math.abs(value - target) <= tolerance) return clamp(target, 0, limit - size);
    }
    return clamp(Math.round(value / stepPx) * stepPx, 0, limit - size);
  }
  return clamp(value, 0, limit - size);
}

/**
 * Resize a box from one corner. The edge opposite the dragged corner is the
 * anchor and never moves; the dragged edges are clamped to the label and the
 * minimum element size instead of translating the whole box.
 */
export function resizeBox({ origin, handle, dx, dy, minSize, maxWidth, maxHeight }) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;

  if (handle.includes('e')) right = clamp(origin.x + origin.w + dx, left + minSize, maxWidth);
  if (handle.includes('w')) left = clamp(origin.x + dx, 0, right - minSize);
  if (handle.includes('s')) bottom = clamp(origin.y + origin.h + dy, top + minSize, maxHeight);
  if (handle.includes('n')) top = clamp(origin.y + dy, 0, bottom - minSize);

  const x = Math.round(left);
  const y = Math.round(top);
  return {
    x,
    y,
    w: Math.max(minSize, Math.round(right) - x),
    h: Math.max(minSize, Math.round(bottom) - y),
  };
}
