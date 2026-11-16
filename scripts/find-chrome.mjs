#!/usr/bin/env node
/**
 * The one CI entry point for Chromium discovery.
 *
 * `scripts/lib/chrome.mjs` owns the search (explicit variables, PATH names and
 * the Playwright cache); this wrapper adds the policy CI needs: a missing
 * browser is a failure, a browser older than the tested major floor is a
 * failure, and the resolved versions are written to the run log. Both
 * workflows call it, so the two `command -v` copies cannot drift.
 *
 * It writes D110_CHROME to GITHUB_ENV when that file is available, which makes
 * the browser visible to every later step without an `export`.
 *
 * Usage:
 *   node scripts/find-chrome.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from './lib/chrome.mjs';

/**
 * The oldest Chromium major the measured suites are tested against. The CI
 * image and the Playwright cache are newer; a drop below this floor is a
 * runner change that must be seen, not a reason to skip a layout suite.
 */
export const MIN_CHROMIUM_MAJOR = 131;

/**
 * Read the major from `chrome --version` output.
 *
 * @param {string} output e.g. "Google Chrome for Testing 156.0.8078.4"
 * @returns {number}
 */
export function chromiumMajor(output) {
  const match = /\b(\d+)\.\d+\.\d+/.exec(String(output));
  if (!match) throw new Error(`could not read a Chromium major from ${JSON.stringify(String(output).trim())}`);
  return Number(match[1]);
}

function chromeVersion(chrome) {
  try {
    return execFileSync(chrome, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error.message;
    throw new Error(`could not run ${chrome} --version: ${detail.split('\n')[0]}`);
  }
}

function jdkVersion() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) return 'not found';
  const line = `${result.stderr ?? ''}${result.stdout ?? ''}`
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? 'not found';
}

/**
 * Resolve and validate the browser. The finder and version reader are
 * injectable so the failure paths are testable without a browser.
 *
 * @param {{env?: Record<string,string|undefined>, pathValue?: string, find?: Function, version?: Function}} [options]
 * @returns {{chrome: string, version: string, major: number}}
 */
export function resolveChrome({
  env = process.env,
  pathValue = process.env.PATH ?? '',
  find = findChrome,
  version = chromeVersion,
} = {}) {
  const chrome = find(env, pathValue);
  if (!chrome) {
    throw new Error('no Chromium binary found; set D110_CHROME or CHROME_PATH, or install google-chrome/chromium');
  }
  const text = String(version(chrome)).trim();
  const major = chromiumMajor(text);
  if (major < MIN_CHROMIUM_MAJOR) {
    throw new Error(`Chromium ${major} is older than the tested floor ${MIN_CHROMIUM_MAJOR}: ${chrome}`);
  }
  return { chrome, version: text, major };
}

/**
 * Make the browser visible to later steps.
 *
 * @param {string} chrome
 * @param {string|undefined} [envFile]
 * @returns {boolean} whether a file was written
 */
export function writeChromeEnv(chrome, envFile = process.env.GITHUB_ENV) {
  if (!envFile) return false;
  appendFileSync(envFile, `D110_CHROME=${chrome}\n`);
  return true;
}

/**
 * @param {{resolve?: Function, log?: (line: string) => void, write?: Function}} [options]
 * @returns {{chrome: string, version: string, major: number}}
 */
export function findChromeForCi({ resolve: resolveFn = resolveChrome, log = console.log, write = writeChromeEnv } = {}) {
  const found = resolveFn();
  log(`chrome: ${found.version} (${found.chrome})`);
  log(`node: ${process.version}`);
  log(`jdk: ${jdkVersion()}`);
  write(found.chrome);
  console.log(`D110_CHROME=${found.chrome}`);
  return found;
}

function main() {
  try {
    findChromeForCi();
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
