/**
 * The app icons: real transparency, exact sizes, and one artwork for two
 * distributions.
 *
 * The PNGs are rasterised from `assets/icon.svg` with a transparent
 * background. They used to be flat RGB with white paint in the corners, which
 * looks identical on a white page and wrong on every launcher that draws a
 * dark surface, so these tests read the pixels instead of trusting the file
 * size: colour type 6 (RGBA), bit depth 8, and the four corner pixels at alpha
 * 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { syncResources } from '../scripts/build-android.mjs';
import { projectRoot, readProjectFile as read } from './helpers/project-files.mjs';

/**
 * Decode an 8-bit RGBA, non-interlaced PNG. The icons are generated output, so
 * the only formats the decoder has to understand are the ones they are saved
 * in — and a different one fails the assertions below.
 *
 * @param {Buffer} bytes
 * @returns {{width:number, height:number, bitDepth:number, colorType:number, data:Buffer}}
 */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG signature');
  const header = bytes.subarray(16, 29);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  assert.equal(bitDepth, 8, 'an 8-bit PNG');
  assert.equal(colorType, 6, 'truecolour with alpha (RGBA)');
  assert.equal(interlace, 0, 'not interlaced');

  const chunks = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const data = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    for (let column = 0; column < stride; column++) {
      const left = column >= 4 ? data[row * stride + column - 4] : 0;
      const up = row > 0 ? data[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= 4 ? data[(row - 1) * stride + column - 4] : 0;
      const value = line[column];
      const unfiltered =
        filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up : filter === 3 ? value + ((left + up) >> 1) : value + paeth(left, up, upLeft);
      data[row * stride + column] = unfiltered & 0xff;
    }
  }
  return { width, height, bitDepth, colorType, data };
}

const pixel = (image, x, y) => {
  const at = (y * image.width + x) * 4;
  return { r: image.data[at], g: image.data[at + 1], b: image.data[at + 2], a: image.data[at + 3] };
};

test('the icons are the exact sizes the manifest declares', () => {
  for (const [file, size] of [
    ['assets/icon-192.png', 192],
    ['assets/icon-512.png', 512],
  ]) {
    const image = decodePng(readFileSync(join(projectRoot, file)));
    assert.equal(image.width, size, `${file} is ${size} px wide`);
    assert.equal(image.height, size, `${file} is ${size} px tall`);
  }
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const declared = new Map(manifest.icons.map((icon) => [icon.src, icon.sizes]));
  assert.equal(declared.get('assets/icon-192.png'), '192x192');
  assert.equal(declared.get('assets/icon-512.png'), '512x512');
});

test('the icon corners are transparent, not white paint', () => {
  for (const [file, size] of [
    ['assets/icon-192.png', 192],
    ['assets/icon-512.png', 512],
  ]) {
    const image = decodePng(readFileSync(join(projectRoot, file)));
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      assert.equal(pixel(image, x, y).a, 0, `${file} pixel (${x},${y}) has alpha 0`);
    }
    const centre = pixel(image, size / 2, size / 2);
    assert.equal(centre.a, 255, `${file} centre is opaque`);
    assert.deepEqual([centre.r, centre.g, centre.b], [0x0a, 0x0a, 0x0c], `${file} centre is the artwork background`);
  }
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
