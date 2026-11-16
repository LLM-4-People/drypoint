#!/usr/bin/env node
/**
 * Split the test suite at its real boundary.
 *
 * A test file that imports `helpers/browser-page.mjs` needs Chromium; every
 * other file runs on Node alone. The import itself is the classification, so
 * there is no second list to keep current — a new browser test is partitioned
 * the moment it uses the shared page harness.
 *
 * Usage:
 *   node scripts/test-suites.mjs unit      # no Chromium
 *   node scripts/test-suites.mjs browser   # measured layout suites
 *   node scripts/test-suites.mjs all       # both
 *   node scripts/test-suites.mjs --list    # print the partition
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * A real import statement, not a mention in a comment, a fixture string or a
 * child-process argument. `ci-required` spawns the harness and `test-suites`
 * plants a fake one; neither needs Chromium itself.
 */
const BROWSER_IMPORT = /^\s*import\s[^;]*?from\s+['"][^'"]*helpers\/browser-page\.mjs['"]/m;

/**
 * @param {string} [directory]
 * @returns {{unit: string[], browser: string[], all: string[]}} repository-relative paths
 */
export function partitionTests(directory = join(ROOT, 'test')) {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  const browser = names.filter((name) => BROWSER_IMPORT.test(readFileSync(join(directory, name), 'utf8')));
  const unit = names.filter((name) => !browser.includes(name));
  return { unit, browser, all: names };
}

/** @param {'unit'|'browser'|'all'} kind */
export function testPaths(kind) {
  const { unit, browser, all } = partitionTests();
  if (unit.length === 0 || browser.length === 0) {
    throw new Error('the test partition is empty; check the browser harness import in test/');
  }
  if (kind === 'unit') return unit;
  if (kind === 'browser') return browser;
  if (kind === 'all') return all;
  throw new Error(`unknown suite "${kind}"; expected unit, browser or all`);
}

function main(argv) {
  const kind = argv[0];
  if (kind === '--list') {
    const { unit, browser } = partitionTests();
    console.log(`unit (${unit.length}): ${unit.join(' ')}`);
    console.log(`browser (${browser.length}): ${browser.join(' ')}`);
    return 0;
  }
  let paths;
  try {
    paths = testPaths(kind);
  } catch (error) {
    console.error(`tests: ${error.message}`);
    return 2;
  }
  const result = spawnSync(process.execPath, ['--test', ...paths.map((path) => join('test', path))], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
