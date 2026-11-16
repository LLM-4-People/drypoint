#!/usr/bin/env node
/**
 * Stage the static site GitHub Pages publishes.
 *
 * The file set is not written here: `collectFiles()` in `scripts/precache.mjs`
 * is the one owner of the runtime surface, and this script adds only what a
 * static host needs on top of it — the service worker, a redirecting 404 page
 * and the Jekyll opt-out marker. The repository root is never staged.
 *
 * Usage:
 *   node scripts/build-pages.mjs                 # build _site/
 *   node scripts/build-pages.mjs --check         # fail when _site/ differs
 *   node scripts/build-pages.mjs --out <dir>     # stage somewhere else
 */

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import brand from '../brand.json' with { type: 'json' };
import { DISTRIBUTION_FILES } from './lib/distribution.mjs';
import { OUTPUT, ROOT, SW_FILE, checkPrecache } from './precache.mjs';

export const SITE_DIR = '_site';
export const WORKER_FILE = SW_FILE;
export const PRECACHE_FILE = OUTPUT;
export const NOT_FOUND_FILE = '404.html';
export const NO_JEKYLL_FILE = '.nojekyll';

/**
 * Files on top of the runtime surface; never a second runtime list.
 *
 * The worker and its imported manifest are not part of `collectFiles()` — a
 * manifest cannot carry its own digest, and the worker is what loads it — so
 * they are named here from the precache owner's own constants. Omitting either
 * ships a worker that cannot install.
 */
export const SITE_ONLY_FILES = Object.freeze([WORKER_FILE, PRECACHE_FILE, NOT_FOUND_FILE, NO_JEKYLL_FILE]);

/**
 * The staged copy of each site-only file. The list above is the file set; this
 * map owns only how each one is produced, so adding a file to the list without
 * a producer is a loud staging failure rather than a silently omitted file.
 */
const SITE_ONLY_CONTENT = Object.freeze({
  [WORKER_FILE]: null,
  [PRECACHE_FILE]: null,
  [NOT_FOUND_FILE]: (basePath) => notFoundPage(basePath),
  [NO_JEKYLL_FILE]: '',
});

/**
 * The path a Pages deployment is served from, derived from the one authored
 * homepage. `https://llm-4-people.github.io/drypoint/` → `/drypoint/`.
 *
 * A 404 document keeps the URL that missed, so `./` inside it would resolve
 * against the broken path; the generated page carries this value in a `<base>`
 * element so its relative redirect still lands on the app root.
 *
 * @param {string} homepage absolute site URL
 * @returns {string} a root-relative path that starts and ends with `/`
 */
export function pagesBasePath(homepage = brand.homepage) {
  let url;
  try {
    url = new URL(homepage);
  } catch {
    throw new Error(`homepage must be an absolute http(s) URL: ${homepage}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`homepage must be an absolute http(s) URL: ${homepage}`);
  return `${url.pathname.replace(/\/+$/, '')}/`;
}

/**
 * The generated 404 page: redirect to the app root and keep the fragment,
 * which a redirect would otherwise drop because the browser never sends it.
 *
 * @param {string} basePath root-relative site path
 * @returns {string}
 */
export function notFoundPage(basePath = pagesBasePath()) {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found</title>
<base href="${base}">
<meta http-equiv="refresh" content="0; url=${base}">
<script>
  // The fragment never reaches the server, so the redirect carries it over.
  location.replace('./' + location.hash);
</script>
</head>
<body>
<p>This page does not exist. <a href="./">Open the app</a>.</p>
</body>
</html>
`;
}

/**
 * The exact set of files a deployment contains, as `{ path, content }` where a
 * `null` content means "copy the file of that name from the repository".
 *
 * The licence and the third-party notices come from the one distribution list
 * the APK build also reads; they are not runtime files and never enter the
 * precache manifest.
 *
 * @param {string[]} runtimeFiles the generated precache list
 * @param {{basePath?: string}} [options]
 * @returns {{path: string, content: string|null}[]} sorted by path
 */
export function siteEntries(runtimeFiles, { basePath = pagesBasePath() } = {}) {
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length === 0) {
    throw new Error('the runtime file list is empty; run: npm run build');
  }
  const entries = new Map();
  for (const path of runtimeFiles) entries.set(path, { path, content: null });
  for (const path of SITE_ONLY_FILES) {
    if (!Object.prototype.hasOwnProperty.call(SITE_ONLY_CONTENT, path)) {
      throw new Error(`no staging producer for site-only file ${path}`);
    }
    const content = SITE_ONLY_CONTENT[path];
    entries.set(path, { path, content: typeof content === 'function' ? content(basePath) : content });
  }
  for (const path of DISTRIBUTION_FILES) entries.set(path, { path, content: null });
  // Codepoint order, like every other sorted list in the repository: a locale
  // must never decide whether two builds produce the same tree.
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The generated files must be current before anything is staged. */
export async function assertPrecacheFresh() {
  const result = await checkPrecache();
  if (!result.ok) {
    throw new Error('the generated precache manifest or worker stamp is stale — run: npm run build');
  }
  return result;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Stage a deployment tree.
 *
 * @param {{out?: string, basePath?: string, checkFresh?: () => Promise<object>}} [options]
 * @returns {Promise<{out: string, entries: {path: string, content: string|null}[], version: string}>}
 */
export async function buildPages({ out = join(ROOT, SITE_DIR), basePath = pagesBasePath(), checkFresh = assertPrecacheFresh } = {}) {
  const fresh = await checkFresh();
  const entries = siteEntries(fresh.files, { basePath });
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const entry of entries) {
    const to = join(out, entry.path);
    await mkdir(dirname(to), { recursive: true });
    if (entry.content === null) await cp(join(ROOT, entry.path), to);
    else await writeFile(to, entry.content);
  }
  return { out, entries, version: fresh.version };
}

/** Every file under a directory, repo-style relative paths. */
async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(join(directory, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

/**
 * Compare a staged tree with what the current sources would produce.
 *
 * @param {{out?: string, basePath?: string, checkFresh?: () => Promise<object>}} [options]
 * @returns {Promise<{findings: string[], expected: number, actual: number}>}
 */
export async function checkSite({ out = join(ROOT, SITE_DIR), basePath = pagesBasePath(), checkFresh = assertPrecacheFresh } = {}) {
  const fresh = await checkFresh();
  const expected = new Map();
  for (const entry of siteEntries(fresh.files, { basePath })) {
    const bytes = entry.content === null ? await readFile(join(ROOT, entry.path)) : Buffer.from(entry.content);
    expected.set(entry.path, digest(bytes));
  }
  const actual = new Map();
  for (const path of await walk(out)) actual.set(path, digest(await readFile(join(out, path))));

  const findings = [];
  for (const [path, hash] of expected) {
    if (!actual.has(path)) findings.push(`${path}: missing from the staged site`);
    else if (actual.get(path) !== hash) findings.push(`${path}: staged bytes differ from the source`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) findings.push(`${path}: staged file is not part of the site`);
  }
  return { findings, expected: expected.size, actual: actual.size };
}

function parseArguments(argv) {
  const options = { check: false, out: join(ROOT, SITE_DIR) };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--out') {
      const value = argv[++index];
      if (!value) throw new Error('--out needs a directory');
      options.out = resolve(value);
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`pages: ${error.message}`);
    console.error('usage: node scripts/build-pages.mjs [--check] [--out <dir>]');
    return 2;
  }
  const label = relative(ROOT, options.out).split(sep).join('/') || options.out;
  try {
    if (options.check) {
      const { findings, expected, actual } = await checkSite({ out: options.out, basePath: pagesBasePath() });
      if (!findings.length) {
        console.log(`pages: ${expected} files in ${label} match the sources`);
        return 0;
      }
      for (const finding of findings) console.error(`${label}: ${finding}`);
      console.error(`pages: ${findings.length} difference(s) between ${label} (${actual} files) and the sources (${expected} files)`);
      return 1;
    }
    const { entries, version } = await buildPages({ out: options.out, basePath: pagesBasePath() });
    console.log(`pages: staged ${entries.length} files in ${label} (precache ${version})`);
    return 0;
  } catch (error) {
    console.error(`pages: ${error.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`pages: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
