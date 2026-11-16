/**
 * Offline shell. assets/precache.js is generated from the real dependency
 * graph by scripts/precache.mjs and imported below, so this worker never keeps
 * a second hand-written file list — including the structural anchors.
 *
 * Strategy:
 *   precached URL  → cache-first (a cold start with no connectivity paints)
 *   navigation     → network-first, falling back to the cached index.html
 *   anything else  → network only; never answered with index.html
 */

try {
  importScripts('assets/precache.js');
} catch (error) {
  // Keep the worker evaluable so install can report the failure to the page
  // instead of dying before it has a chance to postMessage.
  console.error('[service-worker] assets/precache.js could not be loaded', error);
}

// Build stamp — written by scripts/precache.mjs. Do not edit by hand.
const BUILD = 'd2dd47f492fd230c';

const MANIFEST = self.__PRECACHE;
const CACHE_PREFIX = 'drypoint-';
const CACHE = `${CACHE_PREFIX}${BUILD}`;
/** Scratch cache for one install attempt; never the cache being served. */
const STAGING = `${CACHE}-staging`;
const BASE = self.location.href;
const INDEX_URL = new URL('index.html', BASE).href;
/**
 * How long a navigation waits for the network before the cached shell answers.
 * Stamped into assets/precache.js from CONFIG.offline.navigationTimeoutMs; this
 * worker cannot import the app config, so it reads the generated value and
 * refuses an install that does not carry one.
 */
const NAVIGATION_TIMEOUT_MS = MANIFEST?.navigationTimeoutMs;

const keyOf = (url) => `${url.origin}${url.pathname}`;
const PRECACHED = new Set((MANIFEST?.files ?? []).map((file) => keyOf(new URL(file, BASE))));
const DIGESTS = MANIFEST?.digests ?? null;

/**
 * Content types a precache fetch may answer with, by extension. A host that
 * rewrites missing files to index.html answers 200 with HTML, and caching that
 * as a module silently breaks the app offline. Only precache fetches are
 * checked: HTML navigations are allowed to be rewritten by the host.
 */
const CONTENT_TYPES = Object.freeze({
  '.js': ['text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript'],
  '.mjs': ['text/javascript', 'application/javascript'],
  '.css': ['text/css'],
  '.html': ['text/html', 'application/xhtml+xml'],
  '.json': ['application/json', 'text/json'],
  '.webmanifest': ['application/manifest+json', 'application/json', 'text/plain'],
  '.svg': ['image/svg+xml'],
  '.png': ['image/png'],
  '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
});

/**
 * Why a response cannot be the file it claims to be, or null. A known
 * extension with no Content-Type is a failure: a module without its type is
 * not executable, so accepting it would cache a broken offline install.
 */
function contentTypeProblem(file, contentType) {
  const dot = file.lastIndexOf('.');
  const allowed = dot < 0 ? null : CONTENT_TYPES[file.slice(dot).toLowerCase()];
  if (!allowed) return null;
  const essence = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!essence) return 'response has no content type';
  return allowed.includes(essence) ? null : `content type "${essence}" contradicts the file extension`;
}

/** Lowercase hex SHA-256 of a fetched body. */
async function digestHex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Tell every controlled page about a failure — and only the pages this worker
 * owns. `matchAll` is origin-wide: another app's registration on the same
 * origin would otherwise receive `precache-error` messages about a build that
 * is not its own, and a client that happens to be in another scope is not
 * served by this cache. The registration scope is the boundary.
 */
async function notifyClients(payload) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  const scope = self.registration.scope;
  for (const client of clients) {
    if (typeof client.url !== 'string' || !client.url.startsWith(scope)) continue;
    client.postMessage(payload);
  }
}

async function failInstall(problems) {
  const message = `Precache failed: ${problems.join('; ')}`;
  console.error('[service-worker]', message);
  await notifyClients({ type: 'precache-error', message, problems });
  // Rejecting install keeps the active worker (and its complete cache) alive.
  throw new Error(message);
}

/**
 * Best-effort cache removal during a failed install. The install is already
 * failing, so this must not throw a second, unrelated error; the failure is
 * logged rather than swallowed.
 */
async function discardCache(name) {
  try {
    await caches.delete(name);
  } catch (error) {
    console.warn(`[service-worker] could not discard the cache ${name}`, error);
  }
}

async function install() {
  const problems = [];
  if (
    !MANIFEST ||
    typeof MANIFEST.version !== 'string' ||
    !Array.isArray(MANIFEST.files) ||
    MANIFEST.files.length === 0 ||
    !Array.isArray(MANIFEST.required) ||
    MANIFEST.required.length === 0 ||
    !Number.isFinite(MANIFEST.navigationTimeoutMs) ||
    MANIFEST.navigationTimeoutMs <= 0
  ) {
    return failInstall(['assets/precache.js is missing or malformed']);
  }
  if (MANIFEST.version !== BUILD) {
    // The manifest and the worker are two independent atomic writes, so a host
    // or a cache can serve a torn pair. A manifest newer than this worker means
    // the worker is stale, not that the app is broken: install nothing, keep
    // the active cache, and do not tell the page this was an error.
    console.info(
      `[service-worker] stale worker: assets/precache.js is version ${MANIFEST.version}, ` +
        `but sw.js was built for ${BUILD}; keeping the active cache`
    );
    throw new Error('stale worker build');
  }
  if (new Set(MANIFEST.files).size !== MANIFEST.files.length) problems.push('the list has duplicate entries');
  for (const required of MANIFEST.required) {
    if (!MANIFEST.files.includes(required)) problems.push(`the list omits ${required}`);
  }
  if (!DIGESTS || typeof DIGESTS !== 'object' || Array.isArray(DIGESTS)) {
    problems.push('assets/precache.js has no per-file digests');
  } else {
    const missing = MANIFEST.files.filter((file) => typeof DIGESTS[file] !== 'string' || !/^[0-9a-f]{64}$/.test(DIGESTS[file]));
    if (missing.length) problems.push(`the digest list is incomplete (${missing.join(', ')})`);
    const extra = Object.keys(DIGESTS).filter((file) => !MANIFEST.files.includes(file));
    if (extra.length) problems.push(`the digest list names files outside the manifest (${extra.join(', ')})`);
  }
  if (problems.length) return failInstall(problems);

  // Stage every response in a scratch cache. The live cache is only touched
  // once the whole set is verified, so a failed install — including a same
  // build reinstall — can never leave the active worker offline-broken.
  //
  // The Cache Storage API itself can fail: a denied origin, a full quota, a
  // browser that rejects the name. That is an install failure like any other
  // and must reach the page as a precache-error, not reject install() before
  // anything has told the page what happened.
  let hadLiveCache = false;
  let liveCacheOpened = false;
  try {
    await caches.delete(STAGING);
    const staging = await caches.open(STAGING);
    await Promise.all(
      MANIFEST.files.map(async (file) => {
        const url = new URL(file, BASE).href;
        try {
          const expected = DIGESTS?.[file];
          if (!expected) {
            problems.push(`${file}: assets/precache.js has no digest for this file`);
            return;
          }
          const response = await fetch(url, { cache: 'reload' });
          if (!response.ok) {
            problems.push(`${file}: HTTP ${response.status}`);
            return;
          }
          if (response.redirected) {
            problems.push(`${file}: redirected to ${response.url}`);
            return;
          }
          const mismatch = contentTypeProblem(file, response.headers?.get?.('content-type') ?? null);
          if (mismatch) {
            problems.push(`${file}: ${mismatch}`);
            return;
          }
          const actual = await digestHex(await response.clone().arrayBuffer());
          if (actual !== expected) {
            problems.push(`${file}: content hash ${actual} does not match the manifest digest ${expected}`);
            return;
          }
          await staging.put(url, response);
        } catch (error) {
          problems.push(`${file}: ${error.message}`);
        }
      })
    );
    if (problems.length) {
      await discardCache(STAGING);
      return failInstall(problems);
    }

    // Promote the verified set.
    hadLiveCache = await caches.has(CACHE);
    const cache = await caches.open(CACHE);
    liveCacheOpened = true;
    for (const file of MANIFEST.files) {
      const url = new URL(file, BASE).href;
      const response = await staging.match(url);
      if (!response) {
        problems.push(`${file}: missing from the staging cache`);
        continue;
      }
      await cache.put(url, response);
    }
    await discardCache(STAGING);
  } catch (error) {
    // A partial promotion is only safe to leave when the live cache predated it.
    if (liveCacheOpened && !hadLiveCache) await discardCache(CACHE);
    await discardCache(STAGING);
    return failInstall([`the cache storage rejected the install: ${error.message}`]);
  }
  if (problems.length) {
    // A partial promotion is only safe to leave when the live cache predated it.
    if (!hadLiveCache) await discardCache(CACHE);
    return failInstall(problems);
  }
  await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

/** Cache-first for a precached URL; the cache only ever holds verified responses. */
async function fromCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  // A precached entry can be evicted by the browser; one network attempt is
  // still better than failing, and it is never replaced with index.html.
  return fetch(request);
}

/** The cached shell, or null. One owner for the navigation fallback answer. */
async function cachedShell() {
  const cache = await caches.open(CACHE);
  return (await cache.match(INDEX_URL)) ?? null;
}

/**
 * Network-first navigation, with the precached shell as the offline answer.
 *
 * The wait is bounded: a phone whose network silently drops the SYN would
 * otherwise keep the navigation pending until the platform gives up. The loser
 * of the race is always released — the timer when the network answers, the
 * network request when the timer wins.
 */
async function fromNetworkFirst(request) {
  const controller = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the navigation did not answer within ${NAVIGATION_TIMEOUT_MS} ms`));
    }, NAVIGATION_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetch(request, { signal: controller.signal }), timedOut]);
    if (response.ok) return response;
    // A 5xx error page is not the app; the cached shell is the better answer.
    return (await cachedShell()) ?? response;
  } catch (error) {
    const shell = await cachedShell();
    if (shell) return shell;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fromNetworkFirst(request));
    return;
  }

  if (PRECACHED.has(keyOf(url))) {
    event.respondWith(fromCacheFirst(request));
    return;
  }

  // Never answer a non-navigation request with the app shell.
  event.respondWith(fetch(request));
});
