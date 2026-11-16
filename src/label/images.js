/**
 * Image cache for label elements: one decode per source, synchronous lookup,
 * cached failures and a bounded number of decoded bitmaps.
 */

import { CONFIG } from '../core/config.js';

const cache = new Map();

/** The same distinct-source limit the print path and the editor enforce. */
export const IMAGE_SOURCE_LIMIT = CONFIG.image.cacheLimit;

/**
 * Distinct image sources a document references. The print path counts only
 * visible images (hidden ones are not painted); the editor counts every source
 * so a hidden image cannot become a seventeenth visible one later.
 *
 * `excludeId` drops one element from the count. An edit computes the document
 * it *would* produce that way: the element being replaced no longer contributes
 * its old source, while any other element that still uses the same source keeps
 * its slot. Callers must not re-implement this loop for that case.
 *
 * @param {object|null} labelDocument
 * @param {{visibleOnly?: boolean, excludeId?: string|null}} [options]
 * @returns {string[]} insertion-ordered, duplicate-free sources
 */
export function imageSources(labelDocument, { visibleOnly = false, excludeId = null } = {}) {
  const sources = new Set();
  for (const element of labelDocument?.elements ?? []) {
    if (element?.type !== 'image' || !element.src) continue;
    if (visibleOnly && element.visible === false) continue;
    if (excludeId !== null && element.id === excludeId) continue;
    sources.add(element.src);
  }
  return [...sources];
}

/** The one wording for the distinct-source limit, shared by print and add. */
function imageSourceLimitMessage(count, action = 'printing') {
  return (
    `A label can use at most ${IMAGE_SOURCE_LIMIT} different images; this one uses ${count}. ` +
    `Remove or reuse an image before ${action}.`
  );
}

/**
 * Total image-source characters one document carries.
 *
 * This is the one measurement of the document budget: the serialised label
 * repeats a source once per element, so a label that reuses one large image is
 * as large as one that uses many. It is enforced where an image enters the
 * label (the editor and the importer) and where the label leaves it (export),
 * never by rewriting a document that already exists: validation is a
 * normalise pass on every undo, geometry change and print, so dropping sources
 * there silently destroyed a valid label.
 *
 * @param {object|null} labelDocument
 * @returns {number} UTF-16 code units of image text
 */
export function documentSourceChars(labelDocument) {
  let chars = 0;
  for (const element of labelDocument?.elements ?? []) {
    if (element?.type !== 'image' || typeof element.src !== 'string') continue;
    chars += element.src.length;
  }
  return chars;
}

/**
 * The one wording for a document over the image-text budget at a transfer
 * boundary. Import and export quote it: a label either side can produce must be
 * a file the other side accepts.
 */
export function documentSourceBudgetMessage(chars) {
  return `This label carries ${chars} characters of image data, more than the ${CONFIG.bounds.maxSourceChars} this app can import or save. Remove or reuse an image.`;
}

/**
 * The refusal the editor shows when one more image would pass the document
 * budget. Same limit and the same measurement as the transfer boundary, a
 * different action.
 */
function sourceBudgetRefusalNotice() {
  return `Adding this image would give the label more than ${CONFIG.bounds.maxSourceChars} characters of image data. Remove or reuse an image first.`;
}

/**
 * The one source-budget decision for a document that is about to cross a
 * boundary: the editor's add/update/duplicate, import, or export.
 *
 * Both facts are checked here and nowhere else: the distinct-source cap (the
 * decode cache) and the image-text budget (the serialised file, which repeats a
 * source once per element). `labelDocument` must be the document as it *would*
 * be after the change, so a replacement is judged by what it produces rather
 * than by what it removes. The action names the boundary in the message.
 *
 * @param {object|null} labelDocument the resulting document
 * @param {{action?: string, refusal?: boolean}} [options] `refusal` selects the
 *        editor's wording; transfer boundaries use the import/save wording
 * @returns {string|null} one message, or null when the document fits
 */
export function sourceBudgetProblem(labelDocument, { action = 'printing', refusal = false } = {}) {
  const distinct = imageSources(labelDocument).length;
  if (distinct > IMAGE_SOURCE_LIMIT) return imageSourceLimitMessage(distinct, action);
  const chars = documentSourceChars(labelDocument);
  if (chars <= CONFIG.bounds.maxSourceChars) return null;
  return refusal ? sourceBudgetRefusalNotice() : documentSourceBudgetMessage(chars);
}

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
  const list = imageSources(labelDocument, { visibleOnly: true });
  if (list.length > IMAGE_SOURCE_LIMIT) throw new Error(imageSourceLimitMessage(list.length));
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

/**
 * The render-driven decoder. One attempt per visible source and document
 * revision, including a failed attempt, so an evicted source cannot start a
 * decode loop: with more sources than the cache holds, every pass used to
 * evict one more and the next render decoded it again forever.
 *
 * A new document object clears the attempt set, because an edit may have
 * revealed an image that was hidden before. The cache still owns readiness:
 * a source already ready or failed is never decoded twice.
 *
 * @param {{decode?: (src:string)=>Promise<unknown>, state?: (src:string)=>string,
 *          onSettled?: (src:string)=>void}} [options]
 * @returns {(document:object)=>number} number of decodes started this pass
 */
export function createVisibleImageHydrator({
  decode = preloadImage,
  state = imageState,
  onSettled = () => {},
} = {}) {
  let currentDocument = null;
  const attempted = new Set();
  return function hydrateVisible(document) {
    if (document !== currentDocument) {
      currentDocument = document;
      attempted.clear();
    }
    let started = 0;
    for (const src of imageSources(document, { visibleOnly: true })) {
      if (attempted.has(src) || state(src) !== 'missing') continue;
      attempted.add(src);
      started += 1;
      // The renderer owns the repaint; a failure is already cached and shown
      // by the image placeholder, so this drain must not reject.
      decode(src)
        .catch(() => {})
        .finally(() => onSettled(src));
    }
    return started;
  };
}
