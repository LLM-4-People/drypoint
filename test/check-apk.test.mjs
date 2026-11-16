/**
 * The release checks the built APK, not only its template. These tests drive
 * the pure rules and the composition with an injected unzip/aapt2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  badgingFindings,
  bundledFiles,
  checkApk,
  manifestXmlFindings,
  readPrecache,
  surfaceFindings,
} from '../scripts/check-apk.mjs';
import { DISTRIBUTION_FILES } from '../scripts/lib/distribution.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const manifest = {
  files: ['index.html', 'assets/app.css'],
  digests: { 'index.html': 'a'.repeat(64), 'assets/app.css': 'b'.repeat(64) },
};

test('the bundled surface is exactly the manifest plus the distribution notices', () => {
  assert.deepEqual(bundledFiles(['assets/www/index.html', 'assets/www/assets/app.css', 'AndroidManifest.xml']), [
    'assets/app.css',
    'index.html',
  ]);
  assert.deepEqual(
    surfaceFindings({
      manifest,
      entries: ['assets/www/index.html', 'assets/www/assets/app.css', 'assets/www/LICENSE', 'assets/www/THIRD_PARTY_NOTICES.md'],
    }),
    []
  );
  assert.deepEqual(
    surfaceFindings({ manifest, entries: ['assets/www/index.html'] }).sort(),
    ['assets/www is missing assets/app.css', 'assets/www is missing LICENSE', 'assets/www is missing THIRD_PARTY_NOTICES.md'].sort()
  );
  assert.deepEqual(
    surfaceFindings({
      manifest,
      entries: ['assets/www/index.html', 'assets/www/assets/app.css', 'assets/www/LICENSE', 'assets/www/THIRD_PARTY_NOTICES.md', 'assets/www/leak.txt'],
    }),
    ['assets/www carries an unexpected file leak.txt']
  );
});

test('INTERNET is refused and allowBackup must be false', () => {
  assert.deepEqual(badgingFindings("uses-permission: name='android.permission.BLUETOOTH_CONNECT'"), []);
  assert.deepEqual(badgingFindings("uses-permission: name='android.permission.INTERNET'"), ['the APK requests android.permission.INTERNET']);

  const allowBackupFalse = 'E: application (line=25)\n    A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false';
  assert.deepEqual(manifestXmlFindings(allowBackupFalse), []);
  assert.deepEqual(
    manifestXmlFindings('A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=(type 0x12)0x0'),
    [],
    'older aapt2 prints the typed scalar'
  );
  for (const value of ['true', '(type 0x12)0xffffffff']) {
    assert.ok(manifestXmlFindings(`A: ...allowBackup(0x01010280)=${value}`).length, `${value} is not false`);
  }
  assert.ok(manifestXmlFindings('E: application (line=25)').length, 'an absent attribute is not proof of false');
});

test('the composed check passes a matching APK and fails a real difference', () => {
  const generated = readPrecache();
  const files = [...generated.files, ...DISTRIBUTION_FILES];
  const bytes = new Map(files.map((file) => [file, readFileSync(join(projectRoot, file))]));

  const exec = (command, args) => {
    if (command === 'unzip' && args[0] === '-Z1') return files.map((file) => `assets/www/${file}`).join('\n');
    if (command === 'unzip' && args[0] === '-p') return bytes.get(args[2].replace('assets/www/', ''));
    if (command === 'aapt2' && args[1] === 'badging') {
      return "package: name='dev.llm4people.drypoint'\nuses-permission: name='android.permission.BLUETOOTH_CONNECT'";
    }
    if (command === 'aapt2' && args[1] === 'xmltree') {
      return 'A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=(type 0x12)0x0';
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };

  assert.deepEqual(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec }), { ok: true, findings: [] });

  const tampered = (command, args) =>
    command === 'unzip' && args[0] === '-p' && args[2] === 'assets/www/index.html'
      ? Buffer.from('changed')
      : exec(command, args);
  const failed = checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: tampered });
  assert.equal(failed.ok, false);
  assert.ok(failed.findings.some((finding) => /index\.html does not match/.test(finding)));

  const extra = (command, args) =>
    command === 'unzip' && args[0] === '-Z1'
      ? [...files, 'leak.txt'].map((file) => `assets/www/${file}`).join('\n')
      : exec(command, args);
  assert.ok(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: extra }).findings.some((finding) => /leak\.txt/.test(finding)));

  const internet = (command, args) =>
    command === 'aapt2' && args[1] === 'badging'
      ? "uses-permission: name='android.permission.INTERNET'"
      : exec(command, args);
  assert.ok(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: internet }).findings.some((finding) => /INTERNET/.test(finding)));

  const backups = (command, args) =>
    command === 'aapt2' && args[1] === 'xmltree'
      ? 'A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=true'
      : exec(command, args);
  assert.ok(
    checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: backups }).findings.some((finding) => /allowBackup/.test(finding)),
    'the composed check reads allowBackup, not only the rule function'
  );
});
