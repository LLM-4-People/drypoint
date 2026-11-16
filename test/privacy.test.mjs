/**
 * The privacy gate: one deny list, one allowlist, one file walker.
 *
 * The planted values below are assembled from fragments on purpose: this test
 * file is itself part of the tree the gate scans, and a test that carried the
 * forbidden strings would fail its own gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_EMAIL_DOMAINS,
  DENY,
  DEVICE_SERIAL,
  PRIVATE_HOST,
  REQUIRED_ROOTS,
  assertCoverage,
  formatFinding,
  scanTree,
} from '../scripts/check-privacy.mjs';
import { ALWAYS_SKIP, globBody, isIgnored, parseIgnore } from '../scripts/lib/tree.mjs';
import { FIXTURE_SERIAL } from './fixtures/captured-unit.mjs';
import { projectRoot } from './helpers/project-files.mjs';

/** A synthetic home path, built so this file holds no absolute home directory. */
const HOME_PATH = ['', 'home', 'someone', 'work'].join('/');
/** A synthetic macOS home path. */
const MAC_PATH = ['', 'Users', 'someone', 'work'].join('/');
/** A Windows home path. */
const WINDOWS_PATH = ['C:', 'Users', 'someone', 'work'].join('\\');
/** An absolute browser-cache path, built for the same reason. */
const BROWSER_CACHE = ['', 'opt', 'ms-playwright', 'chromium-1234', 'chrome-linux64', 'chrome'].join('/');
/** An address outside the synthetic fixture domain. */
const FOREIGN_MAIL = ['someone', 'example.org'].join('@');

async function tempTree(t) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function plant(root, file, lines) {
  await mkdir(join(root, file, '..'), { recursive: true });
  await writeFile(join(root, file), `${lines.join('\n')}\n`);
}

test('the planted secrets are reported with file and line', async (t) => {
  const root = await tempTree(t);
  const cases = [
    ['host.txt', `host: https://${PRIVATE_HOST}.example/`, 'private-host'],
    ['path.txt', `open ${HOME_PATH}/notes.txt`, 'home-directory'],
    ['mac.txt', `open ${MAC_PATH}/notes.txt`, 'users-directory'],
    ['windows.txt', `open ${WINDOWS_PATH}\\notes.txt`, 'windows-users-directory'],
    ['serial.txt', `serial: ${DEVICE_SERIAL}`, 'device-serial'],
    ['browser.txt', `open ${BROWSER_CACHE}`, 'playwright-cache'],
    ['mail.txt', `mail ${FOREIGN_MAIL}`, 'email-address'],
  ];
  for (const [file, line] of cases) await plant(root, file, ['first line', line]);

  const { findings, scanned } = await scanTree({ root, requireRoots: false });
  assert.equal(scanned, cases.length);
  const expected = cases
    .map(([file, , rule]) => ({ file, line: 2, rule }))
    .sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(
    findings.map(({ file, line, rule }) => ({ file, line, rule })),
    expected,
    'every planted secret is reported at its real line'
  );

  const host = findings.find((finding) => finding.file === 'host.txt');
  assert.match(formatFinding(host), /^host\.txt:2: private-host: /);
  assert.match(formatFinding(host), new RegExp(PRIVATE_HOST));
});

test('an absolute Playwright path is caught even without a home directory', async (t) => {
  const root = await tempTree(t);
  await plant(root, 'cache.txt', [`open ${BROWSER_CACHE}`]);
  const { findings } = await scanTree({ root, requireRoots: false });
  assert.deepEqual(findings.map((finding) => finding.rule), ['playwright-cache']);
});

test('a binary file that would be published is scanned too', async (t) => {
  const root = await tempTree(t);
  // An image's metadata is as public as its pixels; NUL bytes are not a hiding
  // place.
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
    Buffer.from(`serial:${DEVICE_SERIAL}`),
    Buffer.from([0x00, 0x01]),
  ]);
  await writeFile(join(root, 'icon.png'), bytes);
  const { findings } = await scanTree({ root, requireRoots: false });
  assert.deepEqual(findings.map((finding) => finding.rule), ['device-serial']);
  assert.match(formatFinding(findings[0]), /^icon\.png:1: device-serial/);
});

test('the synthetic fixtures and example.com are allowed', async (t) => {
  const root = await tempTree(t);
  await plant(root, 'fixture.txt', [
    `serial: ${FIXTURE_SERIAL}`,
    'mail someone@example.com',
    'mail another@sub.example.com',
    'host: drypoint.local',
    'path: ~/.cache/ms-playwright/chromium-1/chrome',
  ]);
  const { findings } = await scanTree({ root, requireRoots: false });
  assert.deepEqual(findings, [], 'fixtures, example.com and relative cache paths pass');
});

test('ignored files and build directories are never scanned', async (t) => {
  const root = await tempTree(t);
  await writeFile(join(root, '.gitignore'), '*.log\nprivate/\n');
  await plant(root, 'kept.txt', ['ok']);
  await plant(root, 'debug.log', [`host: https://${PRIVATE_HOST}.example/`]);
  await plant(root, 'private/secret.txt', [`open ${HOME_PATH}/x`]);
  for (const directory of ALWAYS_SKIP) {
    await plant(root, `${directory}/artifact.txt`, [`serial: ${DEVICE_SERIAL}`]);
  }
  const { findings, scanned } = await scanTree({ root, requireRoots: false });
  assert.deepEqual(findings, [], 'an ignored path cannot carry a secret into the result');
  assert.equal(scanned, 2, '.gitignore and kept.txt are the only files scanned');
});

test('the walker implements the ignore syntax the repository uses', () => {
  const rules = parseIgnore(['# comment', '', '*.log', 'build/', '/root-only', 'a/**/b', '!keep.log'].join('\n'));
  assert.deepEqual(
    rules.map((rule) => rule.pattern),
    ['*.log', 'build/', '/root-only', 'a/**/b', '!keep.log'],
    'comments and blank lines are skipped, order is kept'
  );
  assert.throws(() => parseIgnore('[abc].txt'), /character class/, 'an unsupported pattern fails loudly');
});

test('the glob translation keeps * inside one segment and lets ** cross them', () => {
  assert.equal(globBody('*.log'), '[^/]*\\.log');
  assert.equal(globBody('a/**/b'), 'a/(?:.*/)?b');
  assert.equal(globBody('file?.txt'), 'file[^/]\\.txt');

  const rules = parseIgnore('*.log\nbuild/\nnode_modules\n*.tmp\n');
  assert.equal(isIgnored('a/b/debug.log', rules), true);
  assert.equal(isIgnored('a/build/out.txt', rules), true);
  assert.equal(isIgnored('x/node_modules/y/index.js', rules), true);
  assert.equal(isIgnored('x/keep.txt', rules), false);
});

test('a negation re-includes a file after a broad rule', () => {
  const rules = parseIgnore('*.log\n!keep.log\n');
  assert.equal(isIgnored('debug.log', rules), true);
  assert.equal(isIgnored('keep.log', rules), false);
});

test('the real tree passes the gate', async () => {
  const { findings, scanned } = await scanTree();
  assert.deepEqual(findings.map(formatFinding), [], 'no private host, home path, serial or address in the published tree');
  assert.ok(scanned > 100, `the gate scanned the real tree (${scanned} files)`);
});

test('the reference unit serial appears nowhere', async () => {
  // The contract behind B5: the real serial is not published, and the fixtures
  // carry a clearly synthetic value from one owner.
  assert.equal(DEVICE_SERIAL.length > 0, true);
  const scanner = await readFile(join(projectRoot, 'scripts', 'check-privacy.mjs'), 'utf8');
  assert.equal(scanner.includes(DEVICE_SERIAL), false, 'the scanner does not carry the string it bans');

  const { findings } = await scanTree();
  assert.deepEqual(findings.filter((finding) => finding.rule === 'device-serial'), []);
  assert.match(FIXTURE_SERIAL, /^TEST/);
  assert.notEqual(FIXTURE_SERIAL, DEVICE_SERIAL);
});

test('the deny list names every identifier the policy requires', () => {
  const ids = DENY.map((rule) => rule.id);
  for (const id of [
    'private-host',
    'home-directory',
    'users-directory',
    'windows-users-directory',
    'device-serial',
    'playwright-cache',
    'email-address',
  ]) {
    assert.ok(ids.includes(id), `the deny list covers ${id}`);
  }
  assert.deepEqual([...ALLOWED_EMAIL_DOMAINS], ['example.com'], 'only the synthetic fixture domain is allowed');
});

/** Create the roots a real scan must contain. */
async function requiredSurface(root) {
  for (const path of REQUIRED_ROOTS) {
    if (path.includes('.')) await plant(root, path, ['ok']);
    else await plant(root, `${path}/example.md`, ['ok']);
  }
}

test('the command line fails on a planted tree and passes on a clean one', async (t) => {
  const root = await tempTree(t);
  await requiredSurface(root);
  await plant(root, 'leak.txt', [`open ${HOME_PATH}/x`]);
  await writeFile(join(root, '.gitignore'), '');
  const script = join(projectRoot, 'scripts', 'check-privacy.mjs');
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });

  assert.throws(
    () => run('--root', root),
    (error) => error.status === 1 && /leak\.txt:1: home-directory/.test(error.stderr),
    'the gate exits 1 and prints file:line'
  );

  await rm(join(root, 'leak.txt'));
  assert.equal(run('--root', root, '--list').trim(), `privacy: ${REQUIRED_ROOTS.length + 1} files scanned`);
});

test('the scan fails closed on a missing required root or an empty tree', async (t) => {
  const empty = await tempTree(t);
  await assert.rejects(scanTree({ root: empty }), /required root missing from .*: src; refusing an incomplete scan/);
  await assert.rejects(assertCoverage(empty, []), /required root missing/);

  const script = join(projectRoot, 'scripts', 'check-privacy.mjs');
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', empty], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1 && /required root missing/.test(error.stderr),
    'the standalone command refuses an incomplete tree'
  );

  // Required files can be present and still leave nothing scanned when the
  // walker ignores every one of them.
  const ignored = await tempTree(t);
  await requiredSurface(ignored);
  await writeFile(join(ignored, '.gitignore'), '*\n');
  await assert.rejects(scanTree({ root: ignored }), /refusing an empty tree/);
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', ignored], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1 && /refusing an empty tree/.test(error.stderr)
  );
});
