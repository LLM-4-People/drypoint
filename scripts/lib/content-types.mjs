/**
 * The one content-type contract for the app surface.
 *
 * Four copies used to live apart: the service worker validated what a host
 * answered for a precache fetch, the dev server labelled what it served, the
 * browser harness mimicked the server, and the Pages smoke knew only the
 * manifest. They could disagree without any test noticing, so a file this
 * project labels `text/html` could still be accepted by the worker's wider
 * list.
 *
 * `type` is what this project's own server sends. `allowed` is what the worker
 * accepts from a host it does not control: GitHub Pages labels JavaScript and
 * the web manifest in more than one legal way. An extension that is not here
 * is outside the contract, and a check returns null rather than guessing.
 *
 * The service worker cannot import modules, so `scripts/precache.mjs` stamps a
 * generated copy from this module into `sw.js` with the same exactly-one
 * mechanism as BUILD and CACHE_PREFIX. Edit this file, never the block.
 */

/** @param {string} type @param {string[]} allowed */
const entry = (type, allowed) => Object.freeze({ type, allowed: Object.freeze(allowed) });

export const CONTENT_TYPES = Object.freeze({
  '.html': entry('text/html; charset=utf-8', ['text/html', 'application/xhtml+xml']),
  '.js': entry('text/javascript; charset=utf-8', [
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'text/ecmascript',
    'application/ecmascript',
  ]),
  '.mjs': entry('text/javascript; charset=utf-8', ['text/javascript', 'application/javascript']),
  '.css': entry('text/css; charset=utf-8', ['text/css']),
  '.json': entry('application/json; charset=utf-8', ['application/json', 'text/json']),
  '.webmanifest': entry('application/manifest+json; charset=utf-8', [
    'application/manifest+json',
    'application/json',
    'text/plain',
  ]),
  '.svg': entry('image/svg+xml', ['image/svg+xml']),
  '.png': entry('image/png', ['image/png']),
  '.ico': entry('image/x-icon', ['image/x-icon', 'image/vnd.microsoft.icon']),
  '.woff2': entry('font/woff2', ['font/woff2']),
});

const extensionOf = (file) => {
  const name = String(file).split('?')[0].split('#')[0];
  const dot = name.lastIndexOf('.');
  return dot < 0 ? null : name.slice(dot).toLowerCase();
};

/**
 * The media type without parameters, lowercased, or '' when absent.
 *
 * @param {string|null|undefined} contentType
 * @returns {string}
 */
export function contentTypeEssence(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * What this project's server sends for a file, or the binary fallback.
 *
 * @param {string} file
 * @returns {string}
 */
export function contentTypeFor(file) {
  return CONTENT_TYPES[extensionOf(file)]?.type ?? 'application/octet-stream';
}

/**
 * Why a response cannot be the file it claims to be, or null.
 *
 * A known extension with no Content-Type is a failure: a module without its
 * type is not executable, so accepting it would cache a broken offline
 * install. The same function runs in the worker (stamped) and in the Pages
 * smoke (imported), so a deployment check cannot pass a type the worker would
 * refuse.
 *
 * @param {string} file
 * @param {string|null|undefined} contentType
 * @returns {string|null}
 */
export function contentTypeProblem(file, contentType) {
  const name = String(file).split('?')[0].split('#')[0];
  const dot = name.lastIndexOf('.');
  const allowed = dot < 0 ? null : CONTENT_TYPES[name.slice(dot).toLowerCase()]?.allowed;
  if (!allowed) return null;
  const essence = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!essence) return 'response has no content type';
  return allowed.includes(essence) ? null : `content type "${essence}" contradicts the file extension`;
}

/**
 * The exact body of the worker's generated content-type block: the map as
 * data, then the decision function's own source. The function is written to
 * depend only on `CONTENT_TYPES` and the string methods above, so its source
 * is valid unchanged inside a classic worker.
 *
 * @returns {string}
 */
export function workerContentTypesSource() {
  return `const CONTENT_TYPES = ${JSON.stringify(CONTENT_TYPES, null, 2)};\n${contentTypeProblem.toString()}`;
}
