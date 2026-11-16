#!/usr/bin/env node
/**
 * Documentation gate: every relative link and every heading anchor in the
 * published Markdown resolves, no image points at a missing file, and no link
 * names a branch-specific absolute blob URL that would break when the default
 * branch or the repository name changes.
 *
 * Zero dependencies: the link and heading rules are implemented here, against
 * the published tree the shared walker returns.
 *
 * Usage:
 *   node scripts/check-docs.mjs          # exit 1 and print every finding
 *   node scripts/check-docs.mjs --list   # also print the scanned counts
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, listFiles } from './lib/tree.mjs';

/** An absolute link into a branch's blob view; a rename or a branch rename breaks it. */
const BLOB_LINK = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/blob\/(?:main|master)\//i;

/** An inline link or image: `[text](target)` and `![alt](target)`. */
const LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/g;

/** A fenced block (``` or ~~~) with its info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blank out fenced code blocks so a heading or a link inside one is never
 * treated as document structure. Line numbers are preserved.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function stripFences(markdown) {
  const lines = String(markdown).split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const match = FENCE.exec(line);
      if (match) {
        const marker = match[1];
        if (!fence) {
          fence = marker[0].repeat(marker.length);
          return '';
        }
        if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
          return '';
        }
      }
      return fence ? '' : line;
    })
    .join('\n');
}

/**
 * The plain text of one heading.
 *
 * GitHub strips inline HTML before building the slug, but this repository has
 * no heading with HTML in it, so the gate refuses one instead of hand-rolling a
 * scrub: a `<[^>]*>` replacement leaves `<script` behind and silently slugs a
 * half-stripped string. Refusing is the unambiguous answer.
 *
 * @param {string} text the heading text after the `#` markers
 * @returns {string}
 */
export function headingText(text) {
  const value = String(text);
  if (/[<>]/.test(value)) throw new Error(`a heading may not contain HTML: ${value}`);
  return value;
}

/**
 * The slugs GitHub generates for the headings in a document.
 *
 * Lower-case, HTML tags removed, punctuation removed, spaces collapsed to
 * hyphens; a repeated slug gains `-1`, `-2` in document order.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const seen = new Map();
  for (const line of stripFences(markdown).split('\n')) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = headingText(match[1]);
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/ /g, '-');
    if (!base) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count ? `${base}-${count}` : base);
  }
  return slugs;
}

/**
 * Every inline link and image in a document, with its 1-based line number.
 *
 * @param {string} markdown
 * @returns {{line: number, target: string, image: boolean, text: string}[]}
 */
export function markdownLinks(markdown) {
  const links = [];
  for (const [index, line] of stripFences(markdown).split('\n').entries()) {
    // A link reference definition is not a link into the tree.
    if (/^\s{0,3}\[[^\]]+\]:\s+\S+/.test(line)) continue;
    for (const match of line.matchAll(LINK)) {
      links.push({ line: index + 1, target: match[3], image: match[1] === '!', text: match[2] });
    }
  }
  return links;
}

/** Whether a link target points outside the repository. */
export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/**
 * Resolve one link against the file that contains it.
 *
 * @param {string} fromFile repo-relative Markdown file
 * @param {string} target the raw link target
 * @returns {{file: string|null, anchor: string|null}}
 */
export function resolveTarget(fromFile, target, root = ROOT) {
  const hashAt = target.indexOf('#');
  const rawPath = hashAt < 0 ? target : target.slice(0, hashAt);
  const anchor = hashAt < 0 ? null : target.slice(hashAt + 1);
  const withoutQuery = rawPath.split('?')[0];
  if (!withoutQuery) return { file: fromFile, anchor };
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  return { file: relative(root, resolve(root, dirname(fromFile), decoded)).split('\\').join('/'), anchor };
}

/**
 * Check one repository tree.
 *
 * @param {{root?: string, files?: string[]}} [options]
 * @returns {Promise<{findings: {file: string, line: number, message: string}[], files: number, links: number}>}
 */
export async function checkDocs({ root = ROOT, files } = {}) {
  const all = files ?? (await listFiles({ root }));
  const markdown = all.filter((file) => file.toLowerCase().endsWith('.md'));
  const cache = new Map();
  const read = async (file) => {
    if (!cache.has(file)) cache.set(file, await readFile(join(root, file), 'utf8'));
    return cache.get(file);
  };
  const findings = [];
  let links = 0;
  for (const file of markdown) {
    const text = await read(file);
    for (const link of markdownLinks(text)) {
      links++;
      if (BLOB_LINK.test(link.target)) {
        findings.push({ file, line: link.line, message: `absolute blob link breaks on a rename: ${link.target}` });
        continue;
      }
      if (isExternal(link.target) || link.target.startsWith('#')) {
        if (link.target.startsWith('#')) {
          const anchor = link.target.slice(1);
          if (anchor && !headingSlugs(text).has(anchor)) {
            findings.push({ file, line: link.line, message: `missing anchor #${anchor}` });
          }
        }
        continue;
      }
      const resolved = resolveTarget(file, link.target, root);
      if (!resolved.file || resolved.file.startsWith('../')) {
        findings.push({ file, line: link.line, message: `link escapes the repository: ${link.target}` });
        continue;
      }
      let info;
      try {
        info = await stat(join(root, resolved.file));
      } catch {
        findings.push({
          file,
          line: link.line,
          message: `${link.image ? 'image' : 'link'} target does not exist: ${link.target}`,
        });
        continue;
      }
      if (link.image && !info.isFile()) {
        findings.push({ file, line: link.line, message: `image target is not a file: ${link.target}` });
        continue;
      }
      if (!resolved.anchor) continue;
      if (!resolved.file.toLowerCase().endsWith('.md')) {
        findings.push({ file, line: link.line, message: `anchor on a non-Markdown target: ${link.target}` });
        continue;
      }
      const targetText = await read(resolved.file);
      if (!headingSlugs(targetText).has(resolved.anchor)) {
        findings.push({ file, line: link.line, message: `missing anchor #${resolved.anchor} in ${resolved.file}` });
      }
    }
  }
  return { findings, files: markdown.length, links };
}

async function main(argv) {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--list');
  if (unknown.length) {
    console.error(`docs: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/check-docs.mjs [--list]');
    return 2;
  }
  const { findings, files, links } = await checkDocs();
  if (flags.includes('--list')) console.log(`docs: ${files} Markdown files, ${links} links`);
  if (!findings.length) return 0;
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  console.error(`docs: ${findings.length} finding(s) in ${files} Markdown files`);
  return 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
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
