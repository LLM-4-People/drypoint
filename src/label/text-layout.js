/**
 * Text fitting and layout, independent of canvas so it can be unit-tested with
 * an injected measurement function.
 */

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/format.js';

/** A text box never renders more than this many lines. */
export const MAX_TEXT_LINES = 24;

/**
 * Sub-pixel slack allowed before a block is reported as overflowing. Canvas
 * advances are fractional, so a line that measures a hair over its box still
 * prints without clipping; tightening this would raise false warnings.
 */
const OVERFLOW_TOLERANCE_PX = 0.5;

/**
 * @returns {{lines:string[], truncated:boolean}} the visible lines and whether
 * the source had more lines than the box can print.
 */
export function splitLines(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  return { lines: lines.slice(0, MAX_TEXT_LINES), truncated: lines.length > MAX_TEXT_LINES };
}

/**
 * @param {object} options
 * @param {string[]} options.lines
 * @param {number} options.boxW
 * @param {number} options.boxH
 * @param {(text:string, fontPx:number)=>number} options.measure
 * @param {number} [options.min]
 * @param {number} [options.max]
 */
export function fitFontSize({
  lines,
  boxW,
  boxH,
  measure,
  min = CONFIG.geometry.autoFontMinPx,
  max = CONFIG.geometry.autoFontMaxPx,
  slackRatio = CONFIG.geometry.alignmentSlackRatio,
}) {
  const lineHeight = CONFIG.geometry.lineHeight;
  // Auto-size aims at the box minus the alignment reserve, so the block keeps
  // real vertical travel instead of filling the box to within a pixel.
  const ratio = Number.isFinite(slackRatio) ? clamp(slackRatio, 0, 0.9) : 0;
  const usableHeight = boxH * (1 - ratio);
  const fits = (fontPx) => {
    const height = lines.length * fontPx * lineHeight;
    if (height > usableHeight) return false;
    for (const line of lines) if (measure(line, fontPx) > boxW) return false;
    return true;
  };
  let low = min;
  let high = max;
  if (!fits(low)) return low;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Resolve the geometry of a text element inside its local (unrotated) box.
 * @returns {{fontPx:number, lineHeight:number, widths:number[], totalHeight:number, overflow:boolean, truncated:boolean, lines:string[]}}
 */
export function layoutText({ text, fontPx, boxW, boxH, measure, min, max }) {
  const { lines, truncated } = splitLines(text);
  // Auto-size is capped below the manual maximum and reserves the alignment
  // ratio, so the block keeps vertical slack that valign can move through.
  const size =
    fontPx > 0
      ? clamp(fontPx, CONFIG.geometry.minFontPx, max ?? CONFIG.geometry.maxFontPx)
      : fitFontSize({ lines, boxW, boxH, measure, min, max: CONFIG.geometry.autoFontMaxPx });
  const lineHeight = size * CONFIG.geometry.lineHeight;
  const widths = lines.map((line) => measure(line, size));
  const totalHeight = lines.length * lineHeight;
  const overflow = totalHeight > boxH + OVERFLOW_TOLERANCE_PX || Math.max(0, ...widths) > boxW + OVERFLOW_TOLERANCE_PX;
  return { fontPx: size, lineHeight, widths, totalHeight, overflow, truncated, lines };
}

/**
 * Layout an element with a weight-aware measurer. The painter and the measurer
 * must share the same font weight: sizing bold text against a lighter face is
 * what made painted bold lines overflow their box.
 * @param {object} options
 * @param {object} options.element text element
 * @param {(bold:boolean)=>(text:string, fontPx:number)=>number} options.measureFor
 */
export function layoutTextElement({ element, boxW, boxH, measureFor, min, max }) {
  return layoutText({
    text: element.text,
    fontPx: element.fontPx,
    boxW,
    boxH,
    measure: measureFor(Boolean(element.bold)),
    min,
    max,
  });
}

/** Horizontal anchor for one line, given the box width and alignment. */
export function lineAnchor(align, boxW) {
  if (align === 'left') return 0;
  if (align === 'right') return boxW;
  return boxW / 2;
}

/** Vertical offset of the first line's centre, given the box height and valign. */
export function blockTop(valign, boxH, totalHeight) {
  if (valign === 'top') return 0;
  if (valign === 'bottom') return boxH - totalHeight;
  return (boxH - totalHeight) / 2;
}
