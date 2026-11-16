import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { bootOfflineShell, registerPrecacheErrors, watchPrecacheErrors } from '../src/core/precache-status.js';
import { CONFIG } from '../src/core/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const swSource = readFileSync(resolve(root, 'sw.js'), 'utf8');
const manifestSource = readFileSync(resolve(root, 'assets/precache.js'), 'utf8');
const BASE = 'https://example.test/';

class FakeCache {
  entries = new Map();
  async put(url, response) {
    this.entries.set(String(url), response);
  }
  async match(request, options = {}) {
    const url = typeof request === 'string' ? request : request.url;
    const exact = this.entries.get(url);
    if (exact) return exact;
    if (!options.ignoreSearch) return undefined;
    const withoutQuery = url.split('?')[0];
    for (const [key, response] of this.entries) {
      if (key.split('?')[0] === withoutQuery) return response;
    }
    return undefined;
  }
}

/** The content type a well-behaved host returns for each precached extension. */
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function typeFor(href) {
  const path = new URL(href).pathname;
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : (TYPES[path.slice(dot)] ?? 'application/octet-stream');
}

/** The real bytes the server would return for a precached file. */
function bodyFor(href) {
  const pathname = decodeURIComponent(new URL(href).pathname).replace(/^\/+/, '');
  const path = resolve(root, pathname);
  if (!pathname || (path !== root && !path.startsWith(`${root}/`))) return Buffer.from(`not a file: ${href}`);
  try {
    return readFileSync(path);
  } catch {
    return Buffer.from(`not a file: ${href}`);
  }
}

function toArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  return bytes.buffer;
}

function responseFor({ status = 200, url = '', redirected = false, contentType = null, body = Buffer.alloc(0) } = {}) {
  const headers = { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) };
  const ok = status >= 200 && status < 300;
  const arrayBuffer = async () => toArrayBuffer(body);
  return {
    ok,
    status,
    url,
    redirected,
    headers,
    arrayBuffer,
    clone: () => ({ ok, status, url, redirected, headers, arrayBuffer }),
  };
}

function createWorker({
  online = true,
  failUrl = null,
  plan = () => ({}),
  clients = [],
  swSource: source = swSource,
  missingManifest = false,
  manifestSource: precache = manifestSource,
  throwOn = null,
} = {}) {
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async has(name) {
      return stores.has(name);
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  // Cache Storage can reject every call (a denied origin, a full quota). The
  // install must still notify the page exactly once.
  if (throwOn) caches[throwOn] = async () => {
    throw new Error(`${throwOn} denied by the storage layer`);
  };

  const state = { online, failUrl, claimed: 0, skipped: 0, errors: [], messages: [], aborted: false };
  const handlers = {};
  const clientList = clients.length ? clients : [{ postMessage: (message) => state.messages.push(message) }];

  const self = {
    location: { href: `${BASE}sw.js`, origin: new URL(BASE).origin },
    registration: { scope: BASE },
    clients: {
      async matchAll() {
        return clientList;
      },
      async claim() {
        state.claimed++;
      },
    },
    async skipWaiting() {
      state.skipped++;
    },
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
  };

  const sandbox = {
    self,
    caches,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: {
      subtle: {
        async digest(algorithm, data) {
          assert.equal(algorithm, 'SHA-256', 'the worker asks for SHA-256');
          return toArrayBuffer(createHash('sha256').update(Buffer.from(data)).digest());
        },
      },
    },
    console: {
      error: (...args) => state.errors.push(args),
      info: (...args) => (state.infos ??= []).push(args.join(' ')),
      log: () => {},
      warn: () => {},
    },
    async fetch(url, init = {}) {
      if (!state.online) throw new Error('offline');
      const href = typeof url === 'string' ? url : url.url;
      const override = plan(href) ?? {};
      const has = (key) => Object.prototype.hasOwnProperty.call(override, key);
      if (override.hang) {
        // A network that silently drops the request: only the abort settles it.
        return new Promise((_, reject) => {
          const abort = () => {
            state.aborted = true;
            reject(Object.assign(new Error('the fetch was aborted'), { name: 'AbortError' }));
          };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (!href.startsWith(BASE)) return responseFor({ status: 404, url: href });
      const failed = state.failUrl && href.endsWith(state.failUrl);
      const status = override.status ?? (failed ? 404 : 200);
      return responseFor({
        status,
        url: override.redirectUrl ?? href,
        redirected: override.redirected ?? false,
        contentType: has('contentType') ? override.contentType : typeFor(href),
        body: has('body') ? override.body : bodyFor(href),
      });
    },
  };
  let context;
  sandbox.importScripts = (path) => {
    assert.equal(path, 'assets/precache.js');
    if (missingManifest) throw new Error('manifest fetch failed');
    vm.runInContext(precache, context);
  };
  context = vm.createContext(sandbox);
  vm.runInContext(source, context);

  function dispatch(type, event) {
    let promise;
    handlers[type]({
      ...event,
      waitUntil(next) {
        promise = next;
      },
      respondWith(next) {
        promise = next;
      },
    });
    return promise;
  }

  return { state, stores, dispatch };
}

const request = (url, mode = 'cors') => ({ method: 'GET', mode, url: `${BASE}${url}` });

function manifest() {
  const sandbox = { self: {} };
  vm.runInNewContext(manifestSource, sandbox);
  return {
    version: sandbox.self.__PRECACHE.version,
    files: Array.from(sandbox.self.__PRECACHE.files),
    required: Array.from(sandbox.self.__PRECACHE.required),
    navigationTimeoutMs: sandbox.self.__PRECACHE.navigationTimeoutMs,
  };
}

const liveCache = (worker) => worker.stores.get(`drypoint-${manifest().version}`);

test('install caches every generated entry and skips waiting', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  assert.equal(worker.state.errors.length, 0);
  assert.equal(worker.state.skipped, 1);

  const expected = manifest();
  const cache = liveCache(worker);
  assert.ok(cache, 'the live cache exists');
  assert.equal(cache.entries.size, expected.files.length);
  for (const file of expected.files) {
    assert.ok(cache.entries.has(`${BASE}${file}`), `${file} is cached`);
  }
  assert.deepEqual([...worker.stores.keys()], [`drypoint-${expected.version}`], 'the staging cache is removed');
});

test('a precached module is served from cache when the network is down', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  worker.state.online = false;

  const response = await worker.dispatch('fetch', { request: request('src/main.js') });
  assert.equal(response.url, `${BASE}src/main.js`);
});

test('a navigation falls back to the cached index.html offline', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  worker.state.online = false;

  const response = await worker.dispatch('fetch', { request: request('', 'navigate') });
  assert.equal(response.url, `${BASE}index.html`);
});

test('a 5xx navigation falls back to the cached shell', async () => {
  const worker = createWorker({ plan: (href) => (href === BASE ? { status: 503 } : {}) });
  await worker.dispatch('install', {});

  const response = await worker.dispatch('fetch', { request: request('', 'navigate') });
  assert.equal(response.url, `${BASE}index.html`, 'the cached shell answers instead of the error page');
});

test('a non-navigation 5xx is returned as-is, never the shell', async () => {
  const worker = createWorker({ plan: (href) => (href.endsWith('assets/not-listed.png') ? { status: 503 } : {}) });
  await worker.dispatch('install', {});

  const response = await worker.dispatch('fetch', { request: request('assets/not-listed.png') });
  assert.equal(response.status, 503);
  assert.equal(response.url, `${BASE}assets/not-listed.png`);
});

test('a non-precached, non-navigation request never receives index.html', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  worker.state.online = false;

  const promise = worker.dispatch('fetch', { request: request('assets/not-listed.png') });
  await assert.rejects(promise, /offline/);
});

test('cross-origin and non-GET requests bypass the worker', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});

  assert.equal(worker.dispatch('fetch', { request: { method: 'GET', mode: 'cors', url: 'https://other.test/x.js' } }), undefined);
  assert.equal(worker.dispatch('fetch', { request: { method: 'POST', mode: 'cors', url: `${BASE}api` } }), undefined);
});

test('a missing file fails the install loudly and leaves no half cache', async () => {
  const worker = createWorker({ failUrl: 'src/main.js' });
  await assert.rejects(worker.dispatch('install', {}), /Precache failed/);
  assert.ok(worker.state.errors.length > 0, 'the failure is logged');
  assert.equal(worker.state.messages.at(-1)?.type, 'precache-error');
  assert.ok(worker.state.messages.at(-1).problems.some((problem) => problem.includes('src/main.js')));
  assert.equal(worker.stores.size, 0, 'the incomplete cache is deleted');
  assert.equal(worker.state.skipped, 0);
});

test('a same-build failed reinstall keeps the live cache intact', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  const before = liveCache(worker);
  const cachedCount = before.entries.size;

  worker.state.failUrl = 'src/main.js';
  await assert.rejects(worker.dispatch('install', {}), /Precache failed/);

  const after = liveCache(worker);
  assert.ok(after, 'the live cache still exists');
  assert.equal(after.entries.size, cachedCount, 'the live cache was not emptied');
  worker.state.online = false;
  const response = await worker.dispatch('fetch', { request: request('src/main.js') });
  assert.equal(response.url, `${BASE}src/main.js`, 'the active worker can still serve the shell');
});

test('a response whose content type contradicts the file extension is rejected', async () => {
  const worker = createWorker({ plan: (href) => (href.endsWith('src/main.js') ? { contentType: 'text/html; charset=utf-8' } : {}) });
  await assert.rejects(worker.dispatch('install', {}), /content type/);
  assert.ok(worker.state.messages.at(-1).problems.some((problem) => problem.includes('src/main.js')));
  assert.equal(worker.stores.size, 0);
});

test('a known extension without a Content-Type fails the install', async () => {
  for (const contentType of [null, '']) {
    const worker = createWorker({ plan: (href) => (href.endsWith('src/main.js') ? { contentType } : {}) });
    await assert.rejects(worker.dispatch('install', {}), /no content type/);
    assert.equal(worker.state.messages.at(-1)?.type, 'precache-error');
    assert.ok(worker.state.messages.at(-1).problems.some((problem) => problem.includes('src/main.js')));
    assert.equal(worker.stores.size, 0, 'nothing is promoted');
  }
});

test('a body that does not match its manifest digest fails the install', async () => {
  const worker = createWorker({
    plan: (href) => (href.endsWith('src/main.js') ? { body: Buffer.from('// tampered module') } : {}),
  });
  await assert.rejects(worker.dispatch('install', {}), /content hash/);
  assert.equal(worker.state.messages.at(-1)?.type, 'precache-error');
  assert.ok(
    worker.state.messages.at(-1).problems.some((problem) => problem.includes('src/main.js') && problem.includes('content hash')),
    'the failure names the file and the digest'
  );
  assert.equal(worker.stores.size, 0, 'nothing is promoted');
  assert.equal(worker.state.skipped, 0);
});

test('a missing digest fails the install instead of trusting the body', async () => {
  const precache = manifestSource.replace(/^    'src\/main\.js': '[0-9a-f]{64}',\n/m, '');
  assert.notEqual(precache, manifestSource, 'the fixture removed one digest');
  const worker = createWorker({ manifestSource: precache });
  await assert.rejects(worker.dispatch('install', {}), /digest list is incomplete/);
  assert.equal(worker.stores.size, 0);
});

test('a digest list that disagrees with the file list fails the install', async () => {
  const precache = manifestSource.replace(
    /^    'src\/main\.js': '[0-9a-f]{64}',\n/m,
    `    'src/main.js': '${'0'.repeat(64)}',\n    'src/ghost.js': '${'0'.repeat(64)}',\n`
  );
  assert.notEqual(precache, manifestSource);
  const worker = createWorker({ manifestSource: precache });
  await assert.rejects(worker.dispatch('install', {}), /outside the manifest/);
  assert.equal(worker.stores.size, 0);
});

test('a redirected precache response is rejected', async () => {
  const worker = createWorker({
    plan: (href) => (href.endsWith('assets/app.css') ? { redirected: true, redirectUrl: `${BASE}index.html` } : {}),
  });
  await assert.rejects(worker.dispatch('install', {}), /redirected/);
  assert.equal(worker.stores.size, 0);
});

test('a missing manifest still fails the install with a posted error', async () => {
  const worker = createWorker({ missingManifest: true });
  await assert.rejects(worker.dispatch('install', {}), /missing or malformed/);
  assert.equal(worker.state.messages.at(-1)?.type, 'precache-error');
  assert.ok(worker.state.errors.length > 0, 'the load failure is logged');
});

test('a manifest newer than the worker is a stale worker, not a page error', async () => {
  const stale = swSource.replace(/const BUILD = '[0-9a-f]{16}';/, "const BUILD = 'ffffffffffffffff';");
  const worker = createWorker({ swSource: stale });
  await assert.rejects(worker.dispatch('install', {}), /stale worker build/);
  assert.equal(worker.state.messages.length, 0, 'a torn pair is not reported as a precache error');
  assert.equal(worker.stores.size, 0, 'nothing is cached from a stale worker');
  assert.equal(worker.state.infos.at(-1)?.includes('stale worker'), true, 'the skew is logged at info');
});

test('activate deletes older drypoint caches and keeps the current one', async () => {
  const worker = createWorker();
  await worker.dispatch('install', {});
  const current = [...worker.stores.keys()][0];
  await worker.dispatch('activate', {});
  assert.ok(worker.stores.has(current));
  assert.equal(worker.state.claimed, 1);

  const other = createWorker();
  other.stores.set('drypoint-old', new FakeCache());
  other.stores.set('another-app', new FakeCache());
  await other.dispatch('install', {});
  await other.dispatch('activate', {});
  assert.ok(!other.stores.has('drypoint-old'));
  assert.ok(other.stores.has('another-app'), 'unrelated caches are untouched');
});

test('the page-side consumer reports a precache failure and ignores other messages', () => {
  const listeners = new Set();
  const container = {
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
  };
  const failures = [];
  const unsubscribe = watchPrecacheErrors(container, (failure) => failures.push(failure));

  for (const listener of listeners) listener({ data: { type: 'something-else' } });
  for (const listener of listeners) listener({ data: { type: 'precache-error', message: 'Precache failed: x', problems: ['x: HTTP 404'] } });
  for (const listener of listeners) listener({ data: { type: 'precache-error', message: 'Precache failed: y' } });

  assert.deepEqual(failures, [
    { message: 'Precache failed: x', problems: ['x: HTTP 404'] },
    { message: 'Precache failed: y', problems: [] },
  ]);

  unsubscribe();
  assert.equal(listeners.size, 0);
});

/* ---------------- bounded navigation and cache-storage failures (R5E-3/R5E-4) ---------------- */

test('the generated manifest carries the one navigation timeout', () => {
  assert.equal(manifest().navigationTimeoutMs, CONFIG.offline.navigationTimeoutMs);
  assert.equal(CONFIG.offline.navigationTimeoutMs, 3000);
});

test('a navigation that never answers returns the cached shell instead of hanging', async () => {
  const precache = manifestSource.replace(/navigationTimeoutMs: \d+/, 'navigationTimeoutMs: 20');
  assert.notEqual(precache, manifestSource, 'the fixture stamped a 20 ms bound');
  const worker = createWorker({ manifestSource: precache, plan: (href) => (href === BASE ? { hang: true } : {}) });
  await worker.dispatch('install', {});

  const started = Date.now();
  const response = await worker.dispatch('fetch', { request: request('', 'navigate') });
  const elapsed = Date.now() - started;
  assert.equal(response.url, `${BASE}index.html`, 'the cached shell answers');
  assert.ok(elapsed < 1000, `the wait is bounded by the stamped value (took ${elapsed} ms)`);
  assert.equal(worker.state.aborted, true, 'the losing network request is aborted');
});

test('a timed-out navigation with no cached shell rethrows instead of inventing one', async () => {
  const precache = manifestSource.replace(/navigationTimeoutMs: \d+/, 'navigationTimeoutMs: 20');
  const worker = createWorker({ manifestSource: precache, plan: (href) => (href === BASE ? { hang: true } : {}) });
  // No install: there is no shell to fall back to.
  await assert.rejects(worker.dispatch('fetch', { request: request('', 'navigate') }), /did not answer within 20 ms/);
  assert.equal(worker.state.aborted, true);
});

test('a cache-storage failure during install reaches the page exactly once', async () => {
  for (const operation of ['delete', 'open', 'has']) {
    const worker = createWorker({ throwOn: operation });
    await assert.rejects(worker.dispatch('install', {}), /Precache failed/);
    const messages = worker.state.messages.filter((message) => message.type === 'precache-error');
    assert.equal(messages.length, 1, `${operation}: one precache-error`);
    assert.ok(
      messages[0].problems.some((problem) => problem.includes('cache storage rejected the install')),
      `${operation}: the reason reaches the page`
    );
    assert.equal(worker.state.skipped, 0, `${operation}: a failed install never activates`);
  }
});

/* ---------------- one precache failure, one reaction (R5G-5) ---------------- */

test('a precache failure produces one log error and one toast, then unsubscribes', () => {
  const listeners = new Set();
  const container = {
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
  };
  const errors = [];
  const toasts = [];
  const unsubscribe = registerPrecacheErrors(container, {
    log: { error: (message, detail) => errors.push({ message, detail }) },
    toast: (message, options) => toasts.push({ message, options }),
  });

  for (const listener of listeners) listener({ data: { type: 'precache-error', message: 'Precache failed: app.css', problems: ['app.css: HTTP 404'] } });
  assert.deepEqual(errors, [{ message: 'precache install failed', detail: { message: 'Precache failed: app.css', problems: ['app.css: HTTP 404'] } }]);
  assert.deepEqual(toasts, [{ message: 'Precache failed: app.css', options: { tone: 'error' } }]);

  // An unrelated worker message must not produce a second reaction.
  for (const listener of listeners) listener({ data: { type: 'something-else' } });
  assert.equal(errors.length, 1);
  assert.equal(toasts.length, 1);

  unsubscribe();
  assert.equal(listeners.size, 0, 'a page that stopped listening is not called again');
});

/* ---------------- the offline-shell boot boundary (O1) ---------------- */

test('the boot boundary registers the worker and reports one failure per message', async () => {
  const messages = new Set();
  let loadListener = null;
  const registered = [];
  const errors = [];
  const warnings = [];
  const toasts = [];
  const serviceWorker = {
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      messages.add(listener);
    },
    removeEventListener(type, listener) {
      messages.delete(listener);
    },
    async register(url, options) {
      registered.push([url, options]);
    },
  };

  assert.equal(
    bootOfflineShell({
      serviceWorker,
      addWindowListener: (type, listener) => {
        assert.equal(type, 'load');
        loadListener = listener;
      },
      log: { error: (message, detail) => errors.push({ message, detail }), warn: (message, detail) => warnings.push({ message, detail }) },
      toast: (message, options) => toasts.push({ message, options }),
    }),
    true
  );

  for (const listener of messages) listener({ data: { type: 'precache-error', message: 'Precache failed: app.css', problems: ['app.css: HTTP 404'] } });
  assert.deepEqual(errors, [{ message: 'precache install failed', detail: { message: 'Precache failed: app.css', problems: ['app.css: HTTP 404'] } }]);
  assert.deepEqual(toasts, [{ message: 'Precache failed: app.css', options: { tone: 'error' } }]);

  assert.ok(loadListener, 'the worker is registered after load');
  loadListener();
  assert.deepEqual(registered, [['sw.js', { updateViaCache: 'none' }]]);

  // A failed registration is a warning in the one log, never an unhandled
  // rejection.
  serviceWorker.register = async () => {
    throw new Error('registration blocked');
  };
  loadListener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, [{ message: 'service worker failed', detail: { message: 'registration blocked' } }]);
});

test('the boot boundary does nothing without a worker or inside the Android shell', () => {
  let windowTouched = 0;
  const options = {
    addWindowListener: () => windowTouched++,
    log: { error() {}, warn() {} },
    toast() {},
  };
  assert.equal(bootOfflineShell({ ...options, serviceWorker: null }), false);
  assert.equal(bootOfflineShell({ ...options, serviceWorker: { addEventListener() {}, register() {} }, isAndroidShell: true }), false);
  assert.equal(windowTouched, 0, 'neither shell subscribes to load or a failure message');
});
