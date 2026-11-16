#!/usr/bin/env node
/**
 * Release notes from the changelog, and the one version check a tag release
 * needs.
 *
 * `package.json` owns the version. A tag is published only when it is exactly
 * `v<version>`, and the notes are the matching `CHANGELOG.md` section — never a
 * hand-typed copy in the workflow. A missing section fails the release.
 *
 * Usage:
 *   node scripts/release-notes.mjs --tag v1.0.0 --out notes.md
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import brand from '../brand.json' with { type: 'json' };

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const CHANGELOG_FILE = 'CHANGELOG.md';
export const PACKAGE_FILE = 'package.json';

/** Strip the `v` a tag carries and require a release-shaped version. */
export function versionFromTag(tag) {
  const text = String(tag);
  if (!/^v\d+\.\d+\.\d+$/.test(text)) throw new Error(`tag must be vMAJOR.MINOR.PATCH: ${text}`);
  return text.slice(1);
}

/**
 * The body of one changelog section.
 *
 * A section starts at `## [1.0.0] - 2026-11-15` (the "Keep a Changelog" form)
 * or `## 1.0.0` and ends at the next level-2 heading.
 *
 * @param {string} markdown
 * @param {string} version
 * @returns {string} trimmed section body
 */
export function changelogSection(markdown, version) {
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
 * Build the notes for one tag.
 *
 * The changelog owns the prose; the signing certificate footer is a generated
 * fact from brand.json, the same value the release build compares. A
 * downloader can verify the artifact without finding a second copy elsewhere.
 *
 * `commit` is the pre-tag dry-run and release binding: when present it adds
 * one line naming the tag, the exact commit and the workflow ref that built it.
 * Without it the output is byte-for-byte what the historical releases used, so
 * regenerating v1.0.0/v1.0.1 still works.
 *
 * @param {{tag: string, version: string, changelog: string, commit?: string}} input
 * @returns {{version: string, title: string, body: string}}
 */
export function releaseNotes({ tag, version, changelog, commit }) {
  const tagged = versionFromTag(tag);
  if (tagged !== version) {
    throw new Error(`tag ${tag} does not match package.json version ${version}`);
  }
  if (commit != null && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`commit must be a 40-character lowercase SHA: ${commit}`);
  }
  const certificate = brand.androidSigningCertificateSha256;
  const binding = commit
    ? `\n\nBuilt from tag ${tag} at commit ${commit}; provenance workflow ref refs/heads/main.`
    : '';
  return {
    version,
    title: `${brand.name} ${version}`,
    body: `${changelogSection(changelog, version)}${binding}\n\n---\n\nSigning certificate SHA-256 (\`apksigner verify --print-certs\`): \`${certificate}\``,
  };
}

function parseArguments(argv) {
  const options = { tag: '', out: '', commit: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--tag') options.tag = argv[++index] ?? '';
    else if (argument === '--out') options.out = argv[++index] ?? '';
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
    console.error('usage: node scripts/release-notes.mjs --tag v1.0.0 [--commit <40-hex>] --out notes.md');
    return 2;
  }
  try {
    const [pkg, changelog] = await Promise.all([
      readFile(join(ROOT, PACKAGE_FILE), 'utf8').then(JSON.parse),
      readFile(join(ROOT, CHANGELOG_FILE), 'utf8'),
    ]);
    const notes = releaseNotes({ tag: options.tag, version: pkg.version, changelog, commit: options.commit || undefined });
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
