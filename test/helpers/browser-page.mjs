/**
 * The one Chromium page harness for measured layout tests.
 *
 * It serves the app surface read-only, starts a headless Chromium with a fresh
 * profile, connects to its DevTools socket and hands the test a `send`/
 * `evaluate` pair. Tests that need no Chromium are unaffected: `withPage`
 * skips the test when the binary is missing.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, createReadStream, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, join, sep } from 'node:path';

import { projectRoot } from './project-files.mjs';

/** Where an installed Playwright keeps its browsers. Built at run time, never committed. */
const PLAYWRIGHT_CACHE = join(homedir(), '.cache', 'ms-playwright');

/**
 * The newest Chromium a Playwright cache holds, when one is installed.
 *
 * The path is assembled from `homedir()` so this file never carries a
 * machine-specific absolute path; the privacy gate fails the build on one.
 */
function findCachedChrome() {
  let entries;
  try {
    entries = readdirSync(PLAYWRIGHT_CACHE, { withFileTypes: true });
  } catch {
    return null;
  }
  const builds = entries
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)));
  for (const build of builds) {
    for (const layout of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = join(PLAYWRIGHT_CACHE, build, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Locate a Chromium binary without a machine-specific path: an explicit
 * D110_CHROME/CHROME_PATH wins, then the ordinary executable names on PATH,
 * then the Playwright browser cache.
 *
 * An explicit path is taken as written even when it does not exist: a CI job
 * configured with the wrong browser must fail, not quietly use another one.
 * A missing binary skips the measured tests locally and fails them in CI
 * (`CI=true`), so a skip can never hide a layout regression on the pipeline.
 */
function findChrome() {
  const explicit = process.env.D110_CHROME || process.env.CHROME_PATH;
  if (explicit) return explicit;
  const names = ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable', 'chrome'];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking; PATH is a search path, not a promise.
      }
    }
  }
  return findCachedChrome();
}

export const CHROME = findChrome();

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The port Chromium chose for its DevTools endpoint.
 *
 * `--remote-debugging-port=0` asks the OS for a free port and Chromium records
 * the result in `DevToolsActivePort` inside its profile. Probing a port here and
 * handing the number to Chromium would be a check-then-bind race that two
 * parallel test files can lose — one takes the port in the gap, and the other
 * dies with EADDRINUSE. Reading the allocation's own record has no gap.
 */
/**
 * How long to wait for Chromium to publish its DevTools port. Three layout
 * suites can start their own browser at the same time on a two-core CI runner,
 * so the bound has to cover contention, not just a warm local start. Override
 * with `D110_CHROME_TIMEOUT_MS` when a slower machine needs more.
 */
const DEVTOOLS_TIMEOUT_MS = (() => {
  const raw = Number(process.env.D110_CHROME_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
})();

/**
 * @param {string} profile
 * @param {{ timeoutMs?: number, exited?: () => { code: number|null, signal: string|null, stderr: string }|null }} options
 */
async function waitForDevToolsPort(profile, { timeoutMs = DEVTOOLS_TIMEOUT_MS, exited = () => null } = {}) {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [first] = (await readFile(file, 'utf8')).split('\n');
      const port = first.trim();
      if (/^\d+$/.test(port)) return Number(port);
    } catch {
      // Chromium has not written the file yet.
    }
    const status = exited();
    if (status) {
      const detail = status.stderr.trim().split('\n').slice(-6).join('\n');
      throw new Error(
        `Chromium exited before publishing DevToolsActivePort ` +
          `(code=${status.code}, signal=${status.signal})${detail ? `:\n${detail}` : ''}`
      );
    }
    await delay(50);
  }
  throw new Error(
    `Chromium did not write DevToolsActivePort within ${timeoutMs} ms; ` +
      'raise D110_CHROME_TIMEOUT_MS on a slow or heavily loaded machine'
  );
}

/** Serve the app surface only, read-only, for the layout probes. */
function appServer() {
  return createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    if (path === '/') path = '/index.html';
    if (!/^\/(?:index\.html|manifest\.webmanifest|sw\.js|(?:src|assets)\/)/.test(path) || path.includes('\0')) {
      response.writeHead(404).end('Not found');
      return;
    }
    const file = join(projectRoot, path);
    const root = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
}

async function connect(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      // Newer Chromium builds publish internal targets too; the page we opened
      // is the one to drive, never whichever entry happens to be first.
      target = list.find((entry) => entry.type === 'page') ?? list[0];
      if (target) break;
    } catch {
      await delay(100);
    }
  }
  if (!target) throw new Error('Chromium did not expose a debugging target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium debugging socket did not open')), timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Chromium debugging socket failed'));
    });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  };
  return { send, evaluate, socket };
}

/**
 * Navigate to the served app and wait until the editor has actually mounted.
 *
 * A fixed delay after `Page.navigate` is a race: a cold, loaded CI runner can
 * spend longer than the delay booting the module graph, and the test then
 * inspects a half-built page. Readiness is the real contract every layout test
 * depends on, so it lives here rather than in each test's sleep.
 *
 * @param {{send: Function, evaluate: Function}} cdp
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 */
export async function openApp(cdp, port, { timeoutMs = 15000 } = {}) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => ({
      ready: document.readyState,
      tools: document.querySelectorAll('#toolRail button').length,
      title: document.title,
    }))()`);
    if (state?.ready === 'complete' && state.tools > 0) return state;
    await delay(100);
  }
  const dump = await cdp.evaluate('document.body ? document.body.innerText.slice(0, 200) : ""');
  throw new Error(`the editor did not mount within ${timeoutMs} ms (body: ${JSON.stringify(dump)})`);
}

/**
 * Run `body({ cdp, port })` against a fresh headless Chromium. Skips the test
 * when no Chromium binary is available.
 */
export async function withPage(t, body) {
  if (!CHROME || !existsSync(CHROME)) {
    // A skip is honest locally; in CI it would hide a layout regression.
    if (process.env.CI === 'true') {
      throw new Error('Chromium is required in CI: set D110_CHROME or CHROME_PATH (or put chromium on PATH)');
    }
    t.skip('no Chromium binary; the measured layout check needs one');
    return;
  }
  const server = appServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'drypoint-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // CI containers can have a small /dev/shm; three concurrent browsers
      // must not take each other down through it.
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    // stderr is kept so a failed start names Chromium's own reason instead of
    // only "no DevTools port".
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => {
    chromeStderr = `${chromeStderr}${chunk}`.slice(-8192);
  });
  const exited = () =>
    chrome.exitCode !== null || chrome.signalCode
      ? { code: chrome.exitCode, signal: chrome.signalCode, stderr: chromeStderr }
      : null;
  t.after(async () => {
    chrome.kill('SIGTERM');
    // Removing the profile while Chromium is still flushing it fails with
    // ENOTEMPTY; wait for the process (bounded) before deleting.
    await new Promise((resolve) => {
      if (chrome.exitCode !== null) return resolve();
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 2000);
      chrome.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const cdp = await connect(await waitForDevToolsPort(profile, { exited }));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await body({ cdp, port });
}
