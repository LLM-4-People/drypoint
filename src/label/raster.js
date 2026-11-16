/**
 * Canvas → printer raster.
 *
 * The editor works in landscape (length × 96 px). The print head is 96 dots
 * wide and feeds along the length, so the bitmap is transposed here — the one
 * place where the two coordinate systems meet.
 */

import { CONFIG } from '../core/config.js';
import { luminanceAt } from './dither.js';

/**
 * @param {HTMLCanvasElement} canvas landscape label, `length × 96` px
 * @returns {{width:number, height:number, rows:Uint8Array[]}} printer raster, 96 wide
 */
export function canvasToRaster(canvas) {
  const source = canvas.width;
  const sourceHeight = canvas.height;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, source, sourceHeight);
  const width = sourceHeight;
  const height = source;
  const stride = Math.ceil(width / 8);
  const rows = new Array(height);
  // The final 1-bit cut is fixed. The user threshold belongs to image
  // dithering only; letting it reach this pass dropped small antialiased text
  // when the user chose a low image threshold.
  const cut = CONFIG.print.rasterCut;

  for (let row = 0; row < height; row++) {
    const bits = new Uint8Array(stride);
    for (let col = 0; col < width; col++) {
      // landscape (x = row, y = width-1-col) -> portrait (col, row)
      const x = row;
      const y = width - 1 - col;
      if (luminanceAt(data, (y * source + x) * 4) < cut) bits[col >> 3] |= 0x80 >> (col & 7);
    }
    rows[row] = bits;
  }
  return { width, height, rows };
}

/** Count of printed (black) dots, used for ink estimation and tests. */
export function rasterInk(raster) {
  let dots = 0;
  for (const row of raster.rows) {
    for (const byte of row) {
      let value = byte;
      while (value) {
        dots += value & 1;
        value >>= 1;
      }
    }
  }
  return dots;
}
