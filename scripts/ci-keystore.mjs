#!/usr/bin/env node
/**
 * The one owner of the CI throwaway signing identity.
 *
 * GitHub Actions sets `CI=true` for every step, and `build-android.mjs` treats
 * that as "never invent a release key": a missing keystore is a hard failure.
 * The unprivileged toolchain jobs therefore create an explicit throwaway key
 * *before* the build. This script is that owner; no workflow may spell the
 * password, alias, DN, validity or keytool argv itself.
 *
 * The key is for the unsigned artifact and the pull-request gate only. The
 * release `sign` job never runs this script and never sets
 * `ANDROID_ALLOW_TEST_KEY`.
 *
 * Usage (GitHub Actions only):
 *   node scripts/ci-keystore.mjs
 *
 * `RUNNER_TEMP` and `GITHUB_ENV` are required and missing values fail closed;
 * there is no fallback into `$HOME` or the repository. The password goes into a
 * 0600 file, the keytool password is a file path, never an argument, the
 * keystore is chmod 600, and the password file is deleted in a `finally`.
 */

import { execFileSync } from 'node:child_process';
import { appendFile, chmod, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The throwaway identity. The certificate pin is relaxed only by this flag. */
export const THROWAWAY = Object.freeze({
  alias: 'ci',
  password: 'ci-throwaway-not-a-release-key',
  dn: 'CN=CI Throwaway, O=LLM-4-People, C=CA',
  validityDays: 1,
});

/** The five variables the build reads, and the one flag that permits the key. */
export const KEYSTORE_VARIABLES = Object.freeze([
  'ANDROID_KEYSTORE_FILE',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEYSTORE_KEY_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_ALLOW_TEST_KEY',
]);

/**
 * One value per line in `$GITHUB_ENV`. A newline in a value would inject a
 * second variable, so the writer refuses it instead of trusting the constants.
 */
function envLine(name, value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error(`${name} must not contain a newline`);
  return `${name}=${text}`;
}

/** A required Actions variable; a missing one is a clear nonzero failure. */
export function requiredEnv(env, name) {
  const value = env?.[name];
  if (!value) throw new Error(`${name} is required; this script runs only inside GitHub Actions`);
  return value;
}

/**
 * The two paths the script owns. Both derive from `RUNNER_TEMP`; a missing
 * variable never falls back to the repository or the home directory.
 */
export function ciKeystorePaths({ env = process.env } = {}) {
  const runnerTemp = requiredEnv(env, 'RUNNER_TEMP');
  const githubEnv = requiredEnv(env, 'GITHUB_ENV');
  return {
    keystore: join(runnerTemp, 'ci-release.jks'),
    passwordFile: join(runnerTemp, 'ci-pass.txt'),
    githubEnv,
  };
}

/** keytool argv; the password is only ever a file path. */
export function keytoolArgs({ keystore, passwordFile }) {
  return [
    '-genkeypair',
    '-keystore', keystore,
    '-alias', THROWAWAY.alias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', String(THROWAWAY.validityDays),
    '-storepass:file', passwordFile,
    '-keypass:file', passwordFile,
    '-dname', THROWAWAY.dn,
  ];
}

/** The exactly five `$GITHUB_ENV` lines the build consumes. */
export function githubEnvLines({ keystore }) {
  return [
    envLine('ANDROID_KEYSTORE_FILE', keystore),
    envLine('ANDROID_KEYSTORE_PASSWORD', THROWAWAY.password),
    envLine('ANDROID_KEYSTORE_KEY_PASSWORD', THROWAWAY.password),
    envLine('ANDROID_KEY_ALIAS', THROWAWAY.alias),
    envLine('ANDROID_ALLOW_TEST_KEY', 'true'),
  ];
}

/**
 * Create the throwaway keystore and export it to the rest of the job.
 *
 * `exec` is injectable so a test can drive a fake keytool. The password file is
 * deleted whether keytool succeeds or fails; a failing keytool propagates and
 * the CLI exits nonzero.
 */
export async function createKeystore({ env = process.env, keytool = env.KEYTOOL || 'keytool', exec = execFileSync } = {}) {
  const paths = ciKeystorePaths({ env });
  try {
    await writeFile(paths.passwordFile, THROWAWAY.password, { mode: 0o600 });
    await chmod(paths.passwordFile, 0o600);
    exec(keytool, keytoolArgs(paths), { stdio: 'inherit' });
    await chmod(paths.keystore, 0o600);
    await appendFile(paths.githubEnv, `${githubEnvLines(paths).join('\n')}\n`);
    console.log(`ci-keystore: created the throwaway key at ${paths.keystore}`);
    return paths;
  } finally {
    await rm(paths.passwordFile, { force: true });
  }
}

async function main() {
  try {
    await createKeystore();
    return 0;
  } catch (error) {
    console.error(`ci-keystore: ${error.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
