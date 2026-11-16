import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, cp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishApk, publishApkPair, sdkDirs } from '../scripts/build-android.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('an explicit SDK version wins over the alphabetically newest directory', () => {
  const chosen = sdkDirs({
    sdk: '/sdk',
    buildTools: '36.0.0',
    platform: 'android-36',
    latest: () => '99.0.0-preview',
    exists: () => true,
  });
  assert.equal(chosen.buildToolsName, '36.0.0');
  assert.equal(chosen.platformName, 'android-36');
  assert.equal(chosen.ok, true);
  assert.match(chosen.buildToolsDir, /build-tools[/\\]36\.0\.0$/);
  assert.match(chosen.platformDir, /platforms[/\\]android-36$/);
});

test('without an explicit version the newest installed directory is used', () => {
  const chosen = sdkDirs({
    sdk: '/sdk',
    buildTools: '',
    platform: '',
    latest: (dir) => (dir.endsWith('build-tools') ? '35.0.0' : 'android-35'),
    exists: () => true,
  });
  assert.equal(chosen.buildToolsName, '35.0.0');
  assert.equal(chosen.platformName, 'android-35');
  assert.equal(chosen.ok, true);
});

test('a requested SDK package that is not installed is reported, never silently substituted', () => {
  const chosen = sdkDirs({
    sdk: '/sdk',
    buildTools: '36.0.0',
    platform: 'android-36',
    latest: () => '35.0.0',
    exists: (path) => path.includes('android-35') || path.includes('35.0.0'),
  });
  assert.equal(chosen.ok, false, 'the missing pinned directories must not fall back');
  assert.equal(chosen.buildToolsName, '36.0.0');
  assert.equal(chosen.platformName, 'android-36');
});

test('the native bridge exposes exactly the methods the web transport calls', () => {
  const java = read('android/app/src/main/java/dev/llm4people/drypoint/BleBridge.java');
  const transport = read('src/device/transports/android.js');

  const exposed = new Set([...java.matchAll(/@JavascriptInterface\s+public\s+[\w<>\[\]]+\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const used = new Set([
    ...[...transport.matchAll(/api\.(\w+)\s*\(/g)].map((m) => m[1]),
    ...[...transport.matchAll(/call\('(\w+)'/g)].map((m) => m[1]),
  ]);
  // Methods called through the bridge() result are read directly.
  used.add('lastDevice');
  used.add('disconnect');
  used.add('write');
  used.add('saveFile');

  assert.ok(exposed.has('pickDevice') && exposed.has('connect'), 'the picker and connect entry points exist');
  for (const method of used) assert.ok(exposed.has(method), `Java exposes ${method}`);
  assert.ok(used.has('forgetDevice'), 'the saved selection can be forgotten');
  assert.ok(used.has('cancelPick'), 'an abandoned picker can be dismissed');
  assert.match(java, /public void forgetDevice\(\)\s*\{\s*prefs\.edit\(\)\.remove\("lastDevice"\)/, 'forgetting removes the saved key');
  assert.match(java, /public void cancelPick\(\)/, 'the picker lifetime is owned natively too');
  assert.equal(used.size, 8, 'the transport uses the eight documented bridge calls');
  // The ninth method is not a transport call: the page theme owns the colour.
  assert.ok(exposed.has('setSystemBars'), 'the shell can follow the page theme');
  assert.match(java, /setSystemBars\(String colorHex\)[\s\S]*matches\("#\[0-9a-fA-F\]\{6\}"\)/, 'only a CSS hex colour is forwarded');
});

test('the shell derives the request host from the one origin constant', () => {
  const activity = read('android/app/src/main/java/dev/llm4people/drypoint/MainActivity.java');
  assert.match(activity, /private static final String HOST = hostOf\(ORIGIN\)/);
  assert.match(activity, /new java\.net\.URL\(origin\)\.getHost\(\)/);
  assert.match(activity, /HOST\.equals\(url\.getHost\(\)\)/, 'the request check uses the derived host');
  assert.doesNotMatch(activity, /"drypoint\.local"\.equals/, 'the host is not maintained twice');
});

test('the Android manifest requests the BLE permissions the bridge checks', () => {
  const manifest = read('android/AndroidManifest.template.xml');
  for (const permission of ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_FINE_LOCATION']) {
    assert.match(manifest, new RegExp(`android.permission.${permission}`));
  }
  assert.match(manifest, /usesPermissionFlags="neverForLocation"/);
  assert.match(manifest, /android:minSdkVersion="26"/);
});

test('the Android build bundles the generated precache list, not a copied file list', () => {
  const script = read('scripts/build-android.mjs');
  assert.match(script, /__PRECACHE/);
  assert.match(script, /'-A', assetsRoot/, 'aapt2 packages the fresh staged assets root');
  assert.doesNotMatch(script, /join\(appDir, 'assets'\)/, 'the source tree is never the package root');
  assert.match(script, /mkdtemp\(join\(androidDir, 'build-'\)\)/, 'the build happens in a scratch directory');
  assert.doesNotMatch(script, /rm\(buildDir/, 'the published build directory is never deleted before a verified replacement');
  assert.match(script, /await publishApkPair\(\{ signed: signedInStaging, versioned, stable, verify \}\)/);
  assert.doesNotMatch(script, /await publishApk\(\{ signed: signedInStaging/, 'one transactional publish, not two independent ones');
  assert.match(script, /precache\.mjs/);
  assert.match(script, /apksigner/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:android'], 'node scripts/build-android.mjs');
});

test('the Android shell skips the service worker and routes exports through the bridge', () => {
  const main = read('src/main.js');
  assert.match(main, /bootOfflineShell\(\{/);
  assert.match(main, /isAndroidShell: Boolean\(window\.NiimbotBLE\)/, 'the shell never registers a worker');
  const dom = read('src/core/dom.js');
  assert.match(dom, /window\.NiimbotBLE/);
  assert.match(dom, /saveFile/);
});

test('the stable APK name is published only by an atomic rename of a verified copy', async () => {
  const events = [];
  await publishApk({
    signed: '/build/drypoint-1.0.0.apk',
    stable: '/build/drypoint.apk',
    verify: async (file, label) => {
      events.push({ kind: 'verify', file, label });
    },
    copy: async (from, to) => {
      events.push({ kind: 'copy', from, to });
    },
    rename: async (from, to) => {
      events.push({ kind: 'rename', from, to });
    },
  });

  assert.deepEqual(events.map(({ kind }) => kind), ['verify', 'copy', 'verify', 'rename'], 'verify → copy → verify → rename');
  assert.equal(events[0].file, '/build/drypoint-1.0.0.apk', 'the versioned APK is verified first');
  assert.deepEqual(
    { from: events[1].from, to: events[1].to },
    { from: '/build/drypoint-1.0.0.apk', to: '/build/drypoint.apk.tmp' },
    'the copy lands on a staging name, never on the published one'
  );
  assert.deepEqual(events[2], { kind: 'verify', file: '/build/drypoint.apk.tmp', label: 'verifying the staged copy' }, 'the staged copy is verified');
  assert.deepEqual(
    { from: events[3].from, to: events[3].to },
    { from: '/build/drypoint.apk.tmp', to: '/build/drypoint.apk' },
    'only a verified copy is renamed over the stable name'
  );

  const script = read('scripts/build-android.mjs');
  assert.match(script, /const verify = \(file, label\) => run\(apksigner, \['verify', '--print-certs', file\], label\)/, 'one verify helper');
  assert.match(script, /await publishApkPair\(\{ signed: signedInStaging, versioned, stable, verify \}\)/);
  assert.doesNotMatch(script, /cp\(output, join\(buildDir, 'drypoint\.apk'\)\)/, 'no unverified copy of the stable name');
});

test('a failed signature never publishes the stable name', async () => {
  let copied = false;
  await assert.rejects(
    publishApk({
      signed: '/build/versioned.apk',
      stable: '/build/stable.apk',
      verify: async () => {
        throw new Error('signature verification failed');
      },
      copy: async () => {
        copied = true;
      },
    }),
    /signature verification failed/
  );
  assert.equal(copied, false, 'the stable name is untouched when verification fails');
});

test('a staged copy that fails its own verification is removed, never published', async () => {
  const events = [];
  let verifications = 0;
  await assert.rejects(
    publishApk({
      signed: '/build/versioned.apk',
      stable: '/build/stable.apk',
      verify: async (file, label) => {
        events.push(`verify:${file}:${label}`);
        verifications++;
        if (verifications === 2) throw new Error('staged copy is corrupt');
      },
      copy: async (from, to) => events.push(`copy:${from}->${to}`),
      rename: async (from, to) => events.push(`rename:${from}->${to}`),
      remove: async (file, options) => events.push(`remove:${file}:${options.force}`),
    }),
    /staged copy is corrupt/
  );
  assert.deepEqual(events, [
    'verify:/build/versioned.apk:verifying the signature',
    'copy:/build/versioned.apk->/build/stable.apk.tmp',
    'verify:/build/stable.apk.tmp:verifying the staged copy',
    'remove:/build/stable.apk.tmp:true',
  ], 'the failed staging copy is discarded and the stable name is untouched');
});

test('a copy truncated by the filesystem leaves the previous stable APK intact', async () => {
  // A copy straight onto the stable name truncated it before writing: a full
  // disk or an interrupt left a half APK at the published path forever.
  const files = new Map([['/build/stable.apk', 'previous-good-apk']]);
  await assert.rejects(
    publishApk({
      signed: '/build/versioned.apk',
      stable: '/build/stable.apk',
      verify: async (file) => {
        if (file.endsWith('.tmp')) throw new Error('staged copy is truncated');
      },
      copy: async (from, to) => files.set(to, 'trunc'),
      rename: async (from, to) => {
        files.set(to, files.get(from));
        files.delete(from);
      },
      remove: async (file) => files.delete(file),
    }),
    /truncated/
  );
  assert.equal(files.get('/build/stable.apk'), 'previous-good-apk', 'the published artifact was never opened for writing');
  assert.equal(files.has('/build/stable.apk.tmp'), false, 'the staged copy is gone');
});

test('saveFile treats the web filename as one segment under Downloads', () => {
  const java = read('android/app/src/main/java/dev/llm4people/drypoint/BleBridge.java');
  const rule = read('android/app/src/main/java/dev/llm4people/drypoint/SafeFileName.java');

  assert.match(java, /SafeFileName\.isSafe\(name\)/, 'the bridge delegates the rule to its owner');
  assert.match(rule, /static boolean isSafe\(String name\)/, 'the filename validator exists');
  assert.ok(rule.includes('name == null || name.isEmpty()'), 'empty and null names are refused');
  assert.ok(rule.includes("name.indexOf('/') >= 0"), 'forward slashes are refused');
  assert.ok(rule.includes("name.indexOf('\\\\') >= 0"), 'backslashes are refused');
  assert.ok(rule.includes("name.indexOf('\\0') >= 0"), 'NUL is refused');
  assert.ok(rule.includes('".".equals(name)'), 'the "." segment is refused');
  assert.ok(rule.includes('"..".equals(name)'), 'the ".." segment is refused');

  const targetStart = java.indexOf('private File downloadTarget(');
  assert.ok(targetStart >= 0, 'the canonical target resolver exists');
  const target = java.slice(targetStart, java.indexOf('\n  }', targetStart));
  assert.ok(target.includes('dir.getCanonicalPath()'), 'the downloads directory is canonicalised');
  assert.ok(target.includes('target.getCanonicalPath().startsWith(base + File.separator)'), 'the target must stay under it');

  const saveStart = java.indexOf('public boolean saveFile(');
  const save = java.slice(saveStart, java.indexOf('\n  }', saveStart));
  assert.ok(save.includes('SafeFileName.isSafe(name)'), 'both API branches validate the name');
  assert.ok(save.includes('downloadTarget(name)'), 'the legacy branch writes the canonical target');
  assert.ok(
    save.indexOf('SafeFileName.isSafe(name)') < save.indexOf('getContentResolver().insert'),
    'validation happens before the MediaStore insert'
  );
});

/* ---------------- one transactional APK pair (O7) ---------------- */

async function pairFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-apk-pair-'));
  const signed = join(directory, 'staged.apk');
  const versioned = join(directory, 'versioned.apk');
  const stable = join(directory, 'stable.apk');
  await writeFile(signed, 'new-apk');
  await writeFile(versioned, 'old-versioned');
  await writeFile(stable, 'old-stable');
  return { directory, signed, versioned, stable };
}

test('the APK pair publishes both names and leaves no staging or backup files', async () => {
  const fixture = await pairFixture();
  const verified = [];
  try {
    await publishApkPair({
      ...fixture,
      verify: async (file, label) => verified.push([file, label]),
    });
    assert.equal(await readFile(fixture.versioned, 'utf8'), 'new-apk');
    assert.equal(await readFile(fixture.stable, 'utf8'), 'new-apk');
    assert.deepEqual(verified.map(([file]) => file), [fixture.signed, `${fixture.versioned}.tmp`, `${fixture.stable}.tmp`]);
    assert.deepEqual((await readdir(fixture.directory)).sort(), ['stable.apk', 'staged.apk', 'versioned.apk']);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a failure on the second publish restores the previous pair byte-for-byte', async () => {
  const fixture = await pairFixture();
  let failed = false;
  try {
    await assert.rejects(
      publishApkPair({
        ...fixture,
        verify: async () => {},
        rename: async (from, to) => {
          // Fail once, on the stable publish; the restore rename must work.
          if (to === fixture.stable && !failed) {
            failed = true;
            throw new Error('disk full during the second publish');
          }
          return rename(from, to);
        },
      }),
      /disk full during the second publish/
    );
    assert.equal(failed, true, 'the injected second-publish failure ran');
    assert.equal(await readFile(fixture.versioned, 'utf8'), 'old-versioned', 'the versioned name is not left new');
    assert.equal(await readFile(fixture.stable, 'utf8'), 'old-stable', 'the stable name is not left old beside a new versioned');
    assert.deepEqual(
      (await readdir(fixture.directory)).sort(),
      ['stable.apk', 'staged.apk', 'versioned.apk'],
      'no temporary or backup file is left behind'
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

/* ---------------- RG-1: a backup failure never destroys the pair ---------------- */

test('a failed versioned backup copy leaves the previous pair byte-identical', async () => {
  const fixture = await pairFixture();
  try {
    await assert.rejects(
      publishApkPair({
        ...fixture,
        verify: async () => {},
        copy: async (from, to) => {
          if (to === `${fixture.versioned}.bak`) throw new Error('backup copy failed for the versioned name');
          return cp(from, to);
        },
      }),
      /backup copy failed for the versioned name/
    );
    assert.equal(await readFile(fixture.versioned, 'utf8'), 'old-versioned', 'the last good versioned APK still exists');
    assert.equal(await readFile(fixture.stable, 'utf8'), 'old-stable', 'the last good stable APK still exists');
    assert.deepEqual(
      (await readdir(fixture.directory)).sort(),
      ['stable.apk', 'staged.apk', 'versioned.apk'],
      'no staging or partial backup file is left behind'
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('a failed stable backup copy leaves the previous pair byte-identical', async () => {
  const fixture = await pairFixture();
  try {
    await assert.rejects(
      publishApkPair({
        ...fixture,
        verify: async () => {},
        copy: async (from, to) => {
          if (to === `${fixture.stable}.bak`) throw new Error('backup copy failed for the stable name');
          return cp(from, to);
        },
      }),
      /backup copy failed for the stable name/
    );
    assert.equal(await readFile(fixture.versioned, 'utf8'), 'old-versioned', 'the last good versioned APK still exists');
    assert.equal(await readFile(fixture.stable, 'utf8'), 'old-stable', 'the last good stable APK still exists');
    assert.deepEqual(
      (await readdir(fixture.directory)).sort(),
      ['stable.apk', 'staged.apk', 'versioned.apk'],
      'the completed versioned backup is discarded with the staged copies'
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
