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
  assert.match(release, /git show "\$sha:package\.json" \| jq -r \.version/, 'the resolve step reads the tag commit package.json');
  assert.match(release, /release-notes\.mjs --tag "\$TAG" --commit "\$SHA"/, 'the tested script owns the tag comparison and the commit binding');
  assert.doesNotMatch(release, /GITHUB_REF_NAME/, 'the workflow never derives the tag from the ref name');
});

test('the release notes keep the historical body and add one commit binding', () => {
  const notes = releaseNotes({ tag: `v${pkg.version}`, version: pkg.version, changelog });
  assert.equal(notes.version, pkg.version);
  assert.equal(notes.title, `${BRAND.name} ${pkg.version}`);
  assert.ok(notes.body.startsWith(changelogSection(changelog, pkg.version)), 'the section comes first');
  assert.match(notes.body, /^Signing certificate SHA-256 \(`apksigner verify --print-certs`\): `[0-9a-f]{64}`$/m);
  assert.ok(notes.body.includes(BRAND.androidSigningCertificateSha256), 'the footer is the brand fact');
  assert.ok(notes.body.trim().length > 0, 'the release has notes');
  assert.doesNotMatch(notes.body, /^## /m, 'the body does not repeat the section heading');
  assert.doesNotMatch(notes.body, /^Built from tag/m, 'without --commit the historical body is unchanged');

  const sha = 'a'.repeat(40);
  const bound = releaseNotes({ tag: `v${pkg.version}`, version: pkg.version, changelog, commit: sha });
  assert.equal(
    bound.body,
    notes.body.replace(
      '\n\n---',
      `\n\nBuilt from tag v${pkg.version} at commit ${sha}; provenance workflow ref refs/heads/main.\n\n---`
    ),
    'the commit adds exactly one binding line and changes nothing else'
  );

  for (const commit of ['abc', 'A'.repeat(40), 'g'.repeat(40), `${'a'.repeat(39)} `]) {
    assert.throws(
      () => releaseNotes({ tag: `v${pkg.version}`, version: pkg.version, changelog, commit }),
      /commit must be a 40-character lowercase SHA/
    );
  }
});

test('historical bodies render from the current changelog in their published shape', () => {
  const v100 = releaseNotes({ tag: 'v1.0.0', version: '1.0.0', changelog });
  assert.ok(v100.body.startsWith('> **Do not install this build for new work.**'), 'the banner is the first block');
  assert.ok(v100.body.includes('First public release:'), 'the section follows the banner');
  assert.doesNotMatch(v100.body, /Signing certificate SHA-256/, 'v1.0.0 was published before the generated footer');
  assert.ok(v100.body.endsWith('\n'), 'the published body ended with one blank line');

  const v101 = releaseNotes({ tag: 'v1.0.1', version: '1.0.1', changelog });
  assert.doesNotMatch(v101.body, /was retired before any public install; v1\.0\.1 is signed/, 'the unproven claim is superseded');
  assert.doesNotMatch(v101.body, /The APK is byte-reproducible: generated ZIP/, 'the rebuild claim is corrected');
  assert.match(v101.body, /the 1\.0\.0 APK had been downloaded/);
  assert.match(v101.body, /\*\*Historical note \(added 2026-11-16\)\.\*\*/);
  assert.doesNotMatch(v101.body, /Signing certificate SHA-256/, 'v1.0.1 was published before the generated footer');

  const v102 = releaseNotes({ tag: 'v1.0.2', version: '1.0.2', changelog });
  assert.match(v102.body, /^> \*\*Android 1\.0\.2 limitation \(recorded 2026-11-16\)\.\*\*/, 'the dated note is first');
  assert.doesNotMatch(v102.body, /loads it again on any device/, 'the Android 1.0.2 claim is corrected');
  assert.doesNotMatch(v102.body, /print refusal reason is visible/, 'the banner claim is narrowed');
  assert.match(v102.body, /A model or geometry refusal is visible/);
  assert.match(v102.body, /D110_BROWSER_CONCURRENCY/);
  assert.match(v102.body, /Signing certificate SHA-256/, '1.0.2 carries the generated footer');
  assert.doesNotMatch(v102.body, /release-notes:/, 'directives never reach a release body');
});

test('historical rendering cannot bypass the release version binding', () => {
  assert.equal(releaseNotes({ tag: 'v1.0.0', version: '1.0.2', changelog, historical: true }).version, '1.0.0');
  assert.throws(
    () => releaseNotes({ tag: 'v1.0.2', version: '1.0.2', changelog, historical: true }),
    /historical notes must precede package\.json version 1\.0\.2/
  );
  assert.throws(
    () => releaseNotes({ tag: 'v1.0.0', version: '1.0.2', changelog, historical: true, commit: 'a'.repeat(40) }),
    /a historical body never carries a commit binding/
  );
});

test('a release-page directive is consumed and can suppress the generated footer', () => {
  const markdown = [
    '## [1.0.0] - 2026-01-01',
    '',
    '<!-- release-notes: the blockquote below is the banner -->',
    '> banner',
    '',
    '- one',
    '',
    '<!-- release-notes: no signing footer; the body predates it -->',
    '',
  ].join('\n');
  assert.equal(changelogSection(markdown, '1.0.0'), '> banner\n\n- one');
  assert.equal(releaseNotes({ tag: 'v1.0.0', version: '1.0.0', changelog: markdown }).body, '> banner\n\n- one');
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
  const sha = 'b'.repeat(40);
  run('--tag', `v${pkg.version}`, '--commit', sha, '--out', notes);
  const written = await readFile(notes, 'utf8');
  assert.ok(written.startsWith(`${changelogSection(changelog, pkg.version)}\n`));
  assert.ok(written.includes(BRAND.androidSigningCertificateSha256), 'the written notes carry the certificate');
  assert.ok(written.includes(`Built from tag v${pkg.version} at commit ${sha}; provenance workflow ref refs/heads/main.`));

  const historical = join(out, 'historical.md');
  run('--tag', `v${pkg.version}`, '--out', historical);
  assert.doesNotMatch(await readFile(historical, 'utf8'), /Built from tag/, 'regeneration without --commit stays unchanged');

  const old = join(out, 'v1.0.0.md');
  run('--tag', 'v1.0.0', '--historical', '--out', old);
  const oldText = await readFile(old, 'utf8');
  assert.ok(oldText.startsWith('> **Do not install this build for new work.**'));
  assert.doesNotMatch(oldText, /Signing certificate SHA-256/, 'the historical body keeps its published shape');
  assert.throws(
    () => run('--tag', `v${pkg.version}`, '--historical', '--out', join(out, 'current.md')),
    (error) => error.status === 1 && /must precede package\.json version/.test(error.stderr)
  );

  assert.throws(
    () => run('--tag', `v${pkg.version}`, '--commit', 'abc', '--out', join(out, 'bad.md')),
    (error) => error.status === 1 && /commit must be a 40-character lowercase SHA/.test(error.stderr)
  );
  assert.throws(
    () => run('--tag', `v${pkg.version}`, '--commit'),
    (error) => error.status === 2 && /--commit needs a 40-character SHA/.test(error.stderr)
  );
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
