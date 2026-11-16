/**
 * The generated documentation blocks are derived, not hand-maintained. A
 * hand edit inside a marker pair must fail the check that `verify` runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDocs,
  checkDocs,
  markers,
  npmInvocation,
  renderScriptsBlock,
  renderSuitesBlock,
  replaceGeneratedBlock,
  writeDocs,
} from '../scripts/build-docs.mjs';
import { browserSuite } from '../scripts/test-suites.mjs';
import { projectRoot } from './helpers/project-files.mjs';

test('the script table is the package.json scripts, with one invocation each', () => {
  const scripts = { start: 'node a.mjs', test: 'node --test x', 'verify:all': 'npm run verify && npm run test:browser' };
  const block = renderScriptsBlock(scripts);
  assert.equal(npmInvocation('start'), 'npm start');
  assert.equal(npmInvocation('test'), 'npm test');
  assert.equal(npmInvocation('verify:all'), 'npm run verify:all');
  for (const [name, command] of Object.entries(scripts)) {
    assert.ok(block.includes(`\`${npmInvocation(name)}\``), `${name} is documented`);
    assert.ok(block.includes(`\`${command}\``), `${name}'s command is the owner text`);
  }
});

test('the browser suite block is the test-suites owner, file by file', () => {
  const suite = browserSuite();
  assert.ok(suite.files.length > 0, 'the browser suite is not empty');
  const block = renderSuitesBlock(suite);
  const noun = suite.tests === 1 ? 'test' : 'tests';
  assert.match(block, new RegExp(`${suite.tests} ${noun} in ${suite.files.length} files?`));
  for (const entry of suite.files) assert.ok(block.includes(`\`${entry.file}\``), `${entry.file} is listed`);
});

test('a missing or duplicated marker is refused', () => {
  const { start, end } = markers('scripts');
  assert.throws(() => replaceGeneratedBlock('# no markers\n', 'scripts', 'x'), /missing generated marker/);
  assert.throws(
    () => replaceGeneratedBlock(`# t\n${start}\nx\n${end}\n${start}\ny\n${end}\n`, 'scripts', 'z'),
    /exactly one generated marker pair/
  );
  assert.equal(
    replaceGeneratedBlock(`# t\n${start}\nold\n${end}\n`, 'scripts', 'new'),
    `# t\n${start}\nnew\n${end}\n`
  );
});

test('the real README and CONTRIBUTING blocks are current', async () => {
  const result = await checkDocs();
  assert.deepEqual(result.stale, [], 'run: npm run docs:generate');
  assert.equal(result.ok, true);
});

test('a hand edit inside a generated block fails the check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { start: scriptsStart, end: scriptsEnd } = markers('scripts');
  const { start: suitesStart, end: suitesEnd } = markers('suites');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node serve.mjs', test: 'node --test x' } }));
  await writeFile(join(root, 'README.md'), `# Readme\n\n${scriptsStart}\n\n${scriptsEnd}\n`);
  await writeFile(join(root, 'CONTRIBUTING.md'), `# Contributing\n\n${suitesStart}\n\n${suitesEnd}\n`);

  const built = await buildDocs({ root });
  assert.ok(built.files['README.md'].includes('`node serve.mjs`'));
  await writeDocs({ root });
  assert.deepEqual((await checkDocs({ root })).stale, []);

  const readme = await readFile(join(root, 'README.md'), 'utf8');
  await writeFile(join(root, 'README.md'), readme.replace('`node serve.mjs`', '`node wrong.mjs`'));
  const drifted = await checkDocs({ root });
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.stale, ['README.md'], 'only the hand-edited document is stale');
});

test('the generated blocks are wired into the unit gate', async () => {
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.verify, /node scripts\/build-docs\.mjs --check/);
  assert.equal(pkg.scripts['docs:generate'], 'node scripts/build-docs.mjs --write');
});
