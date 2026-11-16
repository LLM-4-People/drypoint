/**
 * The one headless-Chromium screenshot step for generated raster assets.
 *
 * `scripts/build-icons.mjs` and `scripts/build-social.mjs` both turn authored
 * SVG into a PNG at an exact pixel size. A second copy of the browser flags
 * would let one asset drift from the other, so the invocation lives here; the
 * caller still owns the HTML wrapper, and therefore the artwork and its layout.
 *
 * The window size is the screenshot size: the wrapper must paint the whole
 * viewport, and `--hide-scrollbars` keeps a scrollbar out of the capture.
 * `backgroundColor` is the eight-digit ARGB Chromium uses, so an opaque card
 * has no unpainted pixel at its edge.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CHROME } from './chrome.mjs';
import { decodePng } from './png.mjs';

/**
 * Render one HTML document to a PNG at exactly `width` by `height` pixels.
 *
 * @param {{
 *   html: string,
 *   width: number,
 *   height: number,
 *   directory: string,
 *   name: string,
 *   backgroundColor?: string|null,
 *   chrome?: string,
 * }} options
 * @returns {Promise<{image: {width:number, height:number, data:Buffer}, png: Buffer}>}
 */
export async function screenshotHtml({
  html,
  width,
  height,
  directory,
  name,
  backgroundColor = null,
  chrome = CHROME,
}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('a screenshot needs a positive integer width and height');
  }
  if (!chrome) throw new Error('Chromium is required to render this asset: set D110_CHROME or CHROME_PATH');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`a screenshot name must be path-safe: ${name}`);
  if (backgroundColor !== null && !/^[0-9a-fA-F]{8}$/.test(backgroundColor)) {
    throw new Error(`a screenshot background is eight ARGB hex digits: ${backgroundColor}`);
  }
  const page = join(directory, `${name}.html`);
  const shot = join(directory, `${name}.png`);
  await writeFile(page, html);
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars'];
  if (backgroundColor) args.push(`--default-background-color=${backgroundColor}`);
  args.push(`--window-size=${width},${height}`, `--screenshot=${shot}`, pathToFileURL(page).href);
  execFileSync(chrome, args, { stdio: 'ignore' });
  const png = await readFile(shot);
  return { image: decodePng(png), png };
}
