/**
 * One owner for CI browser discovery. The policy is: fail when no browser is
 * found, fail below the tested major floor, and record the resolved versions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIN_CHROMIUM_MAJOR,
  chromiumMajor,
  findChromeForCi,
  resolveChrome,
  writeChromeEnv,
} from '../scripts/find-chrome.mjs';

test('the major is read from a Chrome or Chromium version line', () => {
  assert.equal(chromiumMajor('Google Chrome 145.0.7632.116'), 145);
  assert.equal(chromiumMajor('Google Chrome for Testing 156.0.8078.4'), 156);
  assert.equal(chromiumMajor('Chromium 131.0.6778.85 built on Debian'), 131);
  assert.throws(() => chromiumMajor('not a browser'), /could not read a Chromium major/);
});

test('a missing browser fails with an actionable message', () => {
  assert.throws(
    () => resolveChrome({ find: () => null }),
    /no Chromium binary found; set D110_CHROME or CHROME_PATH/
  );
});

test('a browser below the tested floor fails', () => {
  assert.throws(
    () => resolveChrome({ find: () => '/usr/bin/chromium', version: () => `Chromium ${MIN_CHROMIUM_MAJOR - 1}.0.0.0` }),
    new RegExp(`older than the tested floor ${MIN_CHROMIUM_MAJOR}`)
  );
  assert.deepEqual(
    resolveChrome({ find: () => '/usr/bin/chromium', version: () => `Chromium ${MIN_CHROMIUM_MAJOR}.0.0.0` }),
    { chrome: '/usr/bin/chromium', version: `Chromium ${MIN_CHROMIUM_MAJOR}.0.0.0`, major: MIN_CHROMIUM_MAJOR }
  );
});

test('a version command that cannot run is a failure, not a fallback', () => {
  assert.throws(
    () =>
      resolveChrome({
        find: () => '/missing/chrome',
        version: () => {
          throw new Error('could not run /missing/chrome --version: ENOENT');
        },
      }),
    /could not run \/missing\/chrome --version/
  );
});

test('D110_CHROME is appended to GITHUB_ENV, and omitted without it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-github-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'github-env');
  assert.equal(writeChromeEnv('/usr/bin/chromium', file), true);
  assert.equal(await readFile(file, 'utf8'), 'D110_CHROME=/usr/bin/chromium\n');
  assert.equal(writeChromeEnv('/usr/bin/chromium', ''), false);
});

test('the CI entry point logs the resolved versions and writes the variable', () => {
  const lines = [];
  const written = [];
  const found = findChromeForCi({
    resolve: () => ({ chrome: '/usr/bin/chromium', version: 'Chromium 145.0.7632.0', major: 145 }),
    log: (line) => lines.push(line),
    write: (chrome) => written.push(chrome),
  });
  assert.equal(found.major, 145);
  assert.ok(lines.some((line) => /^chrome: Chromium 145/.test(line)), 'the Chromium version is logged');
  assert.ok(lines.some((line) => /^node: v\d+/.test(line)), 'the Node version is logged');
  assert.ok(lines.some((line) => /^jdk: /.test(line)), 'the JDK version is logged (or "not found")');
  assert.deepEqual(written, ['/usr/bin/chromium']);
});

test('the real machine resolves a browser at or above the floor', async (t) => {
  const { findChrome } = await import('../scripts/lib/chrome.mjs');
  if (!findChrome()) {
    t.skip('no Chromium on this machine; the CI path fails closed in find-chrome.test');
    return;
  }
  const found = resolveChrome();
  assert.ok(found.major >= MIN_CHROMIUM_MAJOR, `${found.version} meets the floor`);
  assert.match(found.chrome, /chrom/);
});
