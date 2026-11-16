/**
 * R7-5: the APK version contract is verified on the rendered manifest, not on
 * four build-script lines. A second replaceAll used to keep every assertion
 * green while the shipped manifest said 9.9.9.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderManifest, writeManifest } from '../scripts/build-android.mjs';
import { readProjectFile as read } from './helpers/project-files.mjs';

test('the rendered manifest carries the exact version and no placeholder', () => {
  const template = read('android/AndroidManifest.template.xml');
  const xml = renderManifest(template, { versionName: '2.0.0', versionCode: 20000 });

  assert.doesNotMatch(xml, /@[A-Z][A-Z0-9_]*@/, 'nothing is left for the package manager to interpret');
  assert.match(xml, /android:versionName="2\.0\.0"/);
  assert.match(xml, /android:versionCode="20000"/);
  assert.equal(xml.match(/android:versionName=/g)?.length, 1, 'one version, not a later override');
});

test('the renderer converts a numeric version code and rejects unknown placeholders', () => {
  assert.match(renderManifest('<x code="@VERSION_CODE@"/>', { versionName: '1', versionCode: 7 }), /code="7"/);
  assert.throws(
    () => renderManifest('<manifest @FUTURE_FLAG@/>', { versionName: '1', versionCode: 1 }),
    /unresolved manifest placeholder: @FUTURE_FLAG@/
  );
});

test('the file the build writes is the rendered manifest, not a later edit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'android'), { recursive: true });
  await mkdir(join(directory, 'build'), { recursive: true });
  await writeFile(join(directory, 'android', 'AndroidManifest.template.xml'), read('android/AndroidManifest.template.xml'));

  const written = await writeManifest({
    androidDir: join(directory, 'android'),
    buildDir: join(directory, 'build'),
    versionName: '2.0.0',
    versionCode: 20000,
  });
  const xml = await readFile(written, 'utf8');
  assert.match(xml, /android:versionName="2\.0\.0"/, 'the written file carries pkg.version');
  assert.match(xml, /android:versionCode="20000"/);
  assert.doesNotMatch(xml, /9\.9\.9/, 'no post-render replacement reached the file');
  assert.doesNotMatch(xml, /@[A-Z][A-Z0-9_]*@/);
});

test('the manifest declares the exact permission set and no component it does not need', () => {
  const xml = renderManifest(read('android/AndroidManifest.template.xml'), { versionName: '1.0.0', versionCode: 10000 });

  const permissions = [...xml.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(permissions, [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.BLUETOOTH',
    'android.permission.BLUETOOTH_ADMIN',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.BLUETOOTH_SCAN',
  ], 'the exact set the bridge checks, and nothing else');
  assert.equal(permissions.includes('android.permission.INTERNET'), false, 'the app cannot reach the network');

  for (const component of ['provider', 'service', 'receiver']) {
    assert.equal(new RegExp(`<${component}\\b`).test(xml), false, `the app declares no <${component}>`);
  }
  const activities = [...xml.matchAll(/<activity\b[\s\S]*?>/g)].map((match) => match[0]);
  assert.equal(activities.length, 1, 'one activity');
  assert.match(activities[0], /android:name="\.MainActivity"/);
  assert.match(activities[0], /android:exported="true"/);
  assert.deepEqual([...xml.matchAll(/android:exported="([^"]+)"/g)].map((match) => match[1]), ['true'], 'only the launcher activity is exported');
  assert.match(xml, /android\.intent\.action\.MAIN/);
  assert.match(xml, /android\.intent\.category\.LAUNCHER/);
});

test('the app is not backed up anywhere', () => {
  const xml = renderManifest(read('android/AndroidManifest.template.xml'), { versionName: '1.0.0', versionCode: 10000 });
  assert.match(xml, /android:allowBackup="false"/, 'no cloud or device-to-device copy of the labels or the BLE address');
  assert.doesNotMatch(xml, /android:allowBackup="true"/);
  assert.doesNotMatch(xml, /fullBackupContent|dataExtractionRules/, 'no backup rules are configured either');
});

test('the build resolves the manifest through the one writer', () => {
  const build = read('scripts/build-android.mjs');
  assert.match(build, /await writeManifest\(\{ androidDir, buildDir: staging, versionName: pkg\.version, versionCode \}\)/);
  assert.match(
    build,
    /await writeFile\(output, renderManifest\(template, \{ versionName, versionCode \}\)\)/,
    'writeManifest is the only code that writes the manifest'
  );
  assert.equal((build.match(/await writeFile\(join\(buildDir, 'AndroidManifest\.xml'\)/g) ?? []).length, 0, 'main writes nothing itself');
  // One occurrence of each placeholder: a second replacement after the renderer
  // would be exactly the drift this test exists to catch.
  assert.equal((build.match(/@VERSION_NAME@/g) ?? []).length, 1);
  assert.equal((build.match(/@VERSION_CODE@/g) ?? []).length, 1);
});
