/**
 * Zero-dependency static server for development.
 *
 * Before listening it regenerates the offline manifest and worker stamp, so the
 * service worker never installs a stale file list. The pid file is keyed by port
 * and holds JSON, which is what scripts/stop.mjs validates before signalling.
 */

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

import { CONFIG } from '../src/core/config.js';
import { isAllowed, OUTPUT, SW_FILE, resolveSurfacePath, writePrecache } from './precache.mjs';
import {
  claimTrackedServer,
  pidFileFor,
  resolveHost,
  resolvePort,
  removeTrackedServerIfOwned,
  writeTrackedServer,
} from './lib/server-state.mjs';

const root = resolve(import.meta.dirname, '..');
const runDir = join(root, '.run');

let port;
let host;
try {
  port = resolvePort();
  host = resolveHost();
} catch (error) {
  console.error(`drypoint: ${error.message}`);
  process.exit(1);
}
const pidFile = pidFileFor(root, port);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Claim the port's pid file; the shared owner decides who may start. */
async function claimPort() {
  const claimed = await claimTrackedServer({
    file: pidFile,
    port,
    deps: {
      write: writeTrackedServer,
      warn: (message) => console.warn(`drypoint: ${message}`),
    },
  });
  if (claimed.ok) return;
  if (claimed.reason === 'tracked') {
    console.error(`drypoint: port ${port} is already tracked by pid ${claimed.record.pid} (started ${claimed.record.startedAt ?? 'unknown'}).`);
    console.error(`      Stop it with: node scripts/stop.mjs --port ${port}`);
  } else {
    console.error(`drypoint: could not claim ${pidFile} for port ${port}`);
  }
  process.exit(1);
}

/**
 * Only the app surface is served: the files the offline manifest lists (each
 * re-asserted against the generator's allowlist) plus the worker itself and its
 * generated manifest. Everything else in the repository — keystore, docs,
 * scripts, tests, package.json, .run — is not reachable even on a LAN bind.
 * There is deliberately no generic static fallback.
 */
let allowed = new Set();

const server = createServer(async (request, response) => {
  const badRequest = () => response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    badRequest();
    return;
  }
  // A malformed escape (`/%ZZ`) must answer 400, not throw out of the handler
  // and take the process down.
  let requested;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    badRequest();
    return;
  }
  if (requested.includes('\0')) {
    badRequest();
    return;
  }
  const rawRelative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const relative = normalize(rawRelative);
  const key = relative.split(sep).join('/');
  if (relative.startsWith('..') || !allowed.has(key)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  // The allowlist is lexical; the shared resolver proves the real file (after
  // symlinks) is still inside the repository, and re-checks the real path
  // against this server's own surface — which includes the worker and the
  // generated manifest even though the precache allowlist does not.
  let filePath;
  try {
    ({ real: filePath } = await resolveSurfacePath(key, { allowed: (candidate) => allowed.has(candidate) }));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    console.error(`drypoint: refused ${key}: ${error.message}`);
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': TYPES[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch (error) {
    // Only "this file is not here" is a 404. A permission or I/O failure is a
    // server fault and must not masquerade as a missing page.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    console.error(`drypoint: could not read ${relative}: ${error.message}`);
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal error');
  }
});

server.on('error', async (error) => {
  // A post-listen error does not stop the server; only remove the record when
  // this process never started listening.
  if (!server.listening) await removeTrackedServerIfOwned(pidFile, process.pid);
  if (error.code === 'EADDRINUSE') {
    console.error(`drypoint: port ${port} is already in use by another process.`);
    console.error(`      If it is this project's server: node scripts/stop.mjs --port ${port}`);
    console.error(`      If it is untracked, find it with "ss -ltnp 'sport = :${port}'" (Linux) or`);
    console.error(`      "netstat -ano | findstr :${port}" (Windows) and stop it with: node scripts/stop.mjs --pid <pid>`);
    console.error(`      Or use another port: node scripts/serve.mjs --port ${port + 1}
      (Windows: npm start -- --port ${port + 1} --host 127.0.0.1)`);
  } else if (error.code === 'EACCES') {
    console.error(`drypoint: not allowed to listen on port ${port}. Use PORT=8080 or higher.`);
  } else {
    console.error(`drypoint: server failed: ${error.message}`);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\ndrypoint: ${signal}; stopping server`);
  await new Promise((resolveClose) => {
    const timer = setTimeout(resolveClose, 2000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolveClose();
    });
    server.closeIdleConnections?.();
  });
  await removeTrackedServerIfOwned(pidFile, process.pid);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(signal));

await mkdir(runDir, { recursive: true });
try {
  const built = await writePrecache();
  const outsideSurface = built.files.filter((file) => !isAllowed(file));
  if (outsideSurface.length) {
    throw new Error(`the manifest contains files outside the app surface: ${outsideSurface.join(', ')}`);
  }
  allowed = new Set([...built.files, SW_FILE, OUTPUT]);
  console.log(`precache: ${built.files.length} files (version ${built.version})`);
} catch (error) {
  console.error(`drypoint: could not generate the offline manifest: ${error.message}`);
  process.exit(1);
}

await claimPort();

server.listen(port, host, () => {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  console.log(`${CONFIG.app.name} on http://localhost:${port}/  (pid ${process.pid})`);
  if (loopback) {
    console.log('  Local only. For a phone: node scripts/serve.mjs --host 0.0.0.0 (or adb reverse).');
  } else {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
      .map((entry) => `http://${entry.address}:${port}/`);
    for (const address of addresses) console.log(`  LAN: ${address}`);
    console.log('  Serving only the app surface. Web Serial needs localhost or HTTPS.');
  }
});
