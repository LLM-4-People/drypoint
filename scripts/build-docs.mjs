#!/usr/bin/env node
/**
 * Generate the documentation facts that would otherwise drift.
 *
 * Prose stays authored. The repeated, mechanical facts are rendered from their
 * owners into marker-delimited blocks:
 *
 *   README.md       <!-- generated:scripts -->  from package.json
 *   CONTRIBUTING.md <!-- generated:suites -->   from scripts/test-suites.mjs
 *
 * `--check` fails when a block is stale or missing; `--write` regenerates it.
 * The markers are ordinary HTML comments, so GitHub renders the document
 * without showing the bookkeeping.
 *
 * Usage:
 *   node scripts/build-docs.mjs --check
 *   node scripts/build-docs.mjs --write
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { browserSuite } from './test-suites.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
export const PACKAGE_FILE = 'package.json';
export const README_FILE = 'README.md';
export const CONTRIBUTING_FILE = 'CONTRIBUTING.md';

const NPM_BUILT_INS = new Set(['start', 'stop', 'test']);

/** The exact invocation a contributor types for one package.json script. */
export function npmInvocation(name) {
  return NPM_BUILT_INS.has(name) ? `npm ${name}` : `npm run ${name}`;
}

/** The generated npm-script table, without its markers. */
export function renderScriptsBlock(scripts) {
  const rows = Object.entries(scripts).map(
    ([name, command]) => `| \`${npmInvocation(name)}\` | \`${String(command).replaceAll('|', '\\|')}\` |`
  );
  return ['| Command | Runs |', '| --- | --- |', ...rows].join('\n');
}

/** The generated browser-suite list and counts, without its markers. */
export function renderSuitesBlock(suite) {
  const noun = suite.tests === 1 ? 'test' : 'tests';
  const fileNoun = suite.files.length === 1 ? 'file' : 'files';
  const lines = [`The browser leg runs **${suite.tests} ${noun} in ${suite.files.length} ${fileNoun}**:`, ''];
  for (const entry of suite.files) {
    const testNoun = entry.tests === 1 ? 'test' : 'tests';
    lines.push(`- \`${entry.file}\` (${entry.tests} ${testNoun})`);
  }
  return lines.join('\n');
}

/** The one marker pair for a named block. */
export function markers(name) {
  return {
    start: `<!-- generated:${name} -->`,
    end: `<!-- /generated:${name} -->`,
  };
}

/**
 * Replace one marker block's contents, requiring exactly one pair. A missing
 * or duplicated marker is an error: silently appending a second block would
 * let the stale copy keep rendering.
 *
 * @param {string} markdown
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
export function replaceGeneratedBlock(markdown, name, content) {
  const { start, end } = markers(name);
  const text = String(markdown);
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt < 0 || endAt < 0) throw new Error(`${name}: missing generated marker`);
  if (startAt !== text.lastIndexOf(start) || endAt !== text.lastIndexOf(end)) {
    throw new Error(`${name}: exactly one generated marker pair is required`);
  }
  if (endAt < startAt) throw new Error(`${name}: generated markers are out of order`);
  return `${text.slice(0, startAt + start.length)}\n${content.trim()}\n${text.slice(endAt)}`;
}

/**
 * Render both documents from their owners.
 *
 * @param {{root?: string}} [options]
 * @returns {Promise<{files: Record<string,string>, scripts: object, suite: object}>}
 */
export async function buildDocs({ root = ROOT } = {}) {
  const [packageText, readme, contributing] = await Promise.all([
    readFile(join(root, PACKAGE_FILE), 'utf8'),
    readFile(join(root, README_FILE), 'utf8'),
    readFile(join(root, CONTRIBUTING_FILE), 'utf8'),
  ]);
  const scripts = JSON.parse(packageText).scripts ?? {};
  const suite = browserSuite();
  return {
    files: {
      [README_FILE]: replaceGeneratedBlock(readme, 'scripts', renderScriptsBlock(scripts)),
      [CONTRIBUTING_FILE]: replaceGeneratedBlock(contributing, 'suites', renderSuitesBlock(suite)),
    },
    scripts,
    suite,
  };
}

/** Compare both generated documents with the tree. */
export async function checkDocs({ root = ROOT } = {}) {
  const built = await buildDocs({ root });
  const stale = [];
  for (const [file, content] of Object.entries(built.files)) {
    const actual = await readFile(join(root, file), 'utf8');
    if (actual !== content) stale.push(file);
  }
  return { ...built, ok: stale.length === 0, stale };
}

/** Write both generated documents atomically. */
export async function writeDocs({ root = ROOT } = {}) {
  const built = await buildDocs({ root });
  for (const [file, content] of Object.entries(built.files)) {
    const target = join(root, file);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, target);
  }
  return built;
}

async function main(argv) {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--check' && flag !== '--write');
  if (unknown.length) {
    console.error(`docs: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/build-docs.mjs [--check|--write]');
    return 2;
  }
  const write = flags.includes('--write');
  if (write) {
    const result = await writeDocs();
    console.log(`docs: wrote ${Object.keys(result.files).join(', ')}`);
    return 0;
  }
  const result = await checkDocs();
  if (result.ok) {
    console.log('docs: generated blocks up to date');
    return 0;
  }
  console.error(`docs: stale generated block(s): ${result.stale.join(', ')} — run: npm run docs:generate`);
  return 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`docs: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
