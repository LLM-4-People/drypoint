/**
 * P-F3: the deployment smoke must see the files a PWA cannot live without.
 *
 * The smoke used to probe only the precache manifest and the notices, so a
 * deployment that lost `sw.js` or `assets/precache.js`, or served a module as
 * `text/html`, passed. These tests stage the real Pages output, serve it, and
 * break one file at a time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPages } from '../scripts/build-pages.mjs';
import { contentTypeFor } from '../scripts/lib/content-types.mjs';
import { parseManifest } from '../scripts/precache.mjs';
import {
  checkDeployment,
  MANIFEST_PATH,
  probeMethod,
  PROBED_SITE_FILES,
  smokePaths,
  workerBuild,
} from '../scripts/smoke-pages.mjs';

async function stagedSite(t) {
  const out = await mkdtemp(join(tmpdir(), 'drypoint-smoke-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildPages({ out });
  return out;
}

/**
 * Serve the staged tree the way the project's own server would, with one knob
 * for each planted defect: a missing path or a wrong content type.
 */
async function serve(t, out, { missing = [], types = {}, redirect = [], altered = [] } = {}) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
    if (redirect.includes(path)) {
      response.writeHead(302, { location: `${path}?redirected=1` }).end();
      return;
    }
    if (missing.includes(path)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('missing');
      return;
    }
    try {
      const body = altered.includes(path)
        ? Buffer.from('altered')
        : await readFile(join(out, path === '/' ? 'index.html' : path.replace(/^\/+/, '')));
      response.writeHead(200, { 'content-type': types[path] ?? contentTypeFor(path) }).end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('missing');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('the deployment set includes the worker, the manifest and the 404 page', async (t) => {
  const out = await stagedSite(t);
  const paths = await smokePaths({ root: out });

  assert.ok(paths.includes('/'), 'the document root is always probed');
  for (const file of PROBED_SITE_FILES) {
    assert.ok(paths.includes(`/${file}`), `${file} is probed`);
  }
  assert.ok(paths.includes('/CNAME'), 'the custom domain marker is probed');
  assert.ok(paths.includes('/assets/social-card.png'), 'the social card is probed');
  assert.ok(paths.includes('/assets/app.css'), 'the precache manifest still supplies the app files');
  assert.equal(paths.includes('/.nojekyll'), false, '.nojekyll is a host control marker, not app content');

  assert.equal(probeMethod('/sw.js'), 'GET', 'the worker body and type are read');
  assert.equal(probeMethod('/assets/precache.js'), 'GET', 'the manifest body and type are read');
  assert.equal(probeMethod('/404.html'), 'GET', 'the fallback body and type are read');
  assert.equal(probeMethod('/assets/app.css'), 'HEAD', 'a precached asset only has to answer');
  assert.equal(probeMethod('/assets/social-card.png'), 'HEAD', 'a binary deployment asset only has to answer');
});

test('a complete staged deployment passes every URL and content type', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out);
  const results = await checkDeployment(base, {
    paths: await smokePaths({ root: out }),
    attempts: 1,
    delayMs: 0,
  });
  assert.ok(results.length > 60, `the whole app is probed (${results.length} URLs)`);
  assert.ok(results.every((result) => result.status === 200));
  assert.ok(results.some((result) => result.path === '/manifest.webmanifest'), 'the installable manifest is probed');
});

test('a deployment missing sw.js fails the smoke', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { missing: ['/sw.js'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /\/sw\.js never answered 200/,
    'a deployment without its worker is broken'
  );
});

test('a deployment missing assets/precache.js fails the smoke', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { missing: ['/assets/precache.js'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /\/assets\/precache\.js never answered 200/
  );
});

test('a deployment missing 404.html fails the smoke', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { missing: ['/404.html'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /\/404\.html never answered 200/
  );
});

test('a deployment missing CNAME fails the smoke', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { missing: ['/CNAME'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /\/CNAME never answered 200/,
    'a deployment without the custom domain marker is incomplete'
  );
});

test('a worker or manifest served as HTML fails the smoke', async (t) => {
  const out = await stagedSite(t);
  const cases = [
    ['/sw.js', /\/sw\.js: content type "text\/html" contradicts the file extension/],
    ['/assets/precache.js', /content type "text\/html" contradicts the file extension/],
    ['/404.html', /content type "text\/plain" contradicts the file extension/],
  ];
  for (const [path, expected] of cases) {
    const base = await serve(t, out, { types: { [path]: path.endsWith('.html') ? 'text/plain' : 'text/html' } });
    await assert.rejects(
      checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
      expected,
      `${path} with the wrong type fails`
    );
  }
});

test('the manifest keeps its stricter installability type', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { types: { [MANIFEST_PATH]: 'text/plain; charset=utf-8' } });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /the manifest is served as "text\/plain", not application\/manifest\+json/
  );
});

test('a same-path redirect fails the smoke even when the bytes are identical', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { redirect: ['/assets/app.css'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /redirected to .*a deployment must serve the file at its own path/
  );
});

test('an altered deployed file fails the digest check', async (t) => {
  const out = await stagedSite(t);
  const base = await serve(t, out, { altered: ['/src/core/log.js'] });
  await assert.rejects(
    checkDeployment(base, { paths: await smokePaths({ root: out }), attempts: 1, delayMs: 0 }),
    /does not match the manifest digest/
  );
});

test('the deployed manifest and worker stamp carry one version', async (t) => {
  const out = await stagedSite(t);
  const manifest = parseManifest(await readFile(join(out, 'assets/precache.js'), 'utf8'));
  const worker = await readFile(join(out, 'sw.js'), 'utf8');
  assert.equal(workerBuild(worker), manifest.version, 'the generated pair agrees');
  const mismatched = worker.replace(/const BUILD = '[0-9a-f]+'/, "const BUILD = 'deadbeefdeadbeef'");
  assert.notEqual(workerBuild(mismatched), manifest.version, 'a different stamp is detectable');
});
