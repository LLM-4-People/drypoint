#!/usr/bin/env node
/**
 * Privacy gate: nothing that identifies a person, a machine or the reference
 * device may reach the public tree.
 *
 * One deny list, one allowlist, one shared file walker. The walker applies
 * `.gitignore` (so the keystore, `.run` and build output are excluded for the
 * same reason git excludes them) and refuses ignore syntax it does not
 * understand, so a future `.gitignore` edit cannot silently widen what this
 * gate does not see. The trusted CI scan passes `--tracked`: it scans what git
 * actually publishes, so a candidate cannot hide a force-added file behind the
 * candidate ignore file.
 *
 * Usage:
 *   node scripts/check-privacy.mjs          # exit 1 and print every finding
 *   node scripts/check-privacy.mjs --list   # print the scanned file count
 *   node scripts/check-privacy.mjs --root <dir> --tracked
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, isTextBuffer, listFiles, listTrackedFiles } from './lib/tree.mjs';

/**
 * Paths every scan of this repository must contain. A scan that silently
 * misses `src/` or `README.md` reports zero findings for the files that matter
 * most; the gate fails closed instead.
 */
export const REQUIRED_ROOTS = Object.freeze(['src', 'docs', 'index.html', 'sw.js', 'README.md']);

/**
 * The reference unit's serial. Split into two fragments so this file — which
 * the scanner also scans — never carries the string it exists to ban.
 */
export const DEVICE_SERIAL = ['G5310', '22527'].join('');

/** The private host, split for the same reason. */
export const PRIVATE_HOST = ['local', 'server'].join('');

/** The only address form a public tree may contain: the synthetic fixtures. */
export const ALLOWED_EMAIL_DOMAINS = Object.freeze(['example.com']);

/**
 * Every rule the public tree must satisfy. `find` receives one line and says
 * whether it offends.
 */
export const DENY = Object.freeze([
  {
    id: 'private-host',
    why: 'a private host name',
    find: (line) => line.toLowerCase().includes(PRIVATE_HOST),
  },
  {
    id: 'home-directory',
    why: 'an absolute home directory',
    find: (line) => /\/home\//.test(line),
  },
  {
    id: 'users-directory',
    why: 'an absolute macOS home directory',
    find: (line) => /\/Users\//.test(line),
  },
  {
    id: 'windows-users-directory',
    why: 'an absolute Windows home directory',
    find: (line) => /[A-Za-z]:[\\/]Users[\\/]/.test(line),
  },
  {
    id: 'device-serial',
    why: 'the reference unit’s serial number',
    find: (line) => line.includes(DEVICE_SERIAL),
  },
  {
    id: 'playwright-cache',
    why: 'an absolute browser cache path',
    find: (line) => /(?:^|[\s"'`(=[])\/[^\s"'`)]*ms-playwright[^\s"'`)]*/.test(line),
  },
  {
    id: 'email-address',
    why: 'an e-mail address that is not a synthetic fixture',
    find: (line) => {
      const addresses = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      return addresses.some((address) => {
        const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
        return !ALLOWED_EMAIL_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
      });
    },
  },
]);

/**
 * Fail closed when the tree is not the repository surface.
 *
 * @param {string} root
 * @param {string[]} files the walker's result
 * @returns {Promise<void>}
 */
export async function assertCoverage(root, files) {
  for (const path of REQUIRED_ROOTS) {
    try {
      await stat(join(root, path));
    } catch {
      throw new Error(`required root missing from ${root}: ${path}; refusing an incomplete scan`);
    }
  }
  if (files.length === 0) throw new Error(`the scan found no files under ${root}; refusing an empty tree`);
}

/**
 * Scan one tree and return every finding.
 *
 * `tracked` uses `git ls-files` instead of the ignore-aware walker. The trusted
 * CI scan sets it: a candidate `.gitignore` must not be able to hide a file the
 * same candidate force-added and published.
 *
 * @param {{root?: string, rules?: object[], requireRoots?: boolean, tracked?: boolean}} [options]
 * @returns {Promise<{findings: {file: string, line: number, rule: string, why: string, text: string}[], scanned: number}>}
 */
export async function scanTree({ root = ROOT, rules, requireRoots = true, tracked = false } = {}) {
  const files = tracked ? listTrackedFiles({ root }) : await listFiles({ root, rules });
  if (requireRoots) await assertCoverage(root, files);
  const findings = [];
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    // A binary file that would be published is scanned too: an image's
    // metadata is as public as its pixels. Latin-1 maps every byte to one
    // character, so the same deny list applies without a decode failure.
    const textMode = isTextBuffer(bytes);
    const text = bytes.toString(textMode ? 'utf8' : 'latin1');
    for (const [index, line] of text.split('\n').entries()) {
      const excerpt = textMode ? line.trim() : line.replace(/[^\x20-\x7e]/g, '·').trim();
      for (const rule of DENY) {
        if (!rule.find(line)) continue;
        findings.push({ file, line: index + 1, rule: rule.id, why: rule.why, text: excerpt.slice(0, 160) });
      }
    }
  }
  return { findings, scanned: files.length };
}

/** One `file:line` line per finding. */
export function formatFinding(finding) {
  return `${finding.file}:${finding.line}: ${finding.rule} — ${finding.why}: ${finding.text}`;
}

async function main(argv) {
  let root = ROOT;
  let tracked = false;
  const flags = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[++index];
      if (!value) {
        console.error('privacy: --root needs a directory');
        return 2;
      }
      root = resolve(value);
    } else if (argument === '--tracked') {
      tracked = true;
    } else if (argument.startsWith('--')) {
      flags.push(argument);
    } else {
      console.error(`privacy: unexpected argument ${argument}`);
      return 2;
    }
  }
  const unknown = flags.filter((flag) => flag !== '--list');
  if (unknown.length) {
    console.error(`privacy: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/check-privacy.mjs [--list] [--root <dir>] [--tracked]');
    return 2;
  }
  const { findings, scanned } = await scanTree({ root, tracked }).catch((error) => {
    console.error(`privacy: ${error.message}`);
    return { findings: null, scanned: 0 };
  });
  if (findings == null) return 1;
  if (flags.includes('--list')) console.log(`privacy: ${scanned} files scanned`);
  if (!findings.length) return 0;
  for (const finding of findings) console.error(formatFinding(finding));
  console.error(`privacy: ${findings.length} finding(s) in ${scanned} files`);
  return 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`privacy: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
