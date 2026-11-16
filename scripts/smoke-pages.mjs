#!/usr/bin/env node
/**
 * Smoke-test a Pages deployment: the document root and every file the service
 * worker precaches, each bounded-retried until it answers 200.
 *
 * The file list comes from `assets/precache.js` — the generated manifest the
 * worker itself installs — so a deployment that forgets one file fails here
 * instead of failing on a user's phone. Four hand-picked URLs used to be
 * enough to pass while the list grew to sixty-four.
 *
 * Usage:
 *   node scripts/smoke-pages.mjs --base https://host/drypoint/ [--cache-bust <id>]
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { DISTRIBUTION_FILES } from './lib/distribution.mjs';
import { contentTypeEssence, contentTypeProblem } from './lib/content-types.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PRECACHE_FILE = 'assets/precache.js';

/** The document root. A deployment is only alive if this answers. */
export const ROOT_PATH = '/';

/**
 * Files a Pages deployment must serve that the precache manifest cannot name.
 *
 * `sw.js` is registered from the document, not precached by itself;
 * `assets/precache.js` is the manifest the worker imports; `404.html` is the
 * host's static fallback and is never part of a successful navigation. They
 * ride beside the app, so a deployment can lose one and still pass the
 * precache list. This is a different distribution from `DISTRIBUTION_FILES`,
 * which is the licence/notices list every artifact carries.
 *
 * `.nojekyll` is deliberately absent: it is an empty host control marker, not
 * app content, and a 200 for it proves nothing about the deployment.
 */
export const SITE_ONLY_FILES = Object.freeze(['sw.js', 'assets/precache.js', '404.html']);

/**
 * The one file whose content type is part of the contract: a manifest served as
 * text/plain is not installable, and a host that rewrites it is not serving the
 * app the worker expects.
 */
export const MANIFEST_PATH = '/manifest.webmanifest';
export const MANIFEST_TYPE = 'application/manifest+json';

/** Every URL a deployment must answer, sorted, duplicates removed. */
export async function smokePaths({ root = ROOT } = {}) {
  const source = await readFile(join(root, PRECACHE_FILE), 'utf8');
  const sandbox = { self: {} };
  vm.runInNewContext(source, sandbox, { filename: PRECACHE_FILE });
  const files = sandbox.self?.__PRECACHE?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error(`${PRECACHE_FILE} has no file list`);
  const paths = new Set([ROOT_PATH]);
  for (const file of files) paths.add(file.startsWith('/') ? file : `/${file}`);
  for (const file of SITE_ONLY_FILES) paths.add(`/${file}`);
  // The licence and notices ride beside the app, not inside the precache
  // manifest, but a deployment that forgets them is incomplete. One list owns
  // both distributions.
  for (const file of DISTRIBUTION_FILES) paths.add(`/${file}`);
  return [...paths].sort();
}

/**
 * GET for documents where the response body is the thing being checked, HEAD
 * for binary assets where only the status matters. A host may serve HEAD for a
 * notice without the body a reader would receive.
 * @param {string} path
 * @returns {'GET'|'HEAD'}
 */
export function probeMethod(path) {
  const noticePath = DISTRIBUTION_FILES.some((file) => path === `/${file}`);
  const siteFile = SITE_ONLY_FILES.some((file) => path === `/${file}`);
  // The manifest, the notices and the deployment-only JS/HTML are read for
  // their body or their type; a binary asset only has to answer.
  return path === MANIFEST_PATH || noticePath || siteFile ? 'GET' : 'HEAD';
}

/** Why a Content-Type cannot be the manifest, or null. */
export function manifestTypeProblem(contentType) {
  const essence = contentTypeEssence(contentType);
  if (!essence) return 'the response has no content type';
  return essence === MANIFEST_TYPE ? null : `the manifest is served as "${essence}", not ${MANIFEST_TYPE}`;
}

/**
 * The one deployment check: fetch every required URL and refuse a response
 * whose content type contradicts the file, through the same decision the
 * worker applies to a precache fetch. The manifest keeps its stricter
 * installability rule on top.
 *
 * @param {string} base absolute deployment URL
 * @param {object} [options]
 * @returns {Promise<Array<{path: string, status: number}>>} the probed URLs
 */
export async function checkDeployment(base, { paths, query = '', attempts, delayMs, fetchImpl } = {}) {
  const urls = paths ?? (await smokePaths());
  const results = [];
  for (const path of urls) {
    const options = {};
    if (attempts !== undefined) options.attempts = attempts;
    if (delayMs !== undefined) options.delayMs = delayMs;
    if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
    const result = await probe(base, path, { ...options, query });
    if (path === MANIFEST_PATH) {
      const problem = manifestTypeProblem(result.contentType);
      if (problem) throw new Error(`${problem} (${base.replace(/\/+$/, '')}${path})`);
    } else {
      const problem = contentTypeProblem(path, result.contentType);
      if (problem) throw new Error(`${path}: ${problem} (${base.replace(/\/+$/, '')}${path})`);
    }
    results.push({ path, status: result.status });
  }
  return results;
}

/**
 * Fetch one path until it answers 200, or give up after the bounded attempts.
 *
 * The Pages CDN can answer a previous build for a few seconds after a
 * deployment, so a single 404 is not a failure yet; twelve attempts is.
 *
 * @returns {Promise<{path: string, status: number, contentType: string|null, contentLength: number|null}>}
 */
export async function probe(
  base,
  path,
  {
    attempts = 12,
    delayMs = 5000,
    query = '',
    method = probeMethod(path),
    fetchImpl = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {}
) {
  const url = `${base.replace(/\/+$/, '')}${path}${query}`;
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { method, cache: 'no-store' });
      const contentType = response.headers?.get?.('content-type') ?? null;
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (response.status === 200) {
        return { path, status: 200, contentType, contentLength: Number.isFinite(contentLength) ? contentLength : null };
      }
      last = `answered ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`${url} never answered 200 (${last} after ${attempts} attempts)`);
}

function parseArguments(argv) {
  const options = { base: '', cacheBust: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--base') options.base = argv[++index] ?? '';
    else if (argument === '--cache-bust') options.cacheBust = argv[++index] ?? '';
    else throw new Error(`unknown option ${argument}`);
  }
  if (!/^https?:\/\//.test(options.base)) throw new Error('--base must be the absolute deployment URL');
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`smoke: ${error.message}`);
    console.error('usage: node scripts/smoke-pages.mjs --base https://host/path/ [--cache-bust <id>]');
    return 2;
  }
  try {
    const paths = await smokePaths();
    // One cache-busting query for every URL: the CDN can answer the previous
    // build's copy of a file that changed in this deployment.
    const query = options.cacheBust ? `?smoke=${encodeURIComponent(options.cacheBust)}` : '';
    const results = await checkDeployment(options.base, { paths, query });
    for (const result of results) {
      console.log(`200 ${options.base.replace(/\/+$/, '')}${result.path}${query ? ` ${query}` : ''}`);
    }
    console.log(`smoke: ${results.length} URLs answered 200`);
    return 0;
  } catch (error) {
    console.error(`smoke: ${error.message}`);
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
      console.error(`smoke: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
