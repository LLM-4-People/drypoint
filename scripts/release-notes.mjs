#!/usr/bin/env node
/**
 * Release notes from the changelog, and the one version check a tag release
 * needs.
 *
 * `package.json` owns the version. A tag is published only when it is exactly
 * `v<version>`, and the notes are the matching `CHANGELOG.md` section, never a
 * hand-typed copy in the workflow. A missing section fails the release.
 *
 * Usage:
 *   node scripts/release-notes.mjs --tag v1.0.2 --out notes.md
 *   node scripts/release-notes.mjs --tag v1.0.0 --historical --out /tmp/v1.0.0.md
 *
 * A published tag cannot be regenerated from the current package.json, so
 * `--historical` renders an older section from the current changelog. Compare
 * that output with `gh release view <tag> --json body --jq .body`; the tags and
 * assets themselves are immutable and are never rewritten.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import brand from '../brand.json' with { type: 'json' };

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const CHANGELOG_FILE = 'CHANGELOG.md';
export const PACKAGE_FILE = 'package.json';

/**
 * A release-page directive inside a changelog section. It is consumed here and
 * never reaches the body. The only directive is `no signing footer`: the
 * v1.0.0 and v1.0.1 bodies were published before the generated certificate
 * footer existed, and a historical body must not gain a footer that names a
 * different key.
 */
const RELEASE_DIRECTIVE = /^<!--\s*release-notes:\s*(.*?)\s*-->$/gm;
const NO_FOOTER = /no signing footer/i;
const TRAILING_BLANK = /one trailing blank line/i;

/** Strip the generator directives from one section body. */
function stripDirectives(text) {
  return String(text).replace(RELEASE_DIRECTIVE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Every directive in one section body. */
function sectionDirectives(markdown, version) {
  const raw = rawChangelogSection(markdown, version);
  return [...raw.matchAll(RELEASE_DIRECTIVE)].map((match) => match[1]);
}

/** Strip the `v` a tag carries and require a release-shaped version. */
export function versionFromTag(tag) {
  const text = String(tag);
  if (!/^v\d+\.\d+\.\d+$/.test(text)) throw new Error(`tag must be vMAJOR.MINOR.PATCH: ${text}`);
  return text.slice(1);
}

/** Compare two `MAJOR.MINOR.PATCH` versions: negative when a precedes b. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * The raw body of one changelog section, including release-page directives.
 *
 * A section starts at `## [1.0.0] - 2026-11-15` (the "Keep a Changelog" form)
 * or `## 1.0.0` and ends at the next level-2 heading.
 *
 * @param {string} markdown
 * @param {string} version
 * @returns {string} trimmed section body
 */
function rawChangelogSection(markdown, version) {
  const lines = String(markdown).split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`${CHANGELOG_FILE} has no section for ${version}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (!body) throw new Error(`${CHANGELOG_FILE} section for ${version} is empty`);
  return body;
}

/**
 * The body of one changelog section, without the generator directives.
 *
 * @param {string} markdown
 * @param {string} version
 * @returns {string} trimmed section body
 */
export function changelogSection(markdown, version) {
  const body = stripDirectives(rawChangelogSection(markdown, version));
  if (!body) throw new Error(`${CHANGELOG_FILE} section for ${version} is empty`);
  return body;
}

/**
 * Build the notes for one tag.
 *
 * The changelog owns the prose; the signing certificate footer is a generated
 * fact from brand.json, the same value the release build compares. A
 * downloader can verify the artifact without finding a second copy elsewhere.
 * A section may carry `<!-- release-notes: no signing footer -->` when its
 * published body predates the footer (v1.0.0 and v1.0.1).
 *
 * `commit` is the pre-tag dry-run and release binding: when present it adds
 * one line naming the tag, the exact commit and the workflow ref that built it.
 *
 * `historical` renders an older section from the current changelog for
 * verification. It is never used by the release workflow: the tag must then be
 * strictly older than `package.json`'s version, and a commit binding is
 * refused. The assets and tag of a published release stay immutable; only the
 * changelog record can be corrected.
 *
 * @param {{tag: string, version: string, changelog: string, commit?: string, historical?: boolean}} input
 * @returns {{version: string, title: string, body: string}}
 */
export function releaseNotes({ tag, version, changelog, commit, historical = false }) {
  const tagged = versionFromTag(tag);
  if (historical) {
    if (compareVersions(tagged, version) >= 0) {
      throw new Error(`historical notes must precede package.json version ${version}: ${tag}`);
    }
    if (commit != null) throw new Error('a historical body never carries a commit binding');
  } else if (tagged !== version) {
    throw new Error(`tag ${tag} does not match package.json version ${version}`);
  }
  if (commit != null && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`commit must be a 40-character lowercase SHA: ${commit}`);
  }
  const certificate = brand.androidSigningCertificateSha256;
  const binding = commit
    ? `\n\nBuilt from tag ${tag} at commit ${commit}; provenance workflow ref refs/heads/main.`
    : '';
  const noFooter = sectionDirectives(changelog, tagged).some((directive) => NO_FOOTER.test(directive));
  const trailingBlank = sectionDirectives(changelog, tagged).some((directive) => TRAILING_BLANK.test(directive));
  const footer = noFooter
    ? ''
    : `\n\n---\n\nSigning certificate SHA-256 (\`apksigner verify --print-certs\`): \`${certificate}\``;
  return {
    version: tagged,
    title: `${brand.name} ${tagged}`,
    body: `${changelogSection(changelog, tagged)}${trailingBlank ? '\n' : ''}${binding}${footer}`,
  };
}

function parseArguments(argv) {
  const options = { tag: '', out: '', commit: '', historical: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--tag') options.tag = argv[++index] ?? '';
    else if (argument === '--out') options.out = argv[++index] ?? '';
    else if (argument === '--historical') options.historical = true;
    else if (argument === '--commit') {
      const value = argv[++index];
      if (!value) throw new Error('--commit needs a 40-character SHA');
      options.commit = value;
    } else throw new Error(`unknown option ${argument}`);
  }
  if (!options.tag) throw new Error('--tag is required');
  if (!options.out) throw new Error('--out is required');
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    console.error(
      'usage: node scripts/release-notes.mjs --tag v1.0.0 [--commit <40-hex>] [--historical] --out notes.md'
    );
    return 2;
  }
  try {
    const [pkg, changelog] = await Promise.all([
      readFile(join(ROOT, PACKAGE_FILE), 'utf8').then(JSON.parse),
      readFile(join(ROOT, CHANGELOG_FILE), 'utf8'),
    ]);
    const notes = releaseNotes({
      tag: options.tag,
      version: pkg.version,
      changelog,
      commit: options.commit || undefined,
      historical: options.historical,
    });
    await writeFile(options.out, `${notes.body}\n`);
    console.log(`release-notes: ${notes.title} → ${options.out}`);
    return 0;
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
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
      console.error(`release-notes: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
