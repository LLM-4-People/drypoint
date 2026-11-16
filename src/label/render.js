/**
 * Document → canvas renderer. Draws at the printer's native resolution so the
 * preview and the print share one code path.
 */

import { CONFIG } from '../core/config.js';
import { createLogger } from '../core/log.js';
import { barcodeBarLayout, barcodeLayout, barcodeMinimumWidth, barcodeModules, BARCODE_MIN_MODULE_PX, BARCODE_QUIET_MODULES } from './barcode.js';
import { qrLayout, qrMatrix, QR_MIN_MODULE_PX, QR_QUIET_MODULES } from './qr.js';
import { alphaMask, ditherImageData } from './dither.js';
import { describeImageSource, getImage, imageState } from './images.js';
import { layoutTextElement, lineAnchor, blockTop, MAX_TEXT_LINES } from './text-layout.js';
import { documentHeightPx, documentWidthPx } from './schema.js';

const log = createLogger('label.render');

// "Segoe UI Symbol" carries monochrome pictographs; keeping it ahead of the
// colour emoji fonts makes emoji render as a single ink silhouette, while the
// colour fonts stay as the fallback for systems without the symbol face.
const FONT_STACK =
  'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Segoe UI Symbol", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

let measureCanvas = null;

/** The one owner of the font string: measurer and painter must agree on weight. */
function fontFor(sizePx, bold) {
  return `${bold ? 700 : 500} ${sizePx}px ${FONT_STACK}`;
}

/** Weight-aware measurer, so layout and painting use the same face. */
function measurer(bold) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  return (text, fontPx) => {
    ctx.font = fontFor(fontPx, bold);
    return ctx.measureText(text || ' ').width;
  };
}

function isQuarterTurn(rotation) {
  return rotation === 90 || rotation === 270;
}

/** Local box for an element after its rotation is applied. */
export function localBox(element) {
  return isQuarterTurn(element.rotation) ? { w: element.h, h: element.w } : { w: element.w, h: element.h };
}

/**
 * Integer origin for a symbol centred in its box. Odd leftover pixels are
 * split unevenly; flooring keeps every module edge on a whole dot, because a
 * fractional origin turns 2-dot modules into 3:1 dark runs that fail to scan.
 */
function centredOrigin(boxExtent, drawnExtent) {
  return Math.floor((boxExtent - drawnExtent) / 2);
}

function withRotation(ctx, element, draw) {
  const { x, y, w, h } = element;
  const local = localBox(element);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(((element.rotation ?? 0) * Math.PI) / 180);
  ctx.translate(-local.w / 2, -local.h / 2);
  ctx.beginPath();
  ctx.rect(0, 0, local.w, local.h);
  ctx.clip();
  draw(local.w, local.h);
  ctx.restore();
}

function textAlignOf(align) {
  return align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
}

function drawText(ctx, element, boxW, boxH, warnings) {
  // A blank label is never what the operator meant, and every other empty
  // element already warns. One owner for the text rule.
  if (!String(element.text ?? '').trim()) warnings.add('Text is empty');
  const layout = layoutTextElement({
    element,
    boxW,
    boxH,
    measureFor: measurer,
    min: CONFIG.geometry.autoFontMinPx,
    max: CONFIG.geometry.maxFontPx,
  });
  if (layout.overflow) warnings.add('Text does not fit its box');
  if (layout.truncated) warnings.add(`Text is limited to ${MAX_TEXT_LINES} lines`);

  // Paint the glyphs onto a transparent mask first. Colour emoji carry bright
  // RGB, so a luminance threshold would erase them; alpha tells us exactly
  // which pixels the font drew.
  const mask = document.createElement('canvas');
  mask.width = Math.max(1, Math.ceil(boxW));
  mask.height = Math.max(1, Math.ceil(boxH));
  const maskCtx = mask.getContext('2d', { willReadFrequently: true });
  maskCtx.font = fontFor(layout.fontPx, element.bold);
  maskCtx.textAlign = textAlignOf(element.align);
  maskCtx.textBaseline = 'middle';
  maskCtx.fillStyle = '#000000';
  const anchor = lineAnchor(element.align, boxW);
  const top = blockTop(element.valign, boxH, layout.totalHeight);
  layout.lines.forEach((line, index) => {
    maskCtx.fillText(line, anchor, top + layout.lineHeight * (index + 0.5));
  });
  const imageData = maskCtx.getImageData(0, 0, mask.width, mask.height);
  alphaMask(imageData, CONFIG.print.alphaCut);
  maskCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(mask, 0, 0);
}

function drawQr(ctx, element, boxW, boxH) {
  let matrix;
  try {
    matrix = qrMatrix(element.value ?? '', element.ecLevel);
  } catch {
    // layoutWarnings already reported why this symbol cannot print.
    return;
  }
  const layout = qrLayout(Math.min(boxW, boxH), matrix.count);
  if (!layout.fits) return;
  const { modulePx, quietPx, drawnPx } = layout;
  // The quiet zone and the modules share one integer origin, so the white
  // border never lands on a half pixel either.
  const left = centredOrigin(boxW, drawnPx);
  const top = centredOrigin(boxH, drawnPx);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(left - quietPx, top - quietPx, drawnPx + quietPx * 2, drawnPx + quietPx * 2);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.count; row++) {
    for (let col = 0; col < matrix.count; col++) {
      if (matrix.isDark(row, col)) ctx.fillRect(left + col * modulePx, top + row * modulePx, modulePx, modulePx);
    }
  }
}

function drawBarcode(ctx, element, boxW, boxH, warnings) {
  let modules;
  try {
    modules = barcodeModules(element.symbology ?? 'code128', element.value ?? '');
  } catch {
    // layoutWarnings already reported why this symbol cannot print.
    return;
  }
  const layout = barcodeLayout(boxW, modules.length);
  if (!layout.fits) return;
  const { modulePx, drawnPx } = layout;
  // The caption may only take a strip whose glyphs are actually readable.
  // A floor larger than the strip painted the text into the bars; a strip
  // below the readable minimum is dropped and the bars keep the whole box. The
  // split is owned by barcodeBarLayout, shared with the layout warning.
  const { withText, hriPx, barHeight } = barcodeBarLayout(boxH, element.showText);
  if (element.showText && !withText) {
    warnings.add('Barcode text is hidden: the box is too short for a readable caption');
  }
  const left = centredOrigin(boxW, drawnPx);
  ctx.fillStyle = '#000000';
  for (let i = 0; i < modules.length; i++) {
    if (modules[i]) ctx.fillRect(left + i * modulePx, 0, modulePx, barHeight);
  }
  if (withText) {
    ctx.font = fontFor(hriPx, false);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(element.value, boxW / 2, boxH - 1);
  }
}

function drawImageElement(ctx, element, boxW, boxH, options, warnings) {
  if (!element.src) {
    warnings.add('Image has no source');
    return;
  }
  // A failed decode is cached, so "still loading" and "could not be decoded"
  // are distinguishable; both name the source so the operator can find it.
  const state = imageState(element.src);
  if (state !== 'ready') {
    const source = describeImageSource(element.src);
    warnings.add(state === 'failed' ? `Image ${source} could not be decoded` : `Image ${source} is still loading`);
    return;
  }
  const image = getImage(element.src);
  if (!image) {
    warnings.add(`Image ${describeImageSource(element.src)} is still loading`);
    return;
  }
  const scale =
    element.fit === 'stretch'
      ? { x: boxW / image.naturalWidth, y: boxH / image.naturalHeight }
      : element.fit === 'cover'
        ? (() => {
            const s = Math.max(boxW / image.naturalWidth, boxH / image.naturalHeight);
            return { x: s, y: s };
          })()
        : (() => {
            const s = Math.min(boxW / image.naturalWidth, boxH / image.naturalHeight);
            return { x: s, y: s };
          })();

  const drawnW = Math.max(1, Math.round(image.naturalWidth * scale.x));
  const drawnH = Math.max(1, Math.round(image.naturalHeight * scale.y));
  const stage = document.createElement('canvas');
  stage.width = Math.max(1, Math.round(boxW));
  stage.height = Math.max(1, Math.round(boxH));
  const stageCtx = stage.getContext('2d', { willReadFrequently: true });
  stageCtx.fillStyle = '#ffffff';
  stageCtx.fillRect(0, 0, stage.width, stage.height);
  stageCtx.imageSmoothingEnabled = true;
  stageCtx.drawImage(image, (boxW - drawnW) / 2, (boxH - drawnH) / 2, drawnW, drawnH);

  const mode = element.dither && element.dither !== 'auto' ? element.dither : options.dither;
  const processed = ditherImageData(stageCtx.getImageData(0, 0, stage.width, stage.height), mode, options.threshold);
  stageCtx.putImageData(processed, 0, 0);
  ctx.drawImage(stage, 0, 0);
}

/**
 * Path geometry for a rectangle element. A filled rectangle covers its whole
 * box; a stroke is inset by half its width so no edge falls outside the box or
 * disappears when the raster cuts at a fixed threshold.
 */
export function rectGeometry(element, boxW, boxH) {
  const radius = Math.max(0, Math.min(element.radiusPx ?? 0, Math.min(boxW, boxH) / 2));
  if (element.filled) return { x: 0, y: 0, w: boxW, h: boxH, radius, lineWidth: 0, collapsed: false };
  const lineWidth = Math.max(1, element.strokePx ?? 2);
  const inset = lineWidth / 2;
  return {
    x: inset,
    y: inset,
    w: Math.max(0, boxW - lineWidth),
    h: Math.max(0, boxH - lineWidth),
    radius,
    lineWidth,
    // The stroke covers lineWidth at each edge, so the hole is
    // min(boxW, boxH) - 2 * lineWidth wide. When that reaches zero the frame
    // prints as a solid block instead of a visible outline.
    collapsed: lineWidth * 2 >= Math.min(boxW, boxH),
  };
}

function drawRect(ctx, element, boxW, boxH, warnings) {
  const geometry = rectGeometry(element, boxW, boxH);
  if (geometry.collapsed) warnings.add('Frame stroke is wider than the box, so it prints as a solid block');
  ctx.beginPath();
  if (geometry.radius > 0) ctx.roundRect(geometry.x, geometry.y, geometry.w, geometry.h, geometry.radius);
  else ctx.rect(geometry.x, geometry.y, geometry.w, geometry.h);
  if (element.filled) {
    ctx.fillStyle = '#000000';
    ctx.fill();
  } else {
    ctx.lineWidth = geometry.lineWidth;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }
}

/**
 * The single owner of render-option defaults. The painter and the canvas cache
 * key both resolve options through here, so a setting that changes the pixels
 * can never leave a stale cache entry behind.
 */
export function normaliseRenderOptions(options = {}) {
  return {
    dither: options.dither ?? 'threshold',
    threshold: Number.isFinite(options.threshold) ? options.threshold : CONFIG.print.thresholdDefault,
  };
}

/** Cache key for a resolved option set; dither and threshold change the pixels. */
export function renderOptionsKey(options = {}) {
  const { dither, threshold } = normaliseRenderOptions(options);
  return `${dither}:${threshold}`;
}

const ELEMENT_LABELS = Object.freeze({
  text: 'Text',
  qr: 'QR code',
  barcode: 'Barcode',
  image: 'Image',
  rect: 'Frame',
});

const SUPPRESSED_WARNINGS = /^… and (\d+) more$/;

/**
 * The one footer/dialog summary for a warning list. The stage footer shows the
 * first few plus a count; the print confirmation shows more. Truncation is by
 * whole warning, never by cutting a message in half.
 */
export function summariseWarnings(warnings, { limit = 3 } = {}) {
  const list = (Array.isArray(warnings) ? warnings : []).filter((warning) => typeof warning === 'string' && warning.trim());
  // `layoutWarnings` stops at the configured cap and appends one synthetic
  // "… and N more" entry. That entry is a count, not a warning: counting it
  // again produced "… and 1 more" whenever the limit matched the real cap.
  const tail = list.length ? SUPPRESSED_WARNINGS.exec(list.at(-1)) : null;
  const real = tail ? list.slice(0, -1) : list;
  const suppressed = tail ? Number(tail[1]) : 0;
  // The real warnings fit the limit, so the existing count entry stays as-is.
  if (real.length <= limit) return list.join(' · ');
  return `${real.slice(0, limit).join(' · ')} · … and ${real.length - limit + suppressed} more`;
}

/** Operator-facing name for one element: its name when set, else its type. */
function elementLabel(element) {
  const type = ELEMENT_LABELS[element.type] ?? element.type;
  const raw = typeof element.name === 'string' ? element.name.trim() : '';
  // Names come from the inspector and from imported files; a warning row is
  // not the place to render five thousand characters.
  const name = raw.length > CONFIG.bounds.warningNameChars ? `${raw.slice(0, CONFIG.bounds.warningNameChars - 1)}…` : raw;
  return name ? `${type} "${name}"` : type;
}

/** Axis-aligned boxes overlap with positive area (touching edges do not). */
function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when `outer` fully encloses `inner` (a frame around content). */
function boxContains(outer, inner) {
  return (
    inner.w > 0 &&
    inner.h > 0 &&
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

/**
 * True when `inner` sits inside a rounded-rectangle contour whose straight
 * edges are `opening` and whose corner radius is `radius`. A box may only
 * enter a corner square while its farthest point stays within the arc.
 */
function insideRoundedOpening(opening, radius, inner) {
  if (!boxContains(opening, inner)) return false;
  if (!(radius > 0)) return true;
  const points = [
    // `sx`/`sy` say which side of the corner centre the box edge is on.
    { cx: opening.x + radius, cy: opening.y + radius, x: inner.x, y: inner.y, sx: 1, sy: 1 },
    { cx: opening.x + opening.w - radius, cy: opening.y + radius, x: inner.x + inner.w, y: inner.y, sx: -1, sy: 1 },
    { cx: opening.x + radius, cy: opening.y + opening.h - radius, x: inner.x, y: inner.y + inner.h, sx: 1, sy: -1 },
    {
      cx: opening.x + opening.w - radius,
      cy: opening.y + opening.h - radius,
      x: inner.x + inner.w,
      y: inner.y + inner.h,
      sx: -1,
      sy: -1,
    },
  ];
  return points.every(({ cx, cy, x, y, sx, sy }) => {
    if ((cx - x) * sx <= 0 || (cy - y) * sy <= 0) return true;
    return Math.hypot(cx - x, cy - y) <= radius;
  });
}

/**
 * True when `rect` is a real background frame for `inner`.
 *
 * Only a stroked rectangle whose stroke has not collapsed leaves its contents
 * readable, and the content must sit inside the stroke's inner opening: the
 * stroke paints from the outer edge to `lineWidth`, so a 12 px stroke eats 12 px
 * at each edge, not 6. A rounded frame is tested against its inner rounded
 * contour (radius `radiusPx - lineWidth / 2`), because a corner arc covers more
 * than the rectangle it inscribes. A filled rectangle or a collapsed stroke
 * paints ink over whatever it was assumed to back.
 *
 * A quarter-turn leaves the painted axis-aligned rectangle unchanged (rotation
 * is about the centre and the stroke/radius are symmetric), so it is accepted.
 */
function frames(rect, inner) {
  if (rect.type !== 'rect' || rect.rotation % 90 !== 0 || rect.filled) return false;
  const stroke = rectGeometry(rect, rect.w, rect.h);
  if (stroke.collapsed) return false;
  const lineWidth = stroke.lineWidth;
  const opening = {
    x: rect.x + lineWidth,
    y: rect.y + lineWidth,
    w: rect.w - lineWidth * 2,
    h: rect.h - lineWidth * 2,
  };
  const innerRadius = Math.max(0, (rect.radiusPx ?? 0) - lineWidth / 2);
  return insideRoundedOpening(opening, innerRadius, inner);
}

/**
 * True when a later-painted symbol paints its own field over `rect`. A QR code
 * and an image draw a white backing inside their box, so a filled rectangle
 * behind one is a legitimate background rather than a black-on-black collision.
 */
function providesOwnField(element) {
  return element.type === 'qr' || element.type === 'image';
}

/**
 * Problems the document itself has before a single pixel is painted: visible
 * elements that sit on top of each other and symbols that cannot reach the
 * minimum module size. The pass reports; it never moves or resizes anything,
 * because a silent re-fit would change the label the operator authored.
 *
 * A frame or background rectangle that fully contains another element is
 * intentional (the framed template) and is not reported.
 * @returns {string[]} warnings in document order
 */
export function layoutWarnings(labelDocument) {
  const elements = (labelDocument?.elements ?? []).filter((element) => element.visible !== false);
  const max = CONFIG.bounds.maxWarnings;
  const seen = new Set();
  const messages = [];
  let suppressed = 0;
  /** Dedupe on insert and stop collecting (but keep counting) at the cap. */
  const add = (message) => {
    if (!message || seen.has(message)) return;
    if (seen.size >= max) {
      suppressed++;
      return;
    }
    seen.add(message);
    messages.push(message);
  };

  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      if (!boxesOverlap(a, b)) continue;
      if (frames(a, b) || frames(b, a)) continue;
      // Paint order matters: `b` is painted after `a`. A filled or collapsed
      // rect may back only a later symbol that clears its own white field.
      if (a.type === 'rect' && providesOwnField(b) && (a.filled || rectGeometry(a, a.w, a.h).collapsed)) continue;
      // The pair loop is quadratic: once the cap is reached, count the rest
      // without formatting an element label or a message string.
      if (seen.size >= max) {
        suppressed++;
        continue;
      }
      add(`${elementLabel(a)} and ${elementLabel(b)} overlap`);
    }
  }

  for (const element of elements) {
    const box = localBox(element);
    if (element.type === 'barcode') {
      let moduleCount;
      try {
        moduleCount = barcodeModules(element.symbology ?? 'code128', element.value ?? '').length;
      } catch (error) {
        add(`${elementLabel(element)}: ${error.message}`);
        continue;
      }
      const layout = barcodeLayout(box.w, moduleCount);
      if (!layout.fits) {
        add(
          `${elementLabel(element)} is too narrow: ${moduleCount} modules plus a ${BARCODE_QUIET_MODULES}-module quiet ` +
            `zone on each side need ${barcodeMinimumWidth(moduleCount)} px at ${BARCODE_MIN_MODULE_PX} px per module; ` +
            `the box is ${Math.round(box.w)} px`
        );
      }
      // USS-128/ISO 15417: the bars need 6.35 mm — 51 dots at 8 dots/mm — and
      // at least 15% of the symbol length, whichever is greater. The bar height
      // excludes the caption strip the painter reserves for the HRI.
      const { barHeight } = barcodeBarLayout(box.h, element.showText);
      const minimum = CONFIG.geometry.minBarcodeHeightPx;
      if (barHeight < minimum) {
        add(
          `${elementLabel(element)} is too short: a barcode needs at least ${minimum} px of bar height ` +
            `(6.35 mm); the box gives ${Math.round(barHeight)} px`
        );
      }
      // The 15% rule only means something for a symbol that actually fits: the
      // symbol length is the drawn module run from the one layout owner.
      if (layout.fits && layout.drawnPx * 0.15 > barHeight) {
        const needed = Math.ceil(layout.drawnPx * 0.15);
        add(
          `${elementLabel(element)} is too short: ${Math.round(barHeight)} px of bar height is below 15% of the ` +
            `${layout.drawnPx} px symbol length (${needed} px needed)`
        );
      }
      continue;
    }
    if (element.type === 'qr') {
      let matrix;
      try {
        matrix = qrMatrix(element.value ?? '', element.ecLevel);
      } catch (error) {
        add(`${elementLabel(element)}: ${error?.message ?? String(error)}`);
        continue;
      }
      const size = Math.min(box.w, box.h);
      if (!qrLayout(size, matrix.count).fits) {
        add(
          `${elementLabel(element)} is too dense: a ${matrix.count}-module symbol plus its ${QR_QUIET_MODULES}-module ` +
            `quiet zone needs ${(matrix.count + QR_QUIET_MODULES * 2) * QR_MIN_MODULE_PX} px at ${QR_MIN_MODULE_PX} px ` +
            `per module; the box is ${Math.round(size)} px`
        );
      }
    }
  }

  if (suppressed) messages.push(`… and ${suppressed} more`);
  return messages;
}

/**
 * Render a document to a fresh canvas at printer resolution.
 * @returns {{canvas: HTMLCanvasElement, warnings: string[]}}
 */
export function renderDocument(labelDocument, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = documentWidthPx(labelDocument);
  canvas.height = documentHeightPx(labelDocument);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';

  const settings = normaliseRenderOptions(options);
  const notices = Array.isArray(labelDocument?.notices) ? labelDocument.notices : [];
  const warnings = new Set([...layoutWarnings(labelDocument), ...notices]);

  for (const element of labelDocument.elements) {
    if (!element.visible) continue;
    try {
      withRotation(ctx, element, (boxW, boxH) => {
        switch (element.type) {
          case 'text':
            drawText(ctx, element, boxW, boxH, warnings);
            break;
          case 'qr':
            drawQr(ctx, element, boxW, boxH);
            break;
          case 'barcode':
            drawBarcode(ctx, element, boxW, boxH, warnings);
            break;
          case 'image':
            drawImageElement(ctx, element, boxW, boxH, settings, warnings);
            break;
          case 'rect':
            drawRect(ctx, element, boxW, boxH, warnings);
            break;
          default:
            warnings.add(`Unknown element type: ${element.type}`);
        }
      });
    } catch (error) {
      log.error('element failed to render', { id: element.id, type: element.type, message: error.message });
      warnings.add(`${element.type}: ${error.message}`);
    }
  }

  return { canvas, warnings: [...warnings] };
}
