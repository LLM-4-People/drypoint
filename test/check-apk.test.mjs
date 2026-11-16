/**
 * The release checks the built APK, not only its template. These tests drive
 * the pure rules and the composition with an injected unzip/aapt2/apksigner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  badgingFindings,
  bundledFiles,
  checkApk,
  expectedIdentity,
  manifestXmlFindings,
  platformExpectations,
  platformFindings,
  readPrecache,
  signatureFindings,
  surfaceFindings,
} from '../scripts/check-apk.mjs';
import { DISTRIBUTION_FILES } from '../scripts/lib/distribution.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const manifest = {
  files: ['index.html', 'assets/app.css'],
  digests: { 'index.html': 'a'.repeat(64), 'assets/app.css': 'b'.repeat(64) },
};

/** The identity the release must carry, read from its two owners. */
const IDENTITY = expectedIdentity();

const BADGING = [
  `package: name='${IDENTITY.package}' versionCode='${IDENTITY.versionCode}' versionName='${IDENTITY.versionName}'`,
  "sdkVersion:'26' targetSdkVersion:'34'",
  "uses-permission: name='android.permission.BLUETOOTH_CONNECT'",
  `launchable-activity: name='${IDENTITY.package}.MainActivity' label='' icon=''`,
].join('\n');

const XMLTREE = [
  'E: manifest (line=2)',
  '  E: application (line=25)',
  '    A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false',
  '    E: activity (line=28)',
  '      A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true',
  '      E: intent-filter (line=30)',
  '        E: action (line=31)',
  '          A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.MAIN"',
  '        E: category (line=32)',
  '          A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.category.LAUNCHER"',
].join('\n');

const VERIFIED = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): false',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
].join('\n');

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

test('INTERNET in either permission form and the launcher count are checked', () => {
  assert.deepEqual(badgingFindings(BADGING), []);
  assert.deepEqual(badgingFindings(BADGING.replace("uses-permission: name='android.permission.BLUETOOTH_CONNECT'", "uses-permission: name='android.permission.INTERNET'")), [
    'the APK requests android.permission.INTERNET',
  ]);
  assert.deepEqual(
    badgingFindings(
      BADGING.replace(
        "uses-permission: name='android.permission.BLUETOOTH_CONNECT'",
        "uses-permission-sdk-23: name='android.permission.INTERNET'"
      )
    ),
    ['the APK requests android.permission.INTERNET'],
    'the API-23 form applies at minSdk 26'
  );
  const twoLaunchers = `${BADGING}\nlaunchable-activity: name='dev.llm4people.drypoint.Second' label='' icon=''`;
  assert.ok(badgingFindings(twoLaunchers).some((finding) => /exactly one MAIN\/LAUNCHER activity, found 2/.test(finding)));
  assert.ok(badgingFindings("package: name='x'").some((finding) => /found 0/.test(finding)), 'a launcher is required');
});

test('the badging must carry the exact package, versionCode and versionName', () => {
  const expected = expectedIdentity();
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(expected.package, 'dev.llm4people.drypoint', 'the package comes from brand.json');
  assert.equal(expected.versionName, pkg.version, 'the version name comes from package.json');
  assert.equal(expected.versionCode, 10000 + Number(pkg.version.split('.')[1]) * 10 + Number(pkg.version.split('.')[2]), 'the version code is the one formula');
  assert.deepEqual(badgingFindings(BADGING, expected), []);
  const cases = [
    ['versionCode 1', BADGING.replace(`versionCode='${expected.versionCode}'`, "versionCode='1'"), new RegExp(`versionCode ${expected.versionCode}`)],
    ['wrong package', BADGING.replace(expected.package, 'dev.example.other'), /not dev\.llm4people\.drypoint/],
    ['wrong versionName', BADGING.replace(`versionName='${expected.versionName}'`, "versionName='9.9.9'"), new RegExp(`not dev\\.llm4people\\.drypoint ${expected.versionName.replaceAll('.', '\\.')}`)],
  ];
  for (const [name, text, pattern] of cases) {
    assert.ok(badgingFindings(text, expected).some((finding) => pattern.test(finding)), `${name} is rejected`);
  }
  // The composed check uses the same identity, so a hard-coded positive
  // versionCode cannot pass the release artifact check.
  const files = [...readPrecache().files, ...DISTRIBUTION_FILES];
  const bytes = new Map(files.map((file) => [file, readFileSync(join(projectRoot, file))]));
  const exec = (command, args) => {
    if (command === 'unzip' && args[0] === '-Z1') return files.map((file) => `assets/www/${file}`).join('\n');
    if (command === 'unzip' && args[0] === '-p') return bytes.get(args[2].replace('assets/www/', ''));
    if (command === 'aapt2' && args[1] === 'badging') return BADGING.replace(`versionCode='${expected.versionCode}'`, "versionCode='1'");
    if (command === 'aapt2' && args[1] === 'xmltree') return XMLTREE;
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const result = checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes(`versionCode ${expected.versionCode}`)));
});

test('the badging must carry the platform levels the template owns', () => {
  const platform = platformExpectations();
  assert.deepEqual(platform, { minSdkVersion: 26, targetSdkVersion: 34 });
  assert.deepEqual(platformFindings(BADGING, platform), []);
  const cases = [
    ['minSdk', BADGING.replace("sdkVersion:'26'", "sdkVersion:'25'"), /reports minSdkVersion 25, expected 26/],
    ['targetSdk', BADGING.replace("targetSdkVersion:'34'", "targetSdkVersion:'33'"), /reports targetSdkVersion 33, expected 34/],
    ['missing min', BADGING.replace("sdkVersion:'26' ", ''), /does not report sdkVersion/],
    ['missing target', BADGING.replace(" targetSdkVersion:'34'", ''), /does not report targetSdkVersion/],
  ];
  for (const [name, text, pattern] of cases) {
    assert.ok(platformFindings(text, platform).some((finding) => pattern.test(finding)), `${name} is rejected`);
  }
});

test('the binary manifest enforces every component, debuggable and cleartext rule', () => {
  assert.deepEqual(manifestXmlFindings(XMLTREE), []);
  assert.deepEqual(
    manifestXmlFindings(XMLTREE.replace('allowBackup(0x01010280)=false', 'allowBackup(0x01010280)=(type 0x12)0x0')),
    [],
    'older aapt2 prints the typed scalar'
  );

  const cases = [
    ['allowBackup', XMLTREE.replace('allowBackup(0x01010280)=false', 'allowBackup(0x01010280)=true'), /allowBackup="false"/],
    ['debuggable', XMLTREE.replace('E: application (line=25)', 'E: application (line=25)\n    A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true'), /debuggable/],
    [
      'cleartext',
      XMLTREE.replace('E: application (line=25)', 'E: application (line=25)\n    A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=true'),
      /usesCleartextTraffic/,
    ],
    ['provider', XMLTREE.replace('    E: activity', '    E: provider (line=26)\n    E: activity'), /provider/],
    ['service', XMLTREE.replace('    E: activity', '    E: service (line=26)\n    E: activity'), /service/],
    ['receiver', XMLTREE.replace('    E: activity', '    E: receiver (line=26)\n    E: activity'), /receiver/],
    [
      'second activity',
      XMLTREE.replace('    E: activity (line=28)', '    E: activity (line=27)\n    E: activity (line=28)'),
      /exactly one activity, found 2/,
    ],
    [
      'second exported',
      XMLTREE.replace('=true', '=true\n    A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true'),
      /exactly one exported component, found 2/,
    ],
    [
      'no MAIN',
      XMLTREE.replace('android.intent.action.MAIN', 'android.intent.action.VIEW'),
      /no android.intent.action.MAIN/,
    ],
    [
      'no LAUNCHER',
      XMLTREE.replace('android.intent.category.LAUNCHER', 'android.intent.category.DEFAULT'),
      /no android.intent.category.LAUNCHER/,
    ],
    [
      'INTERNET',
      XMLTREE.replace('E: manifest (line=2)', "E: manifest (line=2)\n  E: uses-permission\n    A: name=\"android.permission.INTERNET\""),
      /INTERNET/,
    ],
  ];
  for (const [name, text, pattern] of cases) {
    assert.ok(manifestXmlFindings(text).some((finding) => pattern.test(finding)), `${name} is rejected`);
  }
});

test('v2 and v3 must both be verified; v1 may be false at minSdk 26', () => {
  assert.deepEqual(signatureFindings(VERIFIED), []);
  assert.ok(signatureFindings(VERIFIED.replace('v2 scheme (APK Signature Scheme v2): true', 'v2 scheme (APK Signature Scheme v2): false')).some((finding) => /v2/.test(finding)));
  assert.ok(signatureFindings(VERIFIED.replace('v3 scheme (APK Signature Scheme v3): true', 'v3 scheme (APK Signature Scheme v3): false')).some((finding) => /v3/.test(finding)));
  assert.deepEqual(signatureFindings(VERIFIED.replace('v1 scheme (JAR signing): false', 'v1 scheme (JAR signing): true')), []);
});

test('the composed check passes a matching APK and fails each planted rule', () => {
  const generated = readPrecache();
  const files = [...generated.files, ...DISTRIBUTION_FILES];
  const bytes = new Map(files.map((file) => [file, readFileSync(join(projectRoot, file))]));

  const exec = (command, args) => {
    if (command === 'unzip' && args[0] === '-Z1') return files.map((file) => `assets/www/${file}`).join('\n');
    if (command === 'unzip' && args[0] === '-p') return bytes.get(args[2].replace('assets/www/', ''));
    if (command === 'aapt2' && args[1] === 'badging') return BADGING;
    if (command === 'aapt2' && args[1] === 'xmltree') return XMLTREE;
    if (command === 'apksigner' && args[0] === 'verify') return VERIFIED;
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };

  assert.deepEqual(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', apksigner: 'apksigner', exec }), { ok: true, findings: [] });
  assert.deepEqual(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec }), { ok: true, findings: [] }, 'signatures are checked only when requested');

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

  const internet23 = (command, args) =>
    command === 'aapt2' && args[1] === 'badging'
      ? BADGING.replace("uses-permission: name='android.permission.BLUETOOTH_CONNECT'", "uses-permission-sdk-23: name='android.permission.INTERNET'")
      : exec(command, args);
  assert.ok(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: internet23 }).findings.some((finding) => /INTERNET/.test(finding)));

  const debug = (command, args) =>
    command === 'aapt2' && args[1] === 'xmltree'
      ? XMLTREE.replace('E: application (line=25)', 'E: application (line=25)\n    A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true')
      : exec(command, args);
  assert.ok(checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: debug }).findings.some((finding) => /debuggable/.test(finding)));

  const unsigned = (command, args) =>
    command === 'apksigner' && args[0] === 'verify'
      ? VERIFIED.replace('v2 scheme (APK Signature Scheme v2): true', 'v2 scheme (APK Signature Scheme v2): false')
      : exec(command, args);
  assert.ok(
    checkApk({ apk: 'fake.apk', aapt2: 'aapt2', apksigner: 'apksigner', exec: unsigned }).findings.some((finding) => /v2/.test(finding)),
    'the composed check reads the signature, not only the rule function'
  );

  // A missing entry must name the surface rule, not abort on `unzip -p`.
  const missing = (command, args) =>
    command === 'unzip' && args[0] === '-Z1'
      ? files.filter((file) => file !== 'src/core/dom.js').map((file) => `assets/www/${file}`).join('\n')
      : exec(command, args);
  const missingResult = checkApk({ apk: 'fake.apk', aapt2: 'aapt2', exec: missing });
  assert.ok(
    missingResult.findings.some((finding) => /assets\/www is missing src\/core\/dom\.js/.test(finding)),
    'the missing file is named by the surface rule'
  );

  // `apksigner` exits nonzero for a v1-only or otherwise unverifiable APK.
  // The scheme finding and the tool failure both survive the exception.
  const unverifiable = (command, args) => {
    if (command === 'apksigner' && args[0] === 'verify') {
      const error = new Error('Command failed');
      error.stdout = VERIFIED.replace('v2 scheme (APK Signature Scheme v2): true', 'v2 scheme (APK Signature Scheme v2): false');
      error.stderr = 'DOES NOT VERIFY';
      throw error;
    }
    return exec(command, args);
  };
  const unverifiableResult = checkApk({ apk: 'fake.apk', aapt2: 'aapt2', apksigner: 'apksigner', exec: unverifiable });
  assert.ok(
    unverifiableResult.findings.some((finding) => /no verified v2 signature/.test(finding)),
    'the signature rule is named instead of a bare RangeError'
  );
  assert.ok(
    unverifiableResult.findings.some((finding) => /apksigner could not verify/.test(finding)),
    'the tool failure is named'
  );
});
