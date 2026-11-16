/**
 * One version owner: `package.json`. The changelog, the app config, the release
 * notes and the tag check all read it, and a release fails when they disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG } from '../src/core/config.js';
import { BRAND } from '../src/core/brand.js';
import { CHANGELOG_FILE, PACKAGE_FILE, changelogSection, releaseNotes, versionFromTag } from '../scripts/release-notes.mjs';
import { projectRoot, readProjectFile as read } from './helpers/project-files.mjs';

const pkg = JSON.parse(read(PACKAGE_FILE));
const changelog = read(CHANGELOG_FILE);

test('package.json, the app config and the changelog agree on one version', () => {
  assert.equal(pkg.version, CONFIG.app.version, 'the app reports the package version');

  const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map((match) => ({
    version: match[1],
    date: match[2],
  }));
  assert.ok(headings.length > 0, 'the changelog has dated release sections');
  assert.equal(headings[0].version, pkg.version, 'the newest section is the package version');
  for (const { date } of headings) {
    const parsed = new Date(`${date}T00:00:00Z`);
    assert.equal(Number.isNaN(parsed.valueOf()), false, `${date} is a real date`);
    assert.equal(parsed.toISOString().slice(0, 10), date, `${date} is a calendar date`);
  }
  assert.equal(new Set(headings.map((heading) => heading.version)).size, headings.length, 'no duplicate section');

  // The release is the only thing that may turn this version into a tag, and
  // the tag is derived from package.json rather than copied here.
  assert.equal(versionFromTag(`v${pkg.version}`), pkg.version);
});

test('the release workflow reads the version, never a copy of it', () => {
  const release = read('.github/workflows/release.yml');
  assert.equal(release.includes(`v${pkg.version}`), false, 'the workflow hard-codes no version');
  assert.match(release, /require\('\.\/package\.json'\)\.version/, 'the workflow reads package.json');
  assert.match(release, /release-notes\.mjs --tag "\$GITHUB_REF_NAME"/, 'the tested script owns the tag comparison');
});

test('the release notes are the matching changelog section', () => {
  const notes = releaseNotes({ tag: `v${pkg.version}`, version: pkg.version, changelog });
  assert.equal(notes.version, pkg.version);
  assert.equal(notes.title, `${BRAND.name} ${pkg.version}`);
  assert.equal(notes.body, changelogSection(changelog, pkg.version));
  assert.ok(notes.body.trim().length > 0, 'the release has notes');
  assert.doesNotMatch(notes.body, /^## /m, 'the body does not repeat the section heading');
});

test('a tag that is not v<version> is refused', () => {
  for (const tag of ['1.0.0', 'v1.0', 'v1.0.0.0', 'main', 'v1.0.0-rc.1']) {
    assert.throws(() => versionFromTag(tag), /tag must be vMAJOR\.MINOR\.PATCH/, `${tag} is refused`);
  }
  assert.equal(versionFromTag('v1.0.0'), '1.0.0');
  const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.throws(
    () => releaseNotes({ tag: 'v2.0.0', version: pkg.version, changelog }),
    new RegExp(`tag v2\\.0\\.0 does not match package\\.json version ${escapedVersion}`)
  );
});

test('a changelog section ends at the next heading and a missing one fails', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [2.0.0] - 2027-01-01',
    '',
    '### Added',
    '',
    '- two',
    '',
    '## [1.0.0] - 2026-11-15',
    '',
    '- one',
    '',
  ].join('\n');
  assert.equal(changelogSection(markdown, '1.0.0'), '- one');
  assert.equal(changelogSection(markdown, '2.0.0'), '### Added\n\n- two');
  assert.throws(() => changelogSection(markdown, '3.0.0'), /no section for 3\.0\.0/);
  assert.throws(() => changelogSection('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - x', '1.0.0'), /section for 1\.0\.0 is empty/);
});

test('the command line writes the notes and fails on a wrong tag', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'drypoint-notes-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const script = join(projectRoot, 'scripts', 'release-notes.mjs');
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });

  const notes = join(out, 'notes.md');
  run('--tag', `v${pkg.version}`, '--out', notes);
  const written = await readFile(notes, 'utf8');
  assert.equal(written, `${changelogSection(changelog, pkg.version)}\n`);

  assert.throws(
    () => run('--tag', 'v9.9.9', '--out', join(out, 'wrong.md')),
    (error) => error.status === 1 && /does not match package\.json version/.test(error.stderr)
  );
  assert.throws(
    () => run('--out', join(out, 'x.md')),
    (error) => error.status === 2 && /--tag is required/.test(error.stderr)
  );
});

test('the changelog keeps the Keep a Changelog shape', () => {
  assert.match(changelog, /^# Changelog$/m);
  assert.match(changelog, /Keep a Changelog/);
  assert.match(changelog, /Semantic Versioning/);
  for (const section of ['### Added', '### Changed', '### Fixed', '### Security']) {
    assert.ok(changelog.includes(section), `${section} is present in the changelog`);
  }
});
