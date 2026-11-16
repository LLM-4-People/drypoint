/**
 * The one accessible name for the design canvas.
 *
 * The canvas is the label itself: a screen-reader user cannot see it, so its
 * name has to carry the two facts the visual badge shows (the size) and how
 * much is on the label. The name is short on purpose: it is announced when the
 * image is reached, not a description of the drawing.
 */

import { round1 } from '../core/format.js';

/**
 * @param {{widthMm?: number, lengthMm?: number, count?: number}} [state]
 * @returns {string} a concise image name
 */
export function labelCanvasName({ widthMm = 0, lengthMm = 0, count = 0 } = {}) {
  const size = `${round1(widthMm)} × ${round1(lengthMm)} mm`;
  const elements = count === 1 ? '1 element' : `${Math.max(0, Math.trunc(count))} elements`;
  return `Label design, ${size}, ${elements}`;
}
