/**
 * Code 128 (subset B) encoder. The 107-symbol table is pinned to the committed
 * JsBarcode fixture by test/code128-table.test.mjs.
 */

import { CONFIG } from '../core/config.js';

export const CODE128_PATTERNS = Object.freeze([
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
]);

const START_B = 104;
const STOP = 106;
const MODULO = 103;

export function code128Values(text) {
  if (!text.length) throw new Error('Barcode text is empty');
  const values = [START_B];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 32 || code > 126) throw new Error('Code 128 B supports printable ASCII (32-126) only');
    values.push(code - 32);
  }
  let checksum = values[0];
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % MODULO, STOP);
  return values;
}

export function code128Modules(text) {
  const modules = [];
  for (const value of code128Values(text)) {
    for (const bit of CODE128_PATTERNS[value]) modules.push(bit === '1' ? 1 : 0);
  }
  return modules;
}

/** Symbology registry: one owner for "value → module bitmap". */
export const SYMBOLOGIES = Object.freeze({
  code128: { label: 'Code 128', modules: code128Modules, validate: code128Values },
});

/** Below two dots per module a barcode is not readable on a 96-dot head. */
export const BARCODE_MIN_MODULE_PX = 2;

/**
 * Code 128 needs a 10-module quiet zone on each side of the symbol. The layout
 * reserves it inside the box so bars never run into the element edge.
 */
export const BARCODE_QUIET_MODULES = 10;

/**
 * How one barcode box divides between the bars and the optional caption. The
 * painter and the layout warning must agree on the bar height, so the rule has
 * one owner: the caption strip is capped, and it is only reserved when the HRI
 * would actually be readable.
 * @returns {{withText:boolean, strip:number, hriPx:number, barHeight:number}}
 */
export function barcodeBarLayout(boxH, showText) {
  const strip = showText ? Math.min(boxH * 0.3, 22) : 0;
  const hriPx = Math.floor(strip * 0.85);
  const withText = Boolean(showText) && hriPx >= CONFIG.geometry.minHriPx;
  return { withText, strip: withText ? strip : 0, hriPx, barHeight: withText ? boxH - strip : boxH };
}

/**
 * Module geometry for a barcode drawn inside a box. The box must hold the
 * symbol plus a quiet zone on both sides.
 * @returns {{modulePx:number, quietPx:number, drawnPx:number, fits:boolean}}
 */
export function barcodeLayout(widthPx, moduleCount) {
  if (!Number.isFinite(widthPx) || widthPx <= 0 || !Number.isFinite(moduleCount) || moduleCount <= 0) {
    return { modulePx: 0, quietPx: 0, drawnPx: 0, fits: false };
  }
  const modulePx = Math.floor(widthPx / (moduleCount + BARCODE_QUIET_MODULES * 2));
  return {
    modulePx,
    quietPx: modulePx * BARCODE_QUIET_MODULES,
    drawnPx: modulePx * moduleCount,
    fits: modulePx >= BARCODE_MIN_MODULE_PX,
  };
}

/** The narrowest box that renders a barcode with its quiet zones. */
export function barcodeMinimumWidth(moduleCount) {
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) return 0;
  return (moduleCount + BARCODE_QUIET_MODULES * 2) * BARCODE_MIN_MODULE_PX;
}

/**
 * The box a new barcode needs on a label, or a refusal with the numbers that
 * explain it. One owner for "can this label hold this barcode".
 * @returns {{fits:boolean, moduleCount:number, minimumWidthPx:number, availableWidthPx:number, w?:number, h?:number}}
 */
export function barcodeFrame({ labelWidthPx, labelHeightPx, paddingPx, value, symbology = 'code128' }) {
  const moduleCount = barcodeModules(symbology, value).length;
  const minimumWidthPx = barcodeMinimumWidth(moduleCount);
  const availableWidthPx = labelWidthPx - paddingPx * 2;
  if (!Number.isFinite(availableWidthPx) || availableWidthPx < minimumWidthPx) {
    return { fits: false, moduleCount, minimumWidthPx, availableWidthPx };
  }
  return {
    fits: true,
    moduleCount,
    minimumWidthPx,
    availableWidthPx,
    w: minimumWidthPx,
    h: labelHeightPx - paddingPx * 2,
  };
}

/** Operator-facing explanation for a label that cannot hold a barcode. */
export function barcodeFitMessage({ minimumWidthPx, availableWidthPx, dotsPerMm }) {
  const mm = (px) => Math.round((px / dotsPerMm) * 10) / 10;
  return (
    `A barcode needs at least ${minimumWidthPx} px (${mm(minimumWidthPx)} mm) of label width; ` +
    `this label has ${availableWidthPx} px (${mm(availableWidthPx)} mm). ` +
    'Lengthen the label or shorten the barcode.'
  );
}

export function barcodeModules(symbology, value) {
  const entry = SYMBOLOGIES[symbology];
  if (!entry) throw new Error(`Unsupported barcode type: ${symbology}`);
  return entry.modules(value);
}

export function validateBarcode(symbology, value) {
  const entry = SYMBOLOGIES[symbology];
  if (!entry) throw new Error(`Unsupported barcode type: ${symbology}`);
  entry.validate(value);
  return true;
}
