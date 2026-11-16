import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import {
  IMAGE_SOURCE_LIMIT,
  createVisibleImageHydrator,
  documentSourceChars,
  documentSourceBudgetMessage,
  exceedsSourceBudget,
  forgetImage,
  getImage,
  hydrateImages,
  imageState,
  imageSources,
  preloadImage,
} from '../src/label/images.js';
import { createEditor } from '../src/editor/controller.js';

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

/* ---------------- hydration fixed point and the 17th image (P2a) ---------------- */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a 17-source document attempts each source once and then stops decoding', async () => {
  FakeImage.created = [];
  const sources = Array.from({ length: CONFIG.image.cacheLimit + 1 }, (_, index) => `fixed-${index}.png`);
  const document = { elements: sources.map((src) => ({ type: 'image', src })) };
  const hydrateVisible = createVisibleImageHydrator();

  let started = hydrateVisible(document);
  assert.equal(started, sources.length, 'the first pass starts every missing source');
  await settle();
  for (let pass = 0; pass < 20; pass++) started += hydrateVisible(document);

  assert.equal(started, sources.length, 'no later pass starts a decode for the same document');
  assert.equal(FakeImage.created.length, sources.length, 'each source was decoded exactly once');
  assert.equal(hydrateVisible(document), 0, 'the fixed point is zero new decodes');
});

test('sixteen images hydrate and reach the same zero-decode fixed point', async () => {
  FakeImage.created = [];
  const sources = Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => `settled-${index}.png`);
  const document = { elements: sources.map((src) => ({ type: 'image', src })) };
  const hydrateVisible = createVisibleImageHydrator();

  assert.equal(hydrateVisible(document), sources.length);
  await settle();
  for (let pass = 0; pass < 10; pass++) assert.equal(hydrateVisible(document), 0);
  assert.equal(FakeImage.created.length, sources.length);
  for (const src of sources) assert.equal(imageState(src), 'ready', `${src} remains cached`);
});

test('the editor refuses the 17th distinct image before insertion with the print limit', () => {
  const editor = createEditor({ document: { version: 4, lengthMm: 40, copies: 1, elements: [] } });
  const sources = Array.from({ length: IMAGE_SOURCE_LIMIT }, (_, index) => `editor-image-${index}.png`);
  for (const src of sources) assert.ok(editor.addElement('image', { src }), `${src} is accepted`);

  assert.equal(editor.document.elements.length, IMAGE_SOURCE_LIMIT);
  assert.equal(editor.addElement('image', { src: 'editor-image-17.png' }), null, 'the 17th is refused');
  assert.equal(editor.document.elements.length, IMAGE_SOURCE_LIMIT, 'nothing was inserted');
  const notice = editor.document.notices.at(-1);
  assert.match(notice, new RegExp(`at most ${IMAGE_SOURCE_LIMIT} different images`));
  assert.match(notice, /uses 17/);
  assert.equal(
    editor.addElement('image', { src: sources[0] }).src,
    sources[0],
    'reusing an existing source does not consume a new slot'
  );
  assert.deepEqual(imageSources(editor.document).slice(0, IMAGE_SOURCE_LIMIT), sources);
});

/* ---------------- the one source measurement (A-F1) ---------------- */

test('imageSources can exclude the element an edit replaces', () => {
  const document = {
    elements: [
      { id: 'a', type: 'image', src: 'shared.png' },
      { id: 'b', type: 'image', src: 'shared.png' },
      { id: 'c', type: 'text', text: 'not an image' },
      { id: 'd', type: 'image', src: 'other.png' },
    ],
  };
  assert.deepEqual(imageSources(document), ['shared.png', 'other.png']);
  assert.deepEqual(imageSources(document, { excludeId: 'a' }), ['shared.png', 'other.png'], 'b still uses it');
  assert.deepEqual(imageSources(document, { excludeId: 'b' }), ['shared.png', 'other.png']);
  assert.deepEqual(imageSources(document, { excludeId: 'd' }), ['shared.png']);
  assert.deepEqual(imageSources(document, { excludeId: 'missing' }), ['shared.png', 'other.png']);
});

test('documentSourceChars counts every occurrence, not distinct sources', () => {
  const document = {
    elements: [
      { type: 'image', src: 'aaa' },
      { type: 'image', src: 'aaa' },
      { type: 'image', src: '' },
      { type: 'text', text: 'ignored' },
    ],
  };
  assert.equal(documentSourceChars(document), 6, 'the serialised label repeats the source');
  assert.equal(documentSourceChars({ elements: [] }), 0);
  assert.equal(documentSourceChars(null), 0);
  assert.equal(exceedsSourceBudget(document), false);
  assert.match(documentSourceBudgetMessage(64_000_001), /64000001 characters of image data/);
  assert.match(documentSourceBudgetMessage(64_000_001), /import or save/);
});
