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

/** Count the top-level `test(...)` declarations in one suite file. */
export function testCountOf(file, directory = join(ROOT, 'test')) {
  const source = readFileSync(join(directory, file), 'utf8');
  return (source.match(/^test\(/gm) ?? []).length;
}

/**
 * The browser files and their declared test count. `--list` and the generated
 * CONTRIBUTING block read this one summary; neither keeps a second list.
 */
export function browserSuite(directory = join(ROOT, 'test')) {
  const { browser } = partitionTests(directory);
  const files = browser.map((file) => ({ file, tests: testCountOf(file, directory) }));
  return { files, tests: files.reduce((total, entry) => total + entry.tests, 0) };
}

/**
 * How many browser test files Node runs at once. Chromium is the expensive
 * resource; five parallel browsers on a two-core CI runner caused start-up
 * timeouts and flaky measured values. Unit tests keep Node's own default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function browserConcurrency(env = process.env) {
  const raw = env.D110_BROWSER_CONCURRENCY;
  if (raw === undefined || raw === '') return 2;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('D110_BROWSER_CONCURRENCY must be a positive integer');
  }
  return value;
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
    const { unit } = partitionTests();
    const suite = browserSuite();
    console.log(`unit (${unit.length}): ${unit.join(' ')}`);
    console.log(
      `browser (${suite.files.length} files, ${suite.tests} tests): ` +
        suite.files.map((entry) => `${entry.file} (${entry.tests})`).join(' ')
    );
    return 0;
  }
  let paths;
  let concurrency;
  try {
    paths = testPaths(kind);
    if (kind === 'browser') concurrency = browserConcurrency();
  } catch (error) {
    console.error(`tests: ${error.message}`);
    return 2;
  }
  const args = ['--test'];
  if (concurrency) args.push(`--test-concurrency=${concurrency}`);
  args.push(...paths.map((path) => join('test', path)));
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return result.status ?? 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
