/**
 * R7-3: the dev server's loopback and app-surface promises run against a real
 * child process and a real socket. A source grep cannot catch a host rewrite or
 * an accidentally served keystore; this does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectRoot } from './helpers/project-files.mjs';

const COPY = ['assets', 'scripts', 'src', 'index.html', 'manifest.webmanifest', 'sw.js', 'package.json'];

async function copyProject() {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-server-'));
  for (const entry of COPY) await cp(join(projectRoot, entry), join(directory, entry), { recursive: true });
  return directory;
}

/**
 * A free port for the child server.
 *
 * Asking the OS for port 0 hands out a number from the ephemeral range, and
 * that number goes stale the moment the probe socket closes: a parallel test's
 * outgoing connection or another probe can take it before the server binds, and
 * the server exits with EADDRINUSE. The range below 32768 is outside the Linux,
 * Windows and macOS ephemeral allocators, so only a real listener can hold it —
 * and the probe proves one does not.
 */
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 8000);
    const probe = createServer();
    const free = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error('no free port in the reserved test range');
}

function start(directory, args, env = {}) {
  const child = spawn(process.execPath, ['scripts/serve.mjs', ...args], {
    cwd: directory,
    // A developer's PORT/HOST must not leak into the assertions.
    env: { ...process.env, PORT: '', HOST: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    run.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    run.stderr += chunk;
  });
  run.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return run;
}

async function waitForOutput(run, text, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.stdout.includes(text)) return;
    if (run.child.exitCode !== null) throw new Error(`server exited before "${text}":\n${run.stdout}\n${run.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for "${text}":\n${run.stdout}\n${run.stderr}`);
}

async function stop(run) {
  if (run.child.exitCode === null) run.child.kill('SIGTERM');
  try {
    return await exitWithin(run);
  } finally {
    // Never leave a server behind for the runner to wait on.
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
  }
}

/**
 * Await a child exit with a bound. A regression that leaves the server running
 * must fail the test with its output, not hang the whole run.
 */
async function exitWithin(run, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`server did not exit within ${timeoutMs} ms\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)),
      timeoutMs
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([run.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a script the server must serve and prove it is real JavaScript: the
 * declared type and `node --check` on the delivered bytes.
 */
async function assertJavaScript(response, label, directory) {
  assert.equal(response.status, 200, `${label} is served`);
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/, `${label} has a JavaScript content type`);
  const body = await response.text();
  assert.ok(body.length > 0, `${label} has a body`);
  const file = join(directory, `.check-${label.replaceAll('/', '-')}`);
  await writeFile(file, body);
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  await rm(file, { force: true });
}

test('the real server binds loopback and serves only the app surface', async (t) => {
  const directory = await copyProject();
  // A file that exists under the root but is not in the manifest.
  const keystoreBytes = 'not a real key';
  await mkdir(join(directory, 'android', 'keystore'), { recursive: true });
  await writeFile(join(directory, 'android', 'keystore', 'drypoint-release.jks'), keystoreBytes);
  const port = await freePort();
  const run = start(directory, ['--port', String(port), '--host', '127.0.0.1']);
  t.after(async () => {
    await stop(run);
    await rm(directory, { recursive: true, force: true });
  });

  await waitForOutput(run, 'Local only.');
  assert.doesNotMatch(run.stdout, /LAN:/, 'the default bind is never announced as a LAN service');

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Drypoint/);

  // Regression: the worker and the generated manifest are in the server's
  // surface but outside the precache allowlist. Routing them through the
  // precache predicate answered 403 and the worker never registered.
  for (const path of ['/sw.js', '/assets/precache.js']) {
    await assertJavaScript(await fetch(`http://127.0.0.1:${port}${path}`), path, directory);
  }

  for (const path of ['/android/keystore/drypoint-release.jks', '/docs/ANDROID.md', '/package.json', '/test/server-cli.test.mjs']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 404, `${path} is outside the app surface`);
    await response.arrayBuffer();
  }

  // The stylesheet is on the served surface; use it to prove the symlink guard
  // is what refuses the keystore, not the allowlist.
  const stylesheet = await fetch(`http://127.0.0.1:${port}/assets/app.css`);
  assert.equal(stylesheet.status, 200, 'the stylesheet is served before the swap');
  await stylesheet.arrayBuffer();

  // A keystore symlink planted under assets/ after the surface was computed is
  // still not reachable.
  await symlink(join(directory, 'android', 'keystore', 'drypoint-release.jks'), join(directory, 'assets', 'leak.css'));
  const leak = await fetch(`http://127.0.0.1:${port}/assets/leak.css`);
  assert.equal(leak.status, 404, 'a non-allowlisted symlink to the keystore is not served');
  await leak.arrayBuffer();

  // Same attack on an allowlisted file: the lexical allowlist says yes, so only
  // resolveSurfacePath's real-path check can answer 403.
  await rm(join(directory, 'assets', 'app.css'));
  await symlink(join(directory, 'android', 'keystore', 'drypoint-release.jks'), join(directory, 'assets', 'app.css'));
  const blocked = await fetch(`http://127.0.0.1:${port}/assets/app.css`);
  assert.equal(blocked.status, 403, 'an allowlisted file symlinked to the keystore is refused');
  const blockedBody = Buffer.from(await blocked.arrayBuffer());
  assert.equal(blockedBody.includes(Buffer.from(keystoreBytes)), false, 'the keystore bytes never reach the response');

  // The pid file is keyed by the port and holds this child.
  const tracked = JSON.parse(await readFile(join(directory, '.run', `server-${port}.pid`), 'utf8'));
  assert.equal(tracked.pid, run.child.pid);
  assert.equal(tracked.port, port);

  const { code } = await stop(run);
  assert.equal(code, 0, 'SIGTERM is a clean shutdown');
  assert.match(run.stdout, /stopping server/);
});

test('the precache generator refuses a symlink that resolves to the keystore', async (t) => {
  const directory = await copyProject();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'android', 'keystore'), { recursive: true });
  await writeFile(join(directory, 'android', 'keystore', 'keystore.properties'), 'storePassword=secret');
  await symlink(join(directory, 'android', 'keystore', 'keystore.properties'), join(directory, 'assets', 'leak.css'));
  // Make the stylesheet reference the link so the collector actually walks it.
  await appendFile(join(directory, 'assets', 'app.css'), '\n.leak { background: url(leak.css); }\n');

  const result = spawnSync(process.execPath, ['scripts/precache.mjs', '--write'], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'the generator refuses to build a manifest that ships the keystore');
  assert.match(`${result.stdout}${result.stderr}`, /outside the app surface \(symlink\)/);
  // Nothing was written: a refused surface must not leave a poisoned manifest.
  const manifest = await readFile(join(directory, 'assets', 'precache.js'), 'utf8');
  assert.doesNotMatch(manifest, /leak\.css/);
});

test('a --host flag with no value refuses to start instead of choosing a bind', async (t) => {
  const directory = await copyProject();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = start(directory, ['--port', String(await freePort()), '--host']);
  t.after(() => stop(run));

  const { code } = await exitWithin(run);
  assert.equal(code, 1);
  assert.match(run.stderr, /--host needs a value/);
  assert.doesNotMatch(run.stdout, /Drypoint on/);
});

test('the port helper stays outside the OS ephemeral range', async () => {
  // Regression: a port-0 probe returns a port from the ephemeral range, which
  // goes stale when the probe closes. A parallel test's outgoing connection can
  // take it, the child server exits with EADDRINUSE, and this file fails for a
  // reason that has nothing to do with the server.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    assert.ok(port >= 20000 && port < 28000, `${port} is in the reserved test range`);
    assert.ok(port >= 8080, `${port} is a port the server accepts`);
  }
});
