/**
 * One Chromium discovery rule for every tool that needs a browser.
 *
 * The measured test harness and `scripts/build-icons.mjs` must agree on which
 * binary is available; a second per-tool search would drift. The path is
 * assembled from `homedir()` at run time, so no machine-specific absolute path
 * is committed.
 */

import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Where an installed Playwright keeps its browsers. Built at run time, never committed. */
const PLAYWRIGHT_CACHE = join(homedir(), '.cache', 'ms-playwright');

/**
 * The newest Chromium a Playwright cache holds, when one is installed.
 * @returns {string|null}
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
 * configured with the wrong browser must fail, not quietly use another one. A
 * missing binary skips the measured tests locally and fails them in CI
 * (`CI=true`), so a skip can never hide a layout regression on the pipeline.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [pathValue]
 * @returns {string|null}
 */
export function findChrome(env = process.env, pathValue = process.env.PATH ?? '') {
  const explicit = env.D110_CHROME || env.CHROME_PATH;
  if (explicit) return explicit;
  const names = ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable', 'chrome'];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
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
