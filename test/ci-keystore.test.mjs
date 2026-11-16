/**
 * The CI throwaway keystore has one owner. These tests drive the CLI against a
 * fake keytool, so they prove the file modes, the exported variables, the
 * cleanup and the fail-closed behaviour without a JDK or a real key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEYSTORE_VARIABLES,
  THROWAWAY,
  ciKeystorePaths,
  createKeystore,
  githubEnvLines,
  keytoolArgs,
  requiredEnv,
} from '../scripts/ci-keystore.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const SCRIPT = join(projectRoot, 'scripts', 'ci-keystore.mjs');

/** A fake keytool that records argv and creates the keystore at the path it is given. */
async function fakeKeytool(t, { create = true, fail = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-keytool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'argv.log');
  const tool = join(directory, 'keytool');
  const body = [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$KEYTOOL_LOG"',
    ...(fail ? ['exit 1'] : []),
    ...(create
      ? [
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = -keystore ]; then',
          '    shift',
          '    printf "store" > "$1"',
          '    chmod 644 "$1"',
          '    break',
          '  fi',
          '  shift',
          'done',
        ]
      : []),
    'exit 0',
    '',
  ].join('\n');
  await writeFile(tool, body, { mode: 0o755 });
  await chmod(tool, 0o755);
  return { directory, log, tool };
}

function runCli(env) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, ...env },
      }),
    };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('keytool argv uses the throwaway identity and never the password', () => {
  const args = keytoolArgs({ keystore: '/tmp/ci.jks', passwordFile: '/tmp/pass.txt' });
  for (const flag of ['-genkeypair', '-keystore', '-alias', '-keyalg', '-keysize', '-validity', '-storepass:file', '-keypass:file', '-dname']) {
    assert.ok(args.includes(flag), `${flag} is present`);
  }
  assert.equal(args[args.indexOf('-alias') + 1], THROWAWAY.alias);
  assert.equal(args[args.indexOf('-keyalg') + 1], 'RSA');
  assert.equal(args[args.indexOf('-keysize') + 1], '2048');
  assert.equal(args[args.indexOf('-validity') + 1], '1');
  assert.equal(args[args.indexOf('-dname') + 1], THROWAWAY.dn);
  assert.equal(args[args.indexOf('-storepass:file') + 1], '/tmp/pass.txt');
  assert.equal(args[args.indexOf('-keypass:file') + 1], '/tmp/pass.txt');
  for (const argument of args) {
    assert.equal(argument.includes(THROWAWAY.password), false, 'the password is never an argument');
  }
});

test('the exported environment is exactly the five variables the build reads', () => {
  const lines = githubEnvLines({ keystore: '/tmp/ci.jks' });
  assert.equal(lines.length, KEYSTORE_VARIABLES.length);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf('='))),
    [...KEYSTORE_VARIABLES]
  );
  assert.ok(lines.includes('ANDROID_KEYSTORE_FILE=/tmp/ci.jks'));
  assert.ok(lines.includes(`ANDROID_KEYSTORE_PASSWORD=${THROWAWAY.password}`));
  assert.ok(lines.includes(`ANDROID_KEYSTORE_KEY_PASSWORD=${THROWAWAY.password}`));
  assert.ok(lines.includes(`ANDROID_KEY_ALIAS=${THROWAWAY.alias}`));
  assert.ok(lines.includes('ANDROID_ALLOW_TEST_KEY=true'));
});

test('a missing RUNNER_TEMP or GITHUB_ENV is a clear failure, never a default', () => {
  for (const [env, name] of [
    [{ GITHUB_ENV: '/tmp/env' }, 'RUNNER_TEMP'],
    [{ RUNNER_TEMP: '/tmp' }, 'GITHUB_ENV'],
  ]) {
    assert.throws(() => requiredEnv(env, name), new RegExp(`${name} is required`));
    assert.throws(() => ciKeystorePaths({ env }), new RegExp(`${name} is required`));
  }
  assert.throws(() => ciKeystorePaths({ env: { RUNNER_TEMP: '', GITHUB_ENV: '/tmp/env' } }), /RUNNER_TEMP is required/);
});

test('the CLI creates a 0600 keystore, exports the five lines and removes the password', async (t) => {
  const fake = await fakeKeytool(t);
  const runnerTemp = fake.directory;
  const githubEnv = join(fake.directory, 'github-env');
  const passwordFile = join(runnerTemp, 'ci-pass.txt');
  const keystore = join(runnerTemp, 'ci-release.jks');
  await writeFile(githubEnv, '');

  const result = runCli({ RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, KEYTOOL: fake.tool, KEYTOOL_LOG: fake.log });
  assert.equal(result.status, 0, result.stderr);

  const argv = (await readFile(fake.log, 'utf8')).trim().split('\n');
  assert.ok(argv.includes('-genkeypair'));
  assert.equal(argv.includes(THROWAWAY.password), false, 'the password never reaches argv');
  assert.equal((await stat(keystore)).mode & 0o777, 0o600, 'the keystore is 0600');
  assert.equal(await exists(passwordFile), false, 'the password file is gone');

  const exported = (await readFile(githubEnv, 'utf8')).trim().split('\n');
  assert.deepEqual(exported, githubEnvLines({ keystore }));
  assert.equal(exported.length, 5);
});

test('a failing keytool exits nonzero and leaves no password file', async (t) => {
  const fake = await fakeKeytool(t, { create: false, fail: true });
  const githubEnv = join(fake.directory, 'github-env');
  await writeFile(githubEnv, '');
  const result = runCli({ RUNNER_TEMP: fake.directory, GITHUB_ENV: githubEnv, KEYTOOL: fake.tool, KEYTOOL_LOG: fake.log });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ci-keystore:/);
  assert.equal(await exists(join(fake.directory, 'ci-pass.txt')), false, 'the password file is gone');
});

test('the CLI fails closed when an Actions variable is missing', async () => {
  for (const [env, name] of [
    [{ GITHUB_ENV: '/tmp/env' }, 'RUNNER_TEMP'],
    [{ RUNNER_TEMP: '/tmp' }, 'GITHUB_ENV'],
  ]) {
    const result = runCli(env);
    assert.notEqual(result.status, 0, `${name}: exit nonzero`);
    assert.match(result.stderr, new RegExp(`${name} is required`), `${name}: the message names the variable`);
  }
});

test('createKeystore is injectable and cleans up on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-keystore-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, 'env');
  await writeFile(githubEnv, '');
  const calls = [];
  await assert.rejects(
    createKeystore({
      env: { RUNNER_TEMP: directory, GITHUB_ENV: githubEnv },
      keytool: 'fake-keytool',
      exec: (command, args) => {
        calls.push([command, args]);
        throw new Error('keytool exploded');
      },
    }),
    /keytool exploded/
  );
  assert.equal(calls.length, 1);
  assert.equal(await exists(join(directory, 'ci-pass.txt')), false);
  assert.equal((await readFile(githubEnv, 'utf8')).trim(), '', 'a failed keytool exports nothing');
});
