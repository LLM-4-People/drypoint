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
