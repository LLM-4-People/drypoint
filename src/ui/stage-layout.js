/**
 * Stage layout decisions, DOM-free so they can be tested without a browser.
 *
 * The compact layout moves the label name, the stage and the inspector into
 * different containers; the fit scale subtracts a different gutter depending
 * on the layout. main.js measures the viewport and applies what this module
 * decides — nothing here touches the DOM.
 */

import { CONFIG } from '../core/config.js';

/** Gutter reserved around the label inside the stage viewport, in CSS px. */
export const STAGE_MARGINS = Object.freeze({
  compact: Object.freeze({ width: 24, height: 16 }),
  // .stage-scroll { padding: 8px 24px 20px }: the horizontal gutter is twice
  // the side padding, the vertical one is top + bottom.
  desktop: Object.freeze({ width: 48, height: 28 }),
});

/**
 * Where each movable region lives for a layout width.
 * @param {{compact?: boolean}} [options]
 */
export function placementPlan({ compact = false } = {}) {
  const value = Boolean(compact);
  return {
    /** Label name sits in the stage bar instead of the top bar. */
    docNameInStage: value,
    /** Stage is the workspace's first child instead of following the sidebar. */
    stageBeforeSidebar: value,
    /** Inspector sits under the add rail instead of as the last workspace column. */
    inspectorAfterRail: value,
  };
}

/**
 * Largest scale at which the label fits the viewport, or null when the
 * viewport has no usable area. `availableWidth`/`availableHeight` are the raw
 * container measurements; the layout's own gutter is subtracted here.
 */
export function fitScale({ docWidth, docHeight, availableWidth, availableHeight, compact = false }) {
  const margin = compact ? STAGE_MARGINS.compact : STAGE_MARGINS.desktop;
  const width = Number(availableWidth) - margin.width;
  const height = Number(availableHeight) - margin.height;
  if (!(docWidth > 0) || !(docHeight > 0) || !(width > 0) || !(height > 0)) return null;
  return Math.min(width / docWidth, height / docHeight);
}

/**
 * The scale a Fit action should apply. One floored path for both layouts: a
 * fitted 1.471 must become 1.4, never 1.5 (which is 16 px wider than the
 * stage), and it may go below the manual zoom floor because Fit promises the
 * whole label, not a comfortable size. `fitMin` no longer bounds Fit; it stays
 * the manual zoom floor.
 */
export function fitZoom({ docWidth, docHeight, availableWidth, availableHeight, compact = false }) {
  const scale = fitScale({ docWidth, docHeight, availableWidth, availableHeight, compact });
  if (scale === null) return null;
  return Math.min(CONFIG.ui.zoom.fitMax, Math.max(CONFIG.ui.previewMinScale, Math.floor(scale * 10) / 10));
}

/**
 * Validate a persisted zoom against the bounds the zoom control uses.
 *
 * A corrupt or hand-edited value must not produce "Infinity%", a negative
 * scale or a 0×0 canvas: a missing or non-finite value falls back to the
 * default and any other finite value is clamped.
 */
export function clampZoom(value) {
  if (value === null || value === undefined || value === '') return CONFIG.ui.zoom.default;
  const number = Number(value);
  if (!Number.isFinite(number)) return CONFIG.ui.zoom.default;
  return Math.min(CONFIG.ui.zoom.max, Math.max(CONFIG.ui.zoom.min, number));
}

/**
 * The manual zoom bounds for the current layout. Compact previews may go down
 * to `previewMinScale` because a whole phone-width label is better than a
 * clipped one; the desktop floor stays at `zoom.min`.
 */
export function zoomLimits({ compact = false } = {}) {
  return {
    min: compact ? CONFIG.ui.previewMinScale : CONFIG.ui.zoom.min,
    max: CONFIG.ui.zoom.max,
    step: CONFIG.ui.zoom.step,
  };
}

/**
 * One quantized manual zoom step (buttons and keyboard).
 *
 * The floor follows the value already on screen: after Fit put a 200 mm label
 * at 20%, Zoom out must stay at 20%, not jump up to the 50% manual floor.
 */
export function stepZoom(current, delta, { compact = false } = {}) {
  const limits = zoomLimits({ compact });
  const min = Math.min(current, limits.min);
  const target = current + delta;
  return Math.min(limits.max, Math.max(min, Math.round(target * 10) / 10));
}

/**
 * One wheel/trackpad zoom step, deliberately unquantized: a pinch or a
 * trackpad produces deltas far below the 0.1 button step, and rounding each
 * event back to the same tenth made 40 small events change nothing.
 */
export function wheelZoom(current, deltaY, { compact = false } = {}) {
  const limits = zoomLimits({ compact });
  const min = Math.min(current, limits.min);
  return Math.min(limits.max, Math.max(min, current - deltaY * CONFIG.ui.wheelZoomStep));
}

/**
 * Whether a viewport change may move the zoom. An automatic fit follows the
 * stage; a deliberate user zoom survives a plain resize and is only replaced
 * when the layout breakpoint itself changes (the stage has a different size).
 */
export function shouldClampZoom({ zoom, autoZoom, breakpointChanged }) {
  return breakpointChanged || zoom === autoZoom;
}
