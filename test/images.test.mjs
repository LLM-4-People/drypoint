import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { forgetImage, getImage, hydrateImages, imageState, preloadImage } from '../src/label/images.js';

/**
 * Minimal Image stand-in: a source containing "broken" fails to decode, one
 * containing "empty" decodes to zero pixels, everything else is 4×3.
 */
class FakeImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._src = '';
  }

  set src(value) {
    this._src = value;
    FakeImage.created.push(value);
    queueMicrotask(() => {
      this.complete = true;
      if (value.includes('broken')) {
        this.onerror?.({});
        return;
      }
      if (value.includes('empty')) {
        this.onload?.();
        return;
      }
      this.naturalWidth = 4;
      this.naturalHeight = 3;
      this.onload?.();
    });
  }

  get src() {
    return this._src;
  }
}
FakeImage.created = [];
globalThis.Image = FakeImage;

test('a decoded image is cached and returned synchronously', async () => {
  const image = await preloadImage('good-cache.png');
  assert.equal(image.naturalWidth, 4);
  assert.equal(getImage('good-cache.png'), image);
  await preloadImage('good-cache.png');
  assert.equal(FakeImage.created.filter((src) => src === 'good-cache.png').length, 1);
});

test('a decode failure is cached and re-rejected, never resolved as a blank image', async () => {
  const before = FakeImage.created.length;
  await assert.rejects(preloadImage('broken-once.png'), /could not be decoded/);
  await assert.rejects(preloadImage('broken-once.png'), /could not be decoded/);
  assert.equal(FakeImage.created.length - before, 1, 'one decode attempt per source');
  assert.equal(getImage('broken-once.png'), null);
});

test('a decode with no pixels is a failure', async () => {
  await assert.rejects(preloadImage('empty.png'), /no pixels/);
  assert.equal(getImage('empty.png'), null);
});

test('forgetImage drops a cached source', async () => {
  await preloadImage('forgotten.png');
  assert.ok(getImage('forgotten.png'));
  forgetImage('forgotten.png');
  assert.equal(getImage('forgotten.png'), null);
});

test('the cache is capped by CONFIG.image.cacheLimit', async () => {
  const sources = Array.from({ length: CONFIG.image.cacheLimit + 1 }, (_, index) => `cap-${index}.png`);
  for (const src of sources) await preloadImage(src);
  assert.equal(getImage(sources[0]), null, 'the coldest source was evicted');
  assert.ok(getImage(sources.at(-1)));
});

test('hydrateImages decodes every distinct source once', async () => {
  FakeImage.created = [];
  const document = {
    elements: [
      { type: 'image', src: 'hydrate-a.png' },
      { type: 'image', src: 'hydrate-a.png' },
      { type: 'image', src: 'hydrate-b.png' },
      { type: 'text', text: 'ignored' },
      { type: 'image', src: '' },
    ],
  };
  assert.equal(await hydrateImages(document), 2);
  assert.deepEqual(FakeImage.created.sort(), ['hydrate-a.png', 'hydrate-b.png']);
});

test('hydrateImages rejects a document whose image cannot be decoded', async () => {
  await assert.rejects(
    hydrateImages({ elements: [{ type: 'image', src: 'broken-print.png' }] }),
    /An image could not be decoded/
  );
});

test('imageState distinguishes ready, failed, pending and missing sources', async () => {
  await preloadImage('state-ready.png');
  assert.equal(imageState('state-ready.png'), 'ready');
  assert.equal(imageState('state-missing.png'), 'missing');
  await assert.rejects(preloadImage('broken-state.png'), /could not be decoded/);
  assert.equal(imageState('broken-state.png'), 'failed');
});

test('a label with more distinct images than the cache holds is refused before decoding', async () => {
  const sources = Array.from({ length: CONFIG.image.cacheLimit + 1 }, (_, index) => `too-many-${index}.png`);
  const document = { elements: sources.map((src) => ({ type: 'image', src })) };
  FakeImage.created = [];
  await assert.rejects(hydrateImages(document), (error) => {
    // The message names the limit and the count, not "an image failed".
    assert.ok(error.message.includes(`${CONFIG.image.cacheLimit} different images`), error.message);
    assert.ok(error.message.includes(`${sources.length}`), error.message);
    return true;
  });
  assert.deepEqual(FakeImage.created, [], 'nothing is decoded when the label can never be painted');
});

test('hydrateImages tolerates a document without elements', async () => {
  assert.equal(await hydrateImages(null), 0);
  assert.equal(await hydrateImages({}), 0);
});

/* ---------------- hidden images (R2-4) ---------------- */

test('a hidden broken image cannot block a label that uses the full cache', async () => {
  const elements = Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => ({ type: 'image', src: `visible-${index}.png` }));
  elements.push({ type: 'image', src: 'broken-hidden.png', visible: false });
  assert.equal(await hydrateImages({ elements }), CONFIG.image.cacheLimit);
  assert.equal(imageState('broken-hidden.png'), 'missing', 'the hidden source was never decoded');
});

test('a hidden image is not decoded at all', async () => {
  FakeImage.created = [];
  assert.equal(await hydrateImages({ elements: [{ type: 'image', src: 'hidden-only.png', visible: false }] }), 0);
  assert.deepEqual(FakeImage.created, []);
});
