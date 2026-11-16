/**
 * The test partition is derived from the browser harness import, not from a
 * hand-kept list. These tests prove the split covers every file exactly once
 * and that a new browser test cannot be forgotten in the web matrix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { partitionTests, testPaths } from '../scripts/test-suites.mjs';

test('every test file is in exactly one suite', () => {
  const { unit, browser, all } = partitionTests();
  assert.ok(all.length > 0, 'the suite is not empty');
  assert.ok(browser.length > 0, 'the layout suites are classified');
  assert.equal(unit.length + browser.length, all.length, 'no file is duplicated or dropped');
  for (const file of unit) assert.equal(browser.includes(file), false, `${file} is unit-only`);
  for (const file of browser) assert.equal(unit.includes(file), false, `${file} is browser-only`);
});

test('the browser suite is exactly the files that import the page harness', () => {
  const { browser } = partitionTests();
  assert.deepEqual(
    browser.filter((file) => !file.endsWith('.test.mjs')),
    [],
    'only test files are classified'
  );
  assert.equal(new Set(browser).size, browser.length);
  for (const name of ['actionbar-clearance', 'content-security', 'layout-edges', 'stage-hint', 'toast-overlay']) {
    assert.ok(browser.includes(`${name}.test.mjs`), `${name} needs Chromium and belongs to the browser suite`);
  }
});

test('testPaths refuses an unknown suite and keeps unit free of Chromium', () => {
  assert.throws(() => testPaths('nope'), /unknown suite/);
  const unit = testPaths('unit');
  for (const file of unit) assert.equal(file.includes('browser'), false, `${file} does not need Chromium`);
});

test('a planted browser test is classified without editing a list', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-suites-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'one.test.mjs'), "import test from 'node:test';\n");
  await writeFile(join(directory, 'two.test.mjs'), "import { withPage } from './helpers/browser-page.mjs';\n");
  const { unit, browser } = partitionTests(directory);
  assert.deepEqual(unit, ['one.test.mjs']);
  assert.deepEqual(browser, ['two.test.mjs']);
});
