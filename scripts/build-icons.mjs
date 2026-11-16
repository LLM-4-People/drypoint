#!/usr/bin/env node
/**
 * Single owner of the generated icon PNGs.
 *
 * `brand.json` → `scripts/build-brand.mjs` renders `assets/icon.svg`; this
 * script rasterises that one artwork into every PNG the manifest declares.
 * An `any` icon keeps the transparent corners the artwork draws; a `maskable`
 * icon is the same artwork flattened onto the artwork's own background so a
 * launcher mask never shows transparent paint.
 *
 * `--write` needs Chromium (the same discovery rule as the browser suites).
 * `--check` is pure Node: dimensions, corner alpha, the maskable safe zone,
 * the maskable flattening, and the Android drawable bytes. It runs in `verify`.
 *
 * Usage:
 *   node scripts/build-icons.mjs --write
 *   node scripts/build-icons.mjs --check
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_ICONS } from './build-brand.mjs';
import { syncResources } from './build-android.mjs';
import { CHROME } from './lib/chrome.mjs';
import { decodePng, encodePng, flattenOnto, pixelAt } from './lib/png.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const ARTWORK = 'assets/icon.svg';
/** The safe circle an Android adaptive mask guarantees: 80% of the short side. */
export const MASKABLE_SAFE_ZONE_RATIO = 0.4;
/** Written into every PNG as a generated-by marker. */
export const GENERATED_BY = 'scripts/build-icons.mjs';

/** The PNG outputs derived from the one manifest icon list. */
export function pngIcons(icons = MANIFEST_ICONS) {
  return icons
    .filter((icon) => icon.type === 'image/png')
    .map((icon) => {
      const match = /^(\d+)x(\d+)$/.exec(icon.sizes);
      if (!match) throw new Error(`${icon.src}: sizes must be WIDTHxHEIGHT, found ${JSON.stringify(icon.sizes)}`);
      return { src: icon.src, width: Number(match[1]), height: Number(match[2]), maskable: icon.purpose === 'maskable' };
    });
}

/** The nearest transparent base for one maskable PNG (same pixel size). */
function transparentBaseFor(icon, icons) {
  return icons.find((entry) => !entry.maskable && entry.width === icon.width && entry.height === icon.height) ?? null;
}

/**
 * Render the one SVG at an exact pixel size with a transparent backdrop.
 * @param {{src:string, width:number, height:number}} icon
 * @param {string} artwork absolute SVG path
 * @param {string} directory scratch directory
 * @returns {Promise<{width:number, height:number, data:Buffer}>}
 */
async function renderTransparent(icon, artwork, directory) {
  const page = join(directory, `${basename(icon.src)}.html`);
  const shot = join(directory, `${basename(icon.src)}.png`);
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${icon.width}px;height:${icon.height}px;overflow:hidden;background:transparent}
img{display:block;width:${icon.width}px;height:${icon.height}px}
</style><img src="${pathToFileURL(artwork).href}">`
  );
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${icon.width},${icon.height}`,
      `--screenshot=${shot}`,
      pathToFileURL(page).href,
    ],
    { stdio: 'ignore' }
  );
  return decodePng(await readFile(shot));
}

/** The artwork's opaque background, sampled from its straight left edge. */
export function artworkBackground(image) {
  const pixel = pixelAt(image, 0, Math.floor(image.height / 2));
  if (pixel.a !== 255) throw new Error('the artwork has no opaque edge to flatten a maskable icon onto');
  if (pixel.r > 200 && pixel.g > 200 && pixel.b > 200) {
    throw new Error('the artwork edge is not a background colour');
  }
  return { r: pixel.r, g: pixel.g, b: pixel.b };
}

/**
 * Build every PNG in memory, including the transparent base a maskable icon is
 * flattened from.
 * @param {{root?: string, render?: Function}} [options]
 * @returns {Promise<{files: Map<string, Buffer>, artwork: object}>}
 */
export async function buildIcons({
  root = ROOT,
  render = renderTransparent,
} = {}) {
  const icons = pngIcons();
  const artwork = join(root, ARTWORK);
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-icons-'));
  try {
    const rendered = new Map();
    for (const icon of icons.filter((entry) => !entry.maskable)) {
      rendered.set(icon.src, await render(icon, artwork, directory));
    }
    for (const icon of icons.filter((entry) => entry.maskable)) {
      const base = transparentBaseFor(icon, icons);
      if (!base) throw new Error(`${icon.src}: a maskable icon needs a same-size transparent base`);
      const image = rendered.get(base.src);
      if (!image) throw new Error(`${base.src}: the transparent base was not rendered`);
      rendered.set(icon.src, flattenOnto(image, artworkBackground(image)));
    }
    const files = new Map();
    for (const icon of icons) {
      const image = rendered.get(icon.src);
      files.set(icon.src, encodePng({ ...image, software: GENERATED_BY }));
    }
    return { files };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Pure-Node findings for one icon set on disk.
 * @param {{root?: string, androidDrawable?: Function}} [options]
 * @returns {Promise<{findings: string[], checked: number}>}
 */
export async function checkIcons({ root = ROOT, androidDrawable = true } = {}) {
  const findings = [];
  const icons = pngIcons();
  const images = new Map();
  for (const icon of icons) {
    let image;
    try {
      image = decodePng(await readFile(join(root, icon.src)));
    } catch (error) {
      findings.push(`${icon.src}: ${error.message}`);
      continue;
    }
    images.set(icon.src, image);
    if (image.width !== icon.width || image.height !== icon.height) {
      findings.push(`${icon.src}: ${image.width}x${image.height}, expected ${icon.width}x${icon.height}`);
    }
    const corners = [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ];
    if (icon.maskable) {
      for (const [x, y] of corners) {
        if (pixelAt(image, x, y).a !== 255) findings.push(`${icon.src}: maskable corner (${x},${y}) has alpha ${pixelAt(image, x, y).a}, expected 255`);
      }
      for (let y = 0; y < image.height && findings.length < 20; y++) {
        for (let x = 0; x < image.width; x++) {
          if (pixelAt(image, x, y).a !== 255) {
            findings.push(`${icon.src}: maskable pixel (${x},${y}) is not opaque`);
            break;
          }
        }
      }
      const centre = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
      if (centre.a !== 255) findings.push(`${icon.src}: maskable centre is transparent`);
    } else {
      for (const [x, y] of corners) {
        const pixel = pixelAt(image, x, y);
        if (pixel.a !== 0) findings.push(`${icon.src}: transparent corner (${x},${y}) has alpha ${pixel.a}, expected 0`);
      }
      const centre = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
      if (centre.a === 0) findings.push(`${icon.src}: the centre is transparent`);
    }
  }

  for (const icon of icons.filter((entry) => entry.maskable)) {
    const image = images.get(icon.src);
    const base = transparentBaseFor(icon, icons);
    if (!image || !base) continue;
    const source = images.get(base.src);
    if (!source) continue;
    let background;
    try {
      background = artworkBackground(source);
    } catch (error) {
      findings.push(`${base.src}: ${error.message}`);
      continue;
    }
    // The safe circle is what a launcher mask guarantees the user can see:
    // every pixel that is not the flat background must stay inside it.
    const centreX = image.width / 2;
    const centreY = image.height / 2;
    const radius = Math.min(image.width, image.height) * MASKABLE_SAFE_ZONE_RATIO;
    let outside = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const pixel = pixelAt(image, x, y);
        if (pixel.a !== 255) continue;
        // The rasteriser's edge pixels can differ from the flat background by
        // one code value; only meaningful artwork has to stay in the safe
        // circle, not that subpixel noise.
        const nearBackground =
          Math.abs(pixel.r - background.r) <= 2 &&
          Math.abs(pixel.g - background.g) <= 2 &&
          Math.abs(pixel.b - background.b) <= 2;
        if (nearBackground) continue;
        if (Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY) > radius) outside++;
      }
    }
    if (outside) findings.push(`${icon.src}: ${outside} artwork pixels fall outside the ${Math.round(radius)} px maskable safe circle`);
    // The maskable is the transparent base flattened onto the artwork colour,
    // so a stale copy (or one drawn from another source) is caught here.
    const expected = flattenOnto(source, background);
    let mismatch = 0;
    for (let at = 0; at < expected.data.length; at += 4) {
      if (
        image.data[at] !== expected.data[at] ||
        image.data[at + 1] !== expected.data[at + 1] ||
        image.data[at + 2] !== expected.data[at + 2] ||
        image.data[at + 3] !== expected.data[at + 3]
      ) {
        mismatch++;
        if (mismatch > 32) break;
      }
    }
    if (mismatch) findings.push(`${icon.src}: is not ${base.src} flattened onto its artwork background`);
  }

  if (androidDrawable) {
    // The APK's launcher drawable is the 192 px icon copied byte-for-byte; the
    // owner that generates the icon also proves the copy rule still holds.
    const directory = await mkdtemp(join(tmpdir(), 'drypoint-icons-res-'));
    try {
      await syncResources(directory);
      const drawable = await readFile(join(directory, 'res', 'drawable', 'app_icon.png'));
      const authored = await readFile(join(root, 'assets', 'icon-192.png'));
      if (!drawable.equals(authored)) findings.push('the Android drawable is not assets/icon-192.png byte-for-byte');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { findings, checked: icons.length };
}

async function writeIcons({ root = ROOT } = {}) {
  if (!CHROME) throw new Error('Chromium is required to regenerate the icons: set D110_CHROME or CHROME_PATH');
  const { files } = await buildIcons({ root });
  for (const [file, bytes] of files) {
    const target = join(root, file);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
  return { files: [...files.keys()] };
}

async function main(argv) {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--write' && flag !== '--check');
  if (unknown.length) {
    console.error(`icons: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/build-icons.mjs [--write|--check]');
    return 2;
  }
  try {
    if (flags.includes('--write')) {
      const { files } = await writeIcons();
      const result = await checkIcons();
      if (result.findings.length) {
        for (const finding of result.findings) console.error(`icons: ${finding}`);
        return 1;
      }
      console.log(`icons: wrote ${files.join(', ')} (${result.checked} files checked)`);
      return 0;
    }
    const result = await checkIcons();
    if (!result.findings.length) {
      console.log(`icons: up to date (${result.checked} PNGs)`);
      return 0;
    }
    for (const finding of result.findings) console.error(`icons: ${finding}`);
    console.error('icons: a generated icon is stale — run: npm run build:icons -- --write');
    return 1;
  } catch (error) {
    console.error(`icons: ${error.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
