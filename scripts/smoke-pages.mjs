#!/usr/bin/env node
/**
 * Smoke-test a Pages deployment: the document root and every file the service
 * worker precaches, each bounded-retried until it answers 200.
 *
 * The file list comes from `assets/precache.js` (the generated manifest the
 * worker itself installs), so a deployment that forgets one file fails here
 * instead of failing on a user's phone. Four hand-picked URLs used to be
 * enough to pass while the list grew to sixty-four.
 *
 * Usage:
 *   node scripts/smoke-pages.mjs --base https://host/ [--cache-bust <id>]
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISTRIBUTION_FILES } from './lib/distribution.mjs';
import { contentTypeEssence, contentTypeProblem } from './lib/content-types.mjs';
import { OUTPUT, parseManifest, readManifest } from './precache.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PRECACHE_FILE = OUTPUT;

/** The document root. A deployment is only alive if this answers. */
export const ROOT_PATH = '/';

/**
 * Files a Pages deployment must serve that the precache manifest cannot name.
 *
 * `sw.js` is registered from the document, not precached by itself;
 * `assets/precache.js` is the manifest the worker imports; `404.html` is the
 * host's static fallback and is never part of a successful navigation; and
 * `CNAME` keeps the custom domain bound to this deployment. They ride beside
 * the app, so a deployment can lose one and still pass the precache list. This
 * is a different distribution from `DISTRIBUTION_FILES`, which is the
 * licence/notices list every artifact carries.
 *
 * `.nojekyll` is deliberately absent: it is an empty host control marker, not
 * app content, and a 200 for it proves nothing about the deployment.
 */
export const SITE_ONLY_FILES = Object.freeze(['sw.js', 'assets/precache.js', '404.html', 'CNAME']);

/**
 * The one file whose content type is part of the contract: a manifest served as
 * text/plain is not installable, and a host that rewrites it is not serving the
 * app the worker expects.
 */
export const MANIFEST_PATH = '/manifest.webmanifest';
export const MANIFEST_TYPE = 'application/manifest+json';

/** The build stamp the worker installs with. */
export function workerBuild(source) {
  const match = /const BUILD = '([0-9a-f]+)';/.exec(String(source));
  if (!match) throw new Error('sw.js has no BUILD stamp');
  return match[1];
}

/** Every URL a deployment must answer, sorted, duplicates removed. */
export async function smokePaths({ root = ROOT } = {}) {
  const manifest = await readManifest(root);
  const files = manifest.files;
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

/** One GET against the deployment, with a redirect refused at the boundary. */
async function deployedResponse(base, path, { query = '', fetchImpl = fetch } = {}) {
  const url = `${base.replace(/\/+$/, '')}${path}${query}`;
  const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.('location') ?? '';
    throw new Error(`${url} redirected${location ? ` to ${location}` : ''}; a deployment must serve the file at its own path`);
  }
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function deployedText(base, path, options) {
  return (await deployedResponse(base, path, options)).text();
}

async function deployedBytes(base, path, options) {
  return Buffer.from(await (await deployedResponse(base, path, options)).arrayBuffer());
}

/**
 * Prove the deployment is this build, not only a set of URLs that answer:
 * the deployed manifest and worker stamp must agree (and, when known, the
 * checkout's version), and every precached byte must match its manifest
 * digest. A same-path redirect or a torn/rewritten file fails here even when
 * the status and content type look right.
 */
export async function verifyDeployment(base, { expectedVersion = null, query = '', fetchImpl = fetch } = {}) {
  const manifest = parseManifest(
    await deployedText(base, `/${PRECACHE_FILE}`, { query, fetchImpl }),
    `${base.replace(/\/+$/, '')}/${PRECACHE_FILE}`
  );
  const build = workerBuild(await deployedText(base, '/sw.js', { query, fetchImpl }));
  if (manifest.version !== build) {
    throw new Error(`the deployed worker BUILD ${build} does not match the manifest version ${manifest.version}`);
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`the deployed manifest version ${manifest.version} is not this build's ${expectedVersion}`);
  }
  for (const file of manifest.files) {
    const path = file.startsWith('/') ? file : `/${file}`;
    const body = await deployedBytes(base, path, { query, fetchImpl });
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== manifest.digests[file]) {
      throw new Error(`${path}: deployed content ${digest} does not match the manifest digest ${manifest.digests[file]}`);
    }
  }
  return { version: manifest.version, files: manifest.files.length };
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
export async function checkDeployment(
  base,
  { paths, query = '', attempts, delayMs, fetchImpl, expectedVersion = null, verify = true } = {}
) {
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
  if (verify) await verifyDeployment(base, { expectedVersion, query, fetchImpl });
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
      const response = await fetchImpl(url, { method, cache: 'no-store', redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        // A redirect is deterministic, not a CDN lag: the file must exist at
        // its own path. Retrying would only hide the rewrite.
        const location = response.headers?.get?.('location') ?? '';
        const error = new Error(`${url} redirected${location ? ` to ${location}` : ''}; a deployment must serve the file at its own path`);
        error.name = 'DeploymentRedirectError';
        throw error;
      }
      const contentType = response.headers?.get?.('content-type') ?? null;
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (response.status === 200) {
        return { path, status: 200, contentType, contentLength: Number.isFinite(contentLength) ? contentLength : null };
      }
      last = `answered ${response.status}`;
    } catch (error) {
      if (error.name === 'DeploymentRedirectError') throw error;
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
    const local = await readManifest(ROOT);
    const paths = await smokePaths();
    // One cache-busting query for every URL: the CDN can answer the previous
    // build's copy of a file that changed in this deployment.
    const query = options.cacheBust ? `?smoke=${encodeURIComponent(options.cacheBust)}` : '';
    const results = await checkDeployment(options.base, { paths, query, expectedVersion: local.version });
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
