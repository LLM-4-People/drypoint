/**
 * Image cache for label elements: one decode per source, synchronous lookup,
 * cached failures and a bounded number of decoded bitmaps.
 */

import { CONFIG } from '../core/config.js';

const cache = new Map();

/** Mark a source as recently used so eviction drops the coldest entry first. */
function touch(src) {
  const entry = cache.get(src);
  if (!entry) return null;
  cache.delete(src);
  cache.set(src, entry);
  return entry;
}

function trim() {
  while (cache.size > CONFIG.image.cacheLimit) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Decode a source once. A failed decode (including a bitmap with no pixels) is
 * cached and re-rejected on later calls, so the renderer never silently paints
 * a blank image that looked like it was loading.
 */
export function preloadImage(src) {
  if (!src) return Promise.resolve(null);
  const cached = touch(src);
  if (cached) return cached.error ? Promise.reject(cached.error) : cached.promise;

  const image = new Image();
  image.decoding = 'async';
  const entry = { image, promise: null, error: null };
  entry.promise = new Promise((resolve, reject) => {
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        entry.error = new Error('Image has no pixels');
        reject(entry.error);
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      entry.error = new Error('Image could not be decoded');
      reject(entry.error);
    };
    image.src = src;
  });
  // Callers observe the rejection; this handler only prevents an unhandled
  // rejection when the decode fails before anybody awaits the promise.
  entry.promise.catch(() => {});
  cache.set(src, entry);
  trim();
  return entry.promise;
}

export function getImage(src) {
  const entry = cache.get(src);
  return entry?.image?.complete && entry.image.naturalWidth > 0 ? entry.image : null;
}

/**
 * State of one source in the decode cache: ready, failed (decode error cached),
 * pending (decode in flight), or missing (never requested or already evicted).
 */
export function imageState(src) {
  const entry = cache.get(src);
  if (!entry) return 'missing';
  if (entry.error) return 'failed';
  return getImage(src) ? 'ready' : 'pending';
}

/** Human-readable source for warnings; data URLs are shortened to a prefix. */
export function describeImageSource(src) {
  const text = String(src ?? '');
  return text.length <= 64 ? text : `${text.slice(0, 61)}…`;
}

export function forgetImage(src) {
  cache.delete(src);
}

/**
 * Decode every distinct image source a document actually paints. Hidden
 * elements are skipped: their source cannot appear on the label, so a broken
 * or seventeenth hidden image must not block printing. Rejects when any source
 * cannot be decoded, or when a decoded source was evicted from the bounded
 * cache before the painter could read it (a silent print hole).
 *
 * A label that references more distinct sources than the cache can hold can
 * never be painted from it, so that is refused up front with the limit in the
 * message instead of blaming an image that decoded fine.
 */
export async function hydrateImages(labelDocument) {
  const sources = new Set();
  for (const element of labelDocument?.elements ?? []) {
    if (element?.type !== 'image' || !element.src) continue;
    if (element.visible === false) continue;
    sources.add(element.src);
  }
  const list = [...sources];
  if (list.length > CONFIG.image.cacheLimit) {
    throw new Error(
      `A label can use at most ${CONFIG.image.cacheLimit} different images; this one uses ${list.length}. ` +
        'Remove or reuse an image before printing.'
    );
  }
  const results = await Promise.allSettled(list.map((src) => preloadImage(src)));
  // A resolved decode is not enough: the LRU cache may already have dropped it
  // while a later source was decoded, and the renderer would paint nothing.
  const failed = list.filter((src, index) => results[index].status === 'rejected' || !getImage(src));
  if (failed.length) {
    const names = failed.map(describeImageSource).join(', ');
    const subject = failed.length === 1 ? 'An image' : `${failed.length} images`;
    throw new Error(
      `${subject} could not be decoded or is no longer cached: ${names}. Replace or remove the image before printing.`
    );
  }
  return list.length;
}
