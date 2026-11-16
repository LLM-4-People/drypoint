/**
 * The app icons: real transparency for the ordinary icon, a fully opaque
 * maskable icon, one artwork for two distributions, and one generator.
 *
 * The PNGs are rasterised from `assets/icon.svg` by `scripts/build-icons.mjs`.
 * They used to be flat RGB with white paint in the corners, which looks
 * identical on a white page and wrong on every launcher that draws a dark
 * surface, so these tests read the pixels instead of trusting the file size:
 * colour type 6 (RGBA), bit depth 8, transparent corners on `any`, opaque
 * corners and a safe-zone-contained artwork on `maskable`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncResources } from '../scripts/build-android.mjs';
import { MANIFEST_ICONS } from '../scripts/build-brand.mjs';
import { MASKABLE_SAFE_ZONE_RATIO, checkIcons, pngIcons } from '../scripts/build-icons.mjs';
import { decodePng, flattenOnto, pixelAt } from './helpers/png.mjs';
import { projectRoot, readProjectFile as read } from './helpers/project-files.mjs';

const pngOf = (src) => decodePng(readFileSync(join(projectRoot, src)));

test('the icons are the exact sizes the manifest declares', () => {
  const pngs = pngIcons(MANIFEST_ICONS);
  assert.ok(pngs.length >= 3, 'the manifest declares the PNG icons');
  for (const icon of pngs) {
    const image = pngOf(icon.src);
    assert.equal(image.width, icon.width, `${icon.src} is ${icon.width} px wide`);
    assert.equal(image.height, icon.height, `${icon.src} is ${icon.height} px tall`);
  }
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const declared = new Map(manifest.icons.map((icon) => [icon.src, icon]));
  assert.equal(declared.get('assets/icon-512.png').purpose, 'any', 'the transparent 512 is the ordinary icon');
  assert.equal(declared.get('assets/icon-maskable-512.png').purpose, 'maskable', 'the opaque 512 is maskable only');
  assert.equal(declared.get('assets/icon-maskable-512.png').sizes, '512x512');
  assert.ok(manifest.icons.every((icon) => icon.purpose !== 'any maskable'), 'no icon claims two purposes at once');
});

test('the ordinary icon corners are transparent, not white paint', () => {
  for (const icon of pngIcons(MANIFEST_ICONS).filter((entry) => !entry.maskable)) {
    const image = pngOf(icon.src);
    for (const [x, y] of [
      [0, 0],
      [image.width - 1, 0],
      [0, image.height - 1],
      [image.width - 1, image.height - 1],
    ]) {
      assert.equal(pixelAt(image, x, y).a, 0, `${icon.src} pixel (${x},${y}) has alpha 0`);
    }
    const centre = pixelAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2));
    assert.equal(centre.a, 255, `${icon.src} centre is opaque`);
    assert.deepEqual([centre.r, centre.g, centre.b], [0x0a, 0x0a, 0x0c], `${icon.src} centre is the artwork background`);
  }
});

test('the maskable icon is opaque and its artwork stays in the safe circle', () => {
  const maskable = pngIcons(MANIFEST_ICONS).find((entry) => entry.maskable);
  assert.ok(maskable, 'the manifest declares a maskable PNG');
  const image = pngOf(maskable.src);
  for (const [x, y] of [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
  ]) {
    assert.equal(pixelAt(image, x, y).a, 255, `${maskable.src} corner (${x},${y}) is opaque`);
  }
  let transparentPixels = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (pixelAt(image, x, y).a !== 255) transparentPixels++;
    }
  }
  assert.equal(transparentPixels, 0, `${maskable.src} has no transparent pixel`);

  const base = pngIcons(MANIFEST_ICONS).find((entry) => !entry.maskable && entry.width === image.width && entry.height === image.height);
  assert.ok(base, 'a transparent base of the same size exists');
  const source = pngOf(base.src);
  const background = pixelAt(source, 0, Math.floor(source.height / 2));
  const expected = flattenOnto(source, background);
  assert.deepEqual(image.data, expected.data, `${maskable.src} is ${base.src} flattened onto its artwork background`);

  const centreX = image.width / 2;
  const centreY = image.height / 2;
  const radius = Math.min(image.width, image.height) * MASKABLE_SAFE_ZONE_RATIO;
  let outside = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const pixel = pixelAt(image, x, y);
      const nearBackground =
        Math.abs(pixel.r - background.r) <= 2 &&
        Math.abs(pixel.g - background.g) <= 2 &&
        Math.abs(pixel.b - background.b) <= 2;
      if (nearBackground) continue;
      if (Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY) > radius) outside++;
    }
  }
  assert.equal(outside, 0, 'no artwork pixel falls outside the launcher safe circle');
});

test('the apple-touch-icon is the opaque icon', () => {
  const html = read('index.html');
  assert.match(html, /rel="apple-touch-icon" href="assets\/icon-maskable-512\.png"/);
});

test('the generated icons pass their one owner’s check', async () => {
  const result = await checkIcons();
  assert.deepEqual(result.findings, [], 'run: npm run build:icons -- --write');
  assert.equal(result.checked, pngIcons(MANIFEST_ICONS).length);
});

test('the Android launcher icon is the 192 px icon, byte for byte', async (t) => {
  const staging = await mkdtemp(join(tmpdir(), 'drypoint-res-'));
  t.after(() => rm(staging, { recursive: true, force: true }));
  await syncResources(staging);
  const drawable = await readFile(join(staging, 'res', 'drawable', 'app_icon.png'));
  assert.deepEqual(drawable, await readFile(join(projectRoot, 'assets', 'icon-192.png')), 'one artwork, copied');
  // aapt2 re-encodes a PNG unless crunching is off, so the drawable inside the
  // APK would be the same picture and different bytes.
  const build = read('scripts/build-android.mjs');
  assert.equal((build.match(/'--no-crunch'/g) ?? []).length, 1, 'resource crunching is off, so the APK keeps these bytes');
  assert.equal((build.match(/app_icon\.png/g) ?? []).length, 1, 'the drawable is written in exactly one place');
  assert.match(build, /join\(root, 'assets', 'icon-192\.png'\)/);
});
