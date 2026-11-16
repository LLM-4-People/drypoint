/**
 * The publish command is workflow-owned, so the test executes the command the
 * workflow actually runs instead of re-typing it.
 *
 * A temporary `gh` shim records its argv. That proves the flags and assets are
 * on the real command, that the tag comes from `$TAG` and never
 * `GITHUB_REF_NAME`, and that an empty tag fails the step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishCommands } from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const dist = join(root, 'dist');
  await Promise.all([mkdir(bin), mkdir(dist)]);
  const log = join(root, 'gh.log');
  await writeFile(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'if [ "$1" = release ] && [ "$2" = create ] && [ -z "$3" ]; then',
      '  echo "missing tag" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await chmod(join(bin, 'gh'), 0o755);
  for (const name of ['drypoint-1.0.3.apk', 'drypoint-1.0.3.apk.sha256', 'drypoint-1.0.3.apk.intoto.jsonl', 'notes.md']) {
    await writeFile(join(dist, name), 'x');
  }
  return { root, bin, dist, log };
}

function env({ bin, dist, log }, tag) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: log,
    GITHUB_REF_NAME: 'decoy-branch',
    TAG: tag,
    VERSION: '1.0.3',
    apk: join(dist, 'drypoint-1.0.3.apk'),
    checksum: join(dist, 'drypoint-1.0.3.apk.sha256'),
    bundle: join(dist, 'drypoint-1.0.3.apk.intoto.jsonl'),
    notes: join(dist, 'notes.md'),
  };
}

function run(command, environment) {
  return execFileSync('bash', ['-c', command], { env: environment, encoding: 'utf8', stdio: 'pipe' });
}

test('the real publish command verifies the tag and passes every release asset', async (t) => {
  const release = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
  const [command, ...extra] = publishCommands(release);
  assert.equal(extra.length, 0, 'the workflow has one publish command');
  assert.ok(command, 'the publish command is extractable');
  assert.doesNotMatch(command, /GITHUB_REF_NAME/, 'the workflow command uses $TAG');

  const paths = await harness(t);
  run(command, env(paths, 'v1.0.3'));
  const args = (await readFile(paths.log, 'utf8')).trim().split(' ').filter(Boolean);
  assert.equal(args[0], 'release');
  assert.equal(args[1], 'create');
  assert.equal(args[2], 'v1.0.3', 'the tag argument is $TAG');
  assert.ok(args.includes('--verify-tag'), '--verify-tag is on the real command');
  for (const asset of ['drypoint-1.0.3.apk', 'drypoint-1.0.3.apk.sha256', 'drypoint-1.0.3.apk.intoto.jsonl']) {
    assert.ok(args.some((argument) => argument.endsWith(asset)), `${asset} is attached`);
  }
  assert.ok(args.includes('--latest'));
  assert.ok(args.includes('--notes-file'));
  assert.equal(args.includes('decoy-branch'), false, 'GITHUB_REF_NAME never reaches the command');
});

test('an empty tag makes the real publish command fail', async (t) => {
  const release = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
  const [command] = publishCommands(release);
  const paths = await harness(t);
  assert.throws(
    () => run(command, env(paths, '')),
    (error) => error.status !== 0 && /missing tag/.test(`${error.stdout}${error.stderr}`),
    'the command cannot publish without a tag'
  );
});
