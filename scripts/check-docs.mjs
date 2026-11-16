#!/usr/bin/env node
/**
 * Documentation gate: every relative link and every heading anchor in the
 * published Markdown resolves, no image points at a missing file, no link names
 * a branch-specific absolute blob URL that would break when the default branch
 * or the repository name changes, and every issue template uses an absolute
 * link whose target and anchor exist in this tree.
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

/** Issue templates: GitHub renders their Markdown on the new-issue page. */
const ISSUE_TEMPLATE_DIR = '.github/ISSUE_TEMPLATE/';
const ISSUE_TEMPLATE_FILE = /\.ya?ml$/i;

/**
 * A GitHub blob URL: owner, repository, path and optional anchor. The ref is
 * not captured on purpose: the path is checked against this tree, so a stale
 * link fails whichever branch or tag it names.
 */
const BLOB_TARGET = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/[^/]+\/([^?#]+)(?:\?[^#]*)?(?:#(.*))?$/i;

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

/** Whether a path is an issue template whose Markdown GitHub renders on the issue page. */
export function isIssueTemplate(file) {
  return file.startsWith(ISSUE_TEMPLATE_DIR) && ISSUE_TEMPLATE_FILE.test(file);
}

/**
 * The GitHub repository this tree publishes to, lower-cased `owner/repo`, or
 * null when it has no GitHub repository URL. Read from `package.json` so the
 * owner is not copied into this gate.
 *
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function githubRepository(root) {
  let text;
  try {
    text = await readFile(join(root, 'package.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const url = JSON.parse(text).repository?.url ?? '';
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[#?].*)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * Check one link found in an issue template.
 *
 * GitHub renders the template's Markdown on the new-issue page, where a
 * relative target resolves against `/owner/repo/issues/` and 404s. The link
 * must be absolute, and a link into this repository's blob view is resolved
 * against the real tree so a renamed file or heading fails the gate.
 *
 * @param {{
 *   root: string,
 *   file: string,
 *   link: {line: number, target: string},
 *   repository: string|null,
 *   read: (file: string) => Promise<string>,
 * }} options
 * @returns {Promise<{file: string, line: number, message: string}|null>}
 */
async function issueTemplateFinding({ root, file, link, repository, read }) {
  if (!isExternal(link.target)) {
    return {
      file,
      line: link.line,
      message: `relative link in an issue template does not resolve on the issue page: ${link.target}`,
    };
  }
  const blob = BLOB_TARGET.exec(link.target);
  if (!blob || !repository) return null;
  const [, owner, repo, rawPath, anchor = null] = blob;
  if (`${owner}/${repo}`.toLowerCase() !== repository) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const target = relative(root, resolve(root, decoded)).split('\\').join('/');
  if (!target || target.startsWith('../')) {
    return { file, line: link.line, message: `issue-template link escapes the repository: ${link.target}` };
  }
  let info;
  try {
    info = await stat(join(root, target));
  } catch {
    return { file, line: link.line, message: `issue-template link target does not exist: ${link.target}` };
  }
  if (!info.isFile()) {
    return { file, line: link.line, message: `issue-template link target is not a file: ${link.target}` };
  }
  if (anchor && target.toLowerCase().endsWith('.md')) {
    const targetText = await read(target);
    if (!headingSlugs(targetText).has(anchor)) {
      return { file, line: link.line, message: `missing anchor #${anchor} in ${target}` };
    }
  }
  return null;
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
 * @returns {Promise<{findings: {file: string, line: number, message: string}[], files: number, templates: number, links: number}>}
 */
export async function checkDocs({ root = ROOT, files } = {}) {
  const all = files ?? (await listFiles({ root }));
  const markdown = all.filter((file) => file.toLowerCase().endsWith('.md'));
  const templates = all.filter(isIssueTemplate);
  const cache = new Map();
  const read = async (file) => {
    if (!cache.has(file)) cache.set(file, await readFile(join(root, file), 'utf8'));
    return cache.get(file);
  };
  const repository = await githubRepository(root);
  const findings = [];
  let links = 0;
  for (const file of [...markdown, ...templates]) {
    const text = await read(file);
    for (const link of markdownLinks(text)) {
      links++;
      if (isIssueTemplate(file)) {
        const finding = await issueTemplateFinding({ root, file, link, repository, read });
        if (finding) findings.push(finding);
        continue;
      }
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
  return { findings, files: markdown.length, templates: templates.length, links };
}

async function main(argv) {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--list');
  if (unknown.length) {
    console.error(`docs: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/check-docs.mjs [--list]');
    return 2;
  }
  const { findings, files, templates, links } = await checkDocs();
  if (flags.includes('--list')) {
    console.log(`docs: ${files} Markdown files and ${templates} issue templates, ${links} links`);
  }
  if (!findings.length) return 0;
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  console.error(`docs: ${findings.length} finding(s) in ${files} Markdown files and ${templates} issue templates`);
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
