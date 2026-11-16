/**
 * Pages staging: the deployment is the runtime surface and nothing else.
 *
 * The file list comes from `collectFiles()` — the same owner the service worker
 * and the APK use — so a second list cannot exist. These tests build into a
 * temporary directory and compare bytes, then prove the generated 404 page
 * keeps the fragment and the manifest is staged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  NOT_FOUND_FILE,
  NO_JEKYLL_FILE,
  PRECACHE_FILE,
  SITE_DIR,
  WORKER_FILE,
  assertPrecacheFresh,
  buildPages,
  checkSite,
  notFoundPage,
  pagesBasePath,
  siteEntries,
} from '../scripts/build-pages.mjs';
import { collectFiles } from '../scripts/precache.mjs';
import { BRAND } from '../src/core/brand.js';
import { projectRoot } from './helpers/project-files.mjs';

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(join(directory, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

async function temporarySite(t) {
  const out = await mkdtemp(join(tmpdir(), 'drypoint-site-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  return out;
}

test('the staged tree is exactly the runtime files plus the site files', async (t) => {
  const out = await temporarySite(t);
  const { entries } = await buildPages({ out });
  const runtime = await collectFiles();
  const expected = [...runtime, WORKER_FILE, PRECACHE_FILE, NOT_FOUND_FILE, NO_JEKYLL_FILE].sort();

  assert.deepEqual(await walk(out), expected, 'no extra file, no missing file');
  assert.equal(entries.length, runtime.length + 4);
  assert.equal(runtime.length > 0, true, 'the runtime list is not empty');
});

test('every script the worker imports is staged, or the worker cannot install', async (t) => {
  const out = await temporarySite(t);
  await buildPages({ out });
  const worker = await readFile(join(projectRoot, WORKER_FILE), 'utf8');
  const imports = [...worker.matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'the worker imports at least its manifest');

  const staged = new Set(await walk(out));
  for (const path of imports) {
    assert.ok(staged.has(path), `${WORKER_FILE} imports ${path}, so the site must publish it`);
  }
});

test('the deployment never contains a repository-only file', async (t) => {
  const out = await temporarySite(t);
  await buildPages({ out });
  const staged = await walk(out);

  for (const forbidden of ['android/', 'test/', '.github/', 'scripts/', 'docs/', '.git']) {
    assert.deepEqual(staged.filter((path) => path.startsWith(forbidden)), [], `nothing under ${forbidden}`);
  }
  for (const name of ['package.json', 'brand.json', 'README.md', 'LICENSE', 'sw.js.map']) {
    assert.equal(staged.includes(name), false, `${name} is not published`);
  }
  assert.deepEqual(staged.filter((path) => /\.(?:jks|keystore|p12|pem|key|apk|aab)$/.test(path)), [], 'no key or package artifact');
  assert.equal(staged.includes('android/keystore/keystore.properties'), false);
});

test('every copied file is byte-identical to its source', async (t) => {
  const out = await temporarySite(t);
  await buildPages({ out });
  for (const file of await collectFiles()) {
    const [source, staged] = await Promise.all([readFile(join(projectRoot, file)), readFile(join(out, file))]);
    assert.deepEqual(staged, source, `${file} is staged unchanged`);
  }
  assert.equal((await readFile(join(out, NO_JEKYLL_FILE), 'utf8')), '', '.nojekyll is the empty opt-out marker');
});

test('the manifest is staged and keeps its subpath-safe URLs', async (t) => {
  const out = await temporarySite(t);
  await buildPages({ out });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, BRAND.name);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.equal((await stat(join(out, icon.src))).isFile(), true, `${icon.src} is staged`);
  }
});

test('the 404 page targets the site root and keeps the fragment', async () => {
  const html = notFoundPage('/drypoint/');
  const base = html.match(/<base href="([^"]+)">/)?.[1];
  assert.equal(base, '/drypoint/', 'the document base is the deployment root');
  assert.match(html, /<meta http-equiv="refresh" content="0; url=\/drypoint\/">/);

  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the redirect script is inline and testable');
  for (const hash of ['#layer-2', '']) {
    const replaced = [];
    vm.runInNewContext(script, { location: { hash, replace: (url) => replaced.push(url) } });
    assert.deepEqual(replaced, [`./${hash}`], 'the target is the relative site root');
    // The base element is what makes `./` land on the app, not on the path
    // that missed: resolve it the way a browser would.
    const target = new URL(replaced[0], `https://llm-4-people.github.io${base}`);
    assert.equal(target.pathname, '/drypoint/');
    assert.equal(target.hash, hash);
  }
});

test('the site root is derived from the one authored homepage', () => {
  assert.equal(pagesBasePath('https://llm-4-people.github.io/drypoint/'), '/drypoint/');
  assert.equal(pagesBasePath('https://llm-4-people.github.io/drypoint'), '/drypoint/');
  assert.equal(pagesBasePath('https://llm-4-people.github.io/'), '/');
  assert.throws(() => pagesBasePath('not a url'), /absolute http/);
  assert.throws(() => pagesBasePath('ftp://example.com/x'), /absolute http/);
  assert.equal(pagesBasePath(), '/drypoint/', 'the default is the authored homepage');
});

test('an empty or duplicated runtime list is refused', () => {
  assert.throws(() => siteEntries([]), /runtime file list is empty/);
  const entries = siteEntries(['index.html', 'index.html', 'src/main.js']);
  const paths = entries.map((entry) => entry.path);
  assert.equal(paths.filter((path) => path === 'index.html').length, 1, 'a duplicate is staged once');
  assert.equal(new Set(paths).size, paths.length, 'no path appears twice');
});

test('staging refuses a stale generated manifest', async (t) => {
  const out = await temporarySite(t);
  const stale = async () => {
    throw new Error('the generated precache manifest or worker stamp is stale');
  };
  await assert.rejects(buildPages({ out, checkFresh: stale }), /stale/);
  await assert.rejects(checkSite({ out, checkFresh: stale }), /stale/);
  assert.deepEqual(await readdir(out), [], 'nothing was staged before the refusal');
});

test('the real generated files are current, so a real build is allowed', async () => {
  const fresh = await assertPrecacheFresh();
  assert.equal(fresh.ok, true, 'run: npm run build');
  assert.match(fresh.version, /^[0-9a-f]{16}$/);
});

test('--check reports a missing file, a changed file and an extra file', async (t) => {
  const out = await temporarySite(t);
  await buildPages({ out });
  assert.deepEqual((await checkSite({ out })).findings, [], 'a fresh build matches');

  await writeFile(join(out, 'index.html'), 'changed');
  let findings = (await checkSite({ out })).findings;
  assert.deepEqual(findings, ['index.html: staged bytes differ from the source'], 'a changed file is reported');

  await unlink(join(out, 'index.html'));
  findings = (await checkSite({ out })).findings;
  assert.ok(findings.includes('index.html: missing from the staged site'), 'a missing file is reported');

  await writeFile(join(out, 'stray.txt'), 'x');
  findings = (await checkSite({ out })).findings;
  assert.ok(findings.includes('stray.txt: staged file is not part of the site'), 'an extra file is reported');
});

test('the command line stages and then verifies the same tree', async (t) => {
  const out = await temporarySite(t);
  const script = join(projectRoot, 'scripts', 'build-pages.mjs');
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });

  const built = run('--out', out);
  assert.match(built, /pages: staged \d+ files/);
  const checked = run('--out', out, '--check');
  assert.match(checked, /match the sources/);

  await writeFile(join(out, 'stray.txt'), 'x');
  assert.throws(
    () => run('--out', out, '--check'),
    (error) => error.status === 1 && /staged file is not part of the site/.test(error.stderr),
    'the check exits 1 and names the stray file'
  );
  assert.throws(
    () => run('--bogus'),
    (error) => error.status === 2 && /unknown option/.test(error.stderr),
    'an unknown option is a usage error'
  );
});

test('the default output directory is the git-ignored _site', async () => {
  assert.equal(SITE_DIR, '_site');
  const ignored = await readFile(join(projectRoot, '.gitignore'), 'utf8');
  assert.match(ignored, /^_site\/$/m);
});
