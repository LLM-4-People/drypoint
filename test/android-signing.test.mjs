/**
 * R7-10: a signing password must never be readable from the process table.
 * keytool and apksigner accept a file path, so the secret lives in a 0600 file
 * that is deleted in a `finally`; the argv holds only paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';

import {
  KEYSTORE_DN,
  apksignerArgs,
  keystoreAction,
  keytoolArgs,
  resolveKeystore,
  withPasswordFiles,
} from '../scripts/build-android.mjs';
import { readProjectFile as read } from './helpers/project-files.mjs';

test('passwords live in 0600 files that are deleted afterwards', async () => {
  const secret = 's3cr3t-never-on-a-command-line';
  let observed = null;
  const result = await withPasswordFiles({ store: secret, key: `${secret}-key` }, async (files) => {
    for (const file of Object.values(files)) {
      const info = await stat(file);
      assert.equal(info.isFile(), true);
      assert.equal(info.mode & 0o777, 0o600, `${file} is readable only by this user`);
    }
    observed = files;
    return 'signed';
  });

  assert.equal(result, 'signed');
  await assert.rejects(stat(observed.store), { code: 'ENOENT' }, 'the temporary directory is gone');
});

test('the temporary files are removed even when signing fails', async () => {
  let observed;
  await assert.rejects(
    withPasswordFiles({ store: 'secret' }, async (files) => {
      observed = files;
      throw new Error('apksigner rejected the key');
    }),
    /apksigner rejected the key/
  );
  await assert.rejects(stat(observed.store), { code: 'ENOENT' });
});

test('keytool and apksigner receive paths, never a password', () => {
  const secret = 's3cr3t-never-on-a-command-line';
  const files = { store: '/tmp/drypoint-sign/store.txt', key: '/tmp/drypoint-sign/key.txt', ks: '/tmp/drypoint-sign/ks.txt' };
  const keytool = keytoolArgs({ store: '/keys/release.jks', keyAlias: 'drypoint', files: { store: files.store, key: files.key } });
  const signer = apksignerArgs({ store: '/keys/release.jks', keyAlias: 'drypoint', files: { ks: files.ks, key: files.key }, out: '/out.apk', aligned: '/aligned.apk' });

  for (const argument of [...keytool, ...signer]) {
    assert.equal(argument.includes(secret), false, 'no password in argv');
    assert.equal(/^pass:/.test(argument), false, 'no inline pass: secret');
  }
  assert.ok(keytool.includes('-storepass:file'), 'keytool reads the store password from a file');
  assert.ok(keytool.includes('-keypass:file'), 'and the key password too');
  assert.ok(keytool.includes(files.store));

  const value = (flag) => signer[signer.indexOf(flag) + 1];
  assert.match(value('--ks-pass'), /^file:/, 'apksigner reads a file path');
  assert.match(value('--key-pass'), /^file:/);
});

/* ---------------- A3: the public release identity ---------------- */

test('the release identity is Drypoint, with no old-name fallback', () => {
  const resolved = resolveKeystore({ env: {}, properties: {}, directory: '/keys' });
  assert.equal(resolved.store, '/keys/drypoint-release.jks');
  assert.equal(resolved.keyAlias, 'drypoint');
  assert.equal(resolved.storePassword, undefined, 'no password is invented by the resolver');
  assert.equal(KEYSTORE_DN, 'CN=Drypoint, O=LLM-4-People, C=CA');
  assert.ok(keytoolArgs({ store: '/keys/drypoint-release.jks', keyAlias: 'drypoint', files: {} }).includes(KEYSTORE_DN));
  assert.doesNotMatch(read('scripts/build-android.mjs'), /D110_KEYSTORE|D110_KEY_ALIAS|d110-release|d110-sign/);
});

test('the environment overrides the properties file', () => {
  const resolved = resolveKeystore({
    env: {
      ANDROID_KEYSTORE_FILE: '/secret/release.jks',
      ANDROID_KEYSTORE_PASSWORD: 'env-store',
      ANDROID_KEYSTORE_KEY_PASSWORD: 'env-key',
      ANDROID_KEY_ALIAS: 'env-alias',
    },
    properties: { storePassword: 'props-store', keyPassword: 'props-key', keyAlias: 'props-alias' },
  });
  assert.deepEqual(resolved, {
    store: '/secret/release.jks',
    storePassword: 'env-store',
    keyPassword: 'env-key',
    keyAlias: 'env-alias',
  });
  assert.equal(
    resolveKeystore({ env: {}, properties: { storePassword: 'props-store', keyAlias: 'props-alias' }, directory: '/keys' }).keyPassword,
    'props-store',
    'the key password falls back to the store password'
  );
});

test('a missing key is generated locally but is fatal in CI or with --require-key', () => {
  assert.equal(keystoreAction({ exists: true, requireKey: true }), 'use');
  assert.equal(keystoreAction({ exists: true, requireKey: false }), 'use');
  assert.equal(keystoreAction({ exists: false, requireKey: false }), 'generate');
  assert.equal(keystoreAction({ exists: false, requireKey: true }), 'fail');
});
