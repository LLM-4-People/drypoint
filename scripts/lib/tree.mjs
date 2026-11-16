/**
 * The published tree: one gitignore-aware walker shared by the repository gates.
 *
 * `scripts/check-privacy.mjs` scans the files this returns, and
 * `scripts/check-docs.mjs` reads its Markdown. One walker means the two gates
 * cannot disagree about which files the repository publishes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const IGNORE_FILE = '.gitignore';

/**
 * Directories no published tree contains, independent of `.gitignore`. They
 * are listed separately so a gate cannot be widened by accident: ignoring a
 * build directory in git must not stop a scan of it.
 */
export const ALWAYS_SKIP = Object.freeze(['.git', 'node_modules', '.run', '_site', 'android/build']);

/** Escape one literal character for a regular expression. */
function escapeLiteral(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a gitignore glob into a regular expression body.
 *
 * Supported (and only these): `*`, `?`, `**` and literal characters. A pattern
 * that uses any other metacharacter is rejected by `parseIgnore` rather than
 * being read as something it is not.
 */
export function globBody(pattern) {
  let body = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          body += '(?:.*/)?';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
    } else if (character === '?') {
      body += '[^/]';
    } else {
      body += escapeLiteral(character);
    }
  }
  return body;
}

/**
 * Parse `.gitignore` into ordered rules.
 *
 * A rule matches a file when it matches the file's own path or one of its
 * parent directories, which is what makes `android/build/` exclude everything
 * beneath it. The last matching rule wins, so `!` re-inclusion works.
 *
 * @param {string} text
 * @returns {{pattern: string, regex: RegExp, directoryOnly: boolean, negated: boolean}[]}
 */
export function parseIgnore(text) {
  const rules = [];
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/[[\]]/.test(line)) {
      throw new Error(`${IGNORE_FILE}:${index + 1}: unsupported character class in ${JSON.stringify(line)}`);
    }
    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.replace(/\/+$/, '');
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.replace(/^\/+/, '');
    if (!pattern) throw new Error(`${IGNORE_FILE}:${index + 1}: empty pattern`);
    const body = globBody(pattern);
    const prefix = anchored || pattern.includes('/') ? '^' : '(?:^|.*/)';
    rules.push({ pattern: line, regex: new RegExp(`${prefix}${body}$`), directoryOnly, negated });
  }
  return rules;
}

/** Whether one rule matches one path (a file or a parent directory). */
export function matchesRule(rule, path) {
  return rule.regex.test(path);
}

/**
 * Whether a repo-relative POSIX path is ignored.
 *
 * @param {string} path
 * @param {{pattern: string, regex: RegExp, directoryOnly: boolean, negated: boolean}[]} rules
 * @returns {boolean}
 */
export function isIgnored(path, rules) {
  const segments = path.split('/');
  const candidates = [];
  for (let index = 1; index < segments.length; index++) {
    candidates.push({ path: segments.slice(0, index).join('/'), directory: true });
  }
  candidates.push({ path, directory: false });
  let ignored = false;
  for (const rule of rules) {
    const hit = candidates.some((candidate) => {
      if (rule.directoryOnly && !candidate.directory) return false;
      return matchesRule(rule, candidate.path);
    });
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

/** Whether a buffer looks like text. A NUL byte in the first block says no. */
export function isTextBuffer(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

function isSkipped(path) {
  return ALWAYS_SKIP.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Read and parse the root `.gitignore`; a missing file means "no rules". */
export async function readIgnoreRules(root = ROOT) {
  const text = await readFile(join(root, IGNORE_FILE), 'utf8').catch(() => '');
  return parseIgnore(text);
}

/**
 * Every repo-relative file that would be published.
 *
 * @param {{root?: string, rules?: object[]}} [options]
 * @returns {Promise<string[]>} sorted POSIX paths
 */
export async function listFiles({ root = ROOT, rules } = {}) {
  const ignore = rules ?? (await readIgnoreRules(root));
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (isSkipped(path)) continue;
      if (isIgnored(path, ignore)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk('');
  return files.sort();
}
