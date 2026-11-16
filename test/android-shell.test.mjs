import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, cp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import {
  addDexEntry,
  APK_ENTRY_DATE_TIME,
  apksignerArgs,
  certificateSha256,
  minSdkVersionOf,
  publishApkPair,
  releaseIdentityRequired,
  renderManifest,
  sdkDirs,
  syncAssets,
  UMASK_WRAPPER,
  versionCodeOf,
  withStaging,
} from '../scripts/build-android.mjs';
import { DISTRIBUTION_FILES } from '../scripts/lib/distribution.mjs';
import { projectRoot } from './helpers/project-files.mjs';

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
  assert.match(script, /await withStaging\(androidDir, async \(staging\) => \{/, 'the build happens in a scratch directory that is always removed');
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

test('both published names are verified copies renamed into place', async () => {
  // The single-name publish this replaced survived only in tests: its ordering
  // was real, but the build never used it. The pair is the one publish path.
  const events = [];
  const remove = async (file, options) => events.push({ kind: 'remove', file, force: options?.force });
  await publishApkPair({
    signed: '/build/staged/drypoint-1.0.0.apk',
    versioned: '/build/drypoint-1.0.0.apk',
    stable: '/build/drypoint.apk',
    verify: async (file, label) => events.push({ kind: 'verify', file, label }),
    copy: async (from, to) => events.push({ kind: 'copy', from, to }),
    rename: async (from, to) => events.push({ kind: 'rename', from, to }),
    remove,
    exists: () => false,
  });

  assert.deepEqual(events.map(({ kind }) => kind), [
    'verify', 'copy', 'verify', 'copy', 'verify', 'rename', 'rename', 'remove', 'remove',
  ], 'verify → stage → verify → stage → verify → publish both');
  assert.deepEqual(
    events.filter(({ kind }) => kind === 'copy').map(({ to }) => to),
    ['/build/drypoint-1.0.0.apk.tmp', '/build/drypoint.apk.tmp'],
    'both copies land on staging names, never on the published ones'
  );
  assert.deepEqual(
    events.filter(({ kind }) => kind === 'rename').map(({ from, to }) => [from, to]),
    [
      ['/build/drypoint-1.0.0.apk.tmp', '/build/drypoint-1.0.0.apk'],
      ['/build/drypoint.apk.tmp', '/build/drypoint.apk'],
    ],
    'only verified copies are renamed over the published names'
  );

  const script = read('scripts/build-android.mjs');
  assert.match(script, /const verify = \(file, label\) => run\(apksigner, \['verify', '--print-certs', file\], label\)/, 'one verify helper');
  assert.match(script, /await publishApkPair\(\{ signed: signedInStaging, versioned, stable, verify \}\)/);
  assert.doesNotMatch(script, /export async function publishApk\(/, 'one publish owner');
  assert.doesNotMatch(script, /cp\(output, join\(buildDir, 'drypoint\.apk'\)\)/, 'no unverified copy of the stable name');
});

test('a failed signature never publishes either name', async () => {
  let copied = false;
  await assert.rejects(
    publishApkPair({
      signed: '/build/staged/versioned.apk',
      versioned: '/build/versioned.apk',
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
  assert.equal(copied, false, 'neither name is touched when verification fails');
});

test('a staged copy that fails its own verification is removed, never published', async () => {
  const events = [];
  let verifications = 0;
  await assert.rejects(
    publishApkPair({
      signed: '/build/staged/versioned.apk',
      versioned: '/build/versioned.apk',
      stable: '/build/stable.apk',
      verify: async (file, label) => {
        events.push(`verify:${file}:${label}`);
        verifications++;
        if (verifications === 3) throw new Error('staged copy is corrupt');
      },
      copy: async (from, to) => events.push(`copy:${from}->${to}`),
      rename: async (from, to) => events.push(`rename:${from}->${to}`),
      remove: async (file, options) => events.push(`remove:${file}:${options.force}`),
      exists: () => false,
    }),
    /staged copy is corrupt/
  );
  assert.deepEqual(events, [
    'verify:/build/staged/versioned.apk:verifying the signature',
    'copy:/build/staged/versioned.apk->/build/versioned.apk.tmp',
    'verify:/build/versioned.apk.tmp:verifying the versioned copy',
    'copy:/build/staged/versioned.apk->/build/stable.apk.tmp',
    'verify:/build/stable.apk.tmp:verifying the stable copy',
    'remove:/build/versioned.apk.tmp:true',
    'remove:/build/stable.apk.tmp:true',
  ], 'both staged copies are discarded and neither published name is touched');
});

test('a copy truncated by the filesystem never opens the published name', async () => {
  // A copy straight onto the stable name truncated it before writing: a full
  // disk or an interrupt left a half APK at the published path forever.
  const files = new Map([['/build/stable.apk', 'previous-good-apk'], ['/build/versioned.apk', 'previous-good-versioned']]);
  await assert.rejects(
    publishApkPair({
      signed: '/build/staged/versioned.apk',
      versioned: '/build/versioned.apk',
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
      exists: (file) => files.has(file),
    }),
    /truncated/
  );
  assert.equal(files.get('/build/stable.apk'), 'previous-good-apk', 'the published artifact was never opened for writing');
  assert.equal(files.get('/build/versioned.apk'), 'previous-good-versioned', 'nor the versioned one');
  assert.equal(files.has('/build/stable.apk.tmp'), false, 'the staged copy is gone');
  assert.equal(files.has('/build/versioned.apk.tmp'), false, 'both staged copies are gone');
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
  assert.ok(save.includes('SafeFileName.isSafe(name)'), 'the name is validated before either branch');
  assert.ok(save.indexOf('SafeFileName.isSafe(name)') < save.indexOf('saveFileModern'), 'validation happens before anything is created');
  const legacyStart = java.indexOf('private boolean saveFileLegacy(');
  assert.ok(legacyStart >= 0, 'the API 26-28 branch is its own method');
  const legacy = java.slice(legacyStart, java.indexOf('\n  }', legacyStart));
  assert.ok(legacy.includes('downloadTarget(name)'), 'the legacy branch writes the canonical target');
});

/* ---------------- the shell refuses anything outside the app ---------------- */

/** The body of one Java method, from its signature to its closing brace. */
function methodBody(java, signature) {
  const start = java.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  return java.slice(start, java.indexOf('\n  }\n', start));
}

test('a request or a navigation outside the app origin is refused, never released', () => {
  const activity = read('android/app/src/main/java/dev/llm4people/drypoint/MainActivity.java');

  // One predicate decides what "the app" is; the interceptor and the
  // navigation override cannot disagree.
  const predicate = methodBody(activity, 'private static boolean isAppUrl(Uri url)');
  assert.match(predicate, /"https"\.equals\(url\.getScheme\(\)\)/, 'a plain-http request is not the app');
  assert.match(predicate, /HOST\.equals\(url\.getHost\(\)\)/, 'a foreign host is not the app');
  assert.match(predicate, /url != null/, 'a null URL is not the app');

  const intercept = methodBody(activity, 'public WebResourceResponse shouldInterceptRequest(');
  assert.match(intercept, /if \(!isAppUrl\(url\)\) return textResponse\(403, "Forbidden"\)/, 'a foreign request is answered 403');
  assert.doesNotMatch(intercept, /return null/, 'returning null released the request to the network');
  assert.match(methodBody(activity, 'private static String reasonOf(int status)'), /case 403:\s*\n\s*return "Forbidden"/);

  const override = methodBody(activity, 'public boolean shouldOverrideUrlLoading(');
  assert.match(override, /return !isAppUrl\(request\.getUrl\(\)\)/, 'a foreign navigation stays in the app instead of leaving it');
});

test('saveFile publishes the download row only after the bytes are complete', () => {
  const java = read('android/app/src/main/java/dev/llm4people/drypoint/BleBridge.java');
  const modern = methodBody(java, 'private boolean saveFileModern(');

  const check = modern.indexOf('displayNameTaken(name)');
  const pending = modern.indexOf('MediaStore.Downloads.IS_PENDING, 1');
  const insert = modern.indexOf('.insert(');
  const write = modern.indexOf('out.write(');
  const clear = modern.indexOf('MediaStore.Downloads.IS_PENDING, 0');
  assert.ok(check >= 0 && check < insert, 'the display name is checked before the row is created');
  assert.ok(pending > 0 && pending < insert, 'IS_PENDING=1 is set before the row exists');
  assert.ok(write > insert, 'the bytes are written into the row it created');
  assert.ok(clear > write, 'IS_PENDING=0 is only set after the write returned');
  assert.match(modern, /finally/, 'the flag is cleared in a finally, not on the happy path only');
  assert.match(modern, /\.delete\(uri, null, null\)/, 'a failed write deletes the pending row');
  assert.match(methodBody(java, 'private boolean displayNameTaken('), /MediaStore\.Downloads\.DISPLAY_NAME \+ " = \?/);

  const legacy = methodBody(java, 'private boolean saveFileLegacy(');
  assert.match(legacy, /downloadTarget\(name\)/, 'the API 26-28 path is kept');
  assert.match(legacy, /new FileOutputStream\(target\)/);

  const save = methodBody(java, 'public boolean saveFile(');
  assert.match(save, /^public boolean saveFile\(String name, String text\) \{\n    if \(!SafeFileName\.isSafe\(name\)\) return false;/, 'the name is validated first');
  assert.match(save, /Build\.VERSION\.SDK_INT >= 29\) return saveFileModern/, 'one branch picks the API path');
  assert.match(save, /return saveFileLegacy\(name, text\)/, 'the API 26-28 path is the other');
});

/* ---------------- the staging directory is not left behind ---------------- */

test('a failed build leaves no staging directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-android-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    withStaging(directory, async (staging) => {
      await writeFile(join(staging, 'base.apk'), 'half');
      throw new Error('javac failed');
    }),
    /javac failed/
  );
  assert.deepEqual(await readdir(directory), [], 'no build-XXXXXX directory survives a failure');

  await withStaging(directory, async (staging) => {
    await writeFile(join(staging, 'base.apk'), 'complete');
  });
  assert.deepEqual(await readdir(directory), [], 'and none survives a success either');

  const script = read('scripts/build-android.mjs');
  assert.match(script, /await withStaging\(androidDir, async \(staging\) => \{/, 'the build uses the one staging owner');
  // A refusal must throw, not end the process: process.exit skips the finally.
  assert.throws(() => versionCodeOf('1.100.0'), /does not fit the versionCode/);
});

/* ---------------- version arithmetic and the signing identity ---------------- */

test('the versionCode arithmetic refuses a component that would collide', () => {
  assert.equal(versionCodeOf('1.0.0'), 10000);
  assert.equal(versionCodeOf('1.2.3'), 10203);
  assert.equal(versionCodeOf('2.99.99'), 29999);
  // 1.100.0 would be 20000, exactly 2.0.0; 1.0.100 would be 10100, exactly 1.1.0.
  assert.throws(() => versionCodeOf('1.100.0'), /minor 100 does not fit the versionCode/);
  assert.throws(() => versionCodeOf('1.0.100'), /patch 100 does not fit the versionCode/);
  assert.throws(() => versionCodeOf('1.0.0-rc.1'), /MAJOR\.MINOR\.PATCH with no suffix/);
  assert.throws(() => versionCodeOf('1.0'), /MAJOR\.MINOR\.PATCH/);
  assert.equal(versionCodeOf(JSON.parse(read('package.json')).version), 10000, 'the shipped version fits');
});

test('the signing schemes follow the manifest minimum', () => {
  const files = { ks: '/k/ks.txt', key: '/k/key.txt' };
  const args = (minSdkVersion) => apksignerArgs({ store: '/k/r.jks', keyAlias: 'drypoint', files, out: '/o.apk', aligned: '/a.apk', minSdkVersion });
  const value = (argv, flag) => argv[argv.indexOf(flag) + 1];

  assert.equal(value(args(26), '--v1-signing-enabled'), 'false', 'API 26 verifies v2, so no JAR signature');
  assert.equal(value(args(26), '--min-sdk-version'), '26');
  assert.equal(value(args(24), '--v1-signing-enabled'), 'false', 'API 24 is the v2 floor');
  assert.equal(value(args(21), '--v1-signing-enabled'), 'true', 'below API 24 the v1 signature is still required');

  const manifest = read('android/AndroidManifest.template.xml');
  assert.equal(minSdkVersionOf(renderManifest(manifest, { versionName: '1.0.0', versionCode: 10000 })), 26, 'the manifest owns the minimum');
  assert.throws(() => minSdkVersionOf('<manifest/>'), /no android:minSdkVersion/);
});

test('the release certificate in brand.json is the one the build compares', () => {
  const brandJson = JSON.parse(read('brand.json'));
  assert.match(brandJson.androidSigningCertificateSha256, /^[0-9a-f]{64}$/, 'lower-case hex, the form apksigner prints');

  assert.equal(
    certificateSha256('Signer #1 certificate SHA-256 digest: 28e9497fced0ecf6d20b73dbd090e146050ee318cd1e19b6678314d15933148f\nSigner #1 certificate SHA-1 digest: cd'),
    '28e9497fced0ecf6d20b73dbd090e146050ee318cd1e19b6678314d15933148f'
  );
  assert.equal(
    certificateSha256('Signer #1 certificate SHA-256 digest: 28E9497FCED0ECF6D20B73DBD090E146050EE318CD1E19B6678314D15933148F'),
    '28e9497fced0ecf6d20b73dbd090e146050ee318cd1e19b6678314d15933148f',
    'the digest is normalised, so the comparison never depends on case'
  );
  assert.throws(() => certificateSha256('no signer here'), /did not print a signer certificate digest/);

  const build = read('scripts/build-android.mjs');
  assert.match(build, /brand\.androidSigningCertificateSha256/, 'the build compares against the brand field');
  assert.match(build, /if \(actual !== brand\.androidSigningCertificateSha256\)/, 'a mismatch is fatal');
});

test('the certificate pin applies to a release key and not to a throwaway', () => {
  assert.equal(releaseIdentityRequired({ generated: false, env: {} }), true, 'a pre-existing key must be the release key');
  assert.equal(releaseIdentityRequired({ generated: true, env: {} }), false, 'a key this build generated cannot be it');
  assert.equal(releaseIdentityRequired({ generated: false, env: { ANDROID_ALLOW_TEST_KEY: 'true' } }), false, 'the gate declares its throwaway key');
  assert.equal(releaseIdentityRequired({ generated: false, env: { ANDROID_ALLOW_TEST_KEY: '1' } }), false);
  assert.equal(releaseIdentityRequired({ generated: false, env: { ANDROID_ALLOW_TEST_KEY: 'no' } }), true, 'any other value keeps the pin');

  // The release job never opts out; the pull-request gate always says so.
  const release = read('.github/workflows/release.yml');
  assert.doesNotMatch(release, /ANDROID_ALLOW_TEST_KEY/, 'the release never allows a test key');
  assert.match(read('.github/workflows/checks.yml'), /ANDROID_ALLOW_TEST_KEY: 'true'/, 'the gate declares its throwaway key');
});

test('the APK carries the licence and the notices from the one distribution list', async (t) => {
  const staging = await mkdtemp(join(tmpdir(), 'drypoint-assets-'));
  t.after(() => rm(staging, { recursive: true, force: true }));
  const sandbox = { self: {} };
  vm.runInNewContext(read('assets/precache.js'), sandbox);
  const manifest = sandbox.self.__PRECACHE;

  await syncAssets(manifest, staging);
  const www = join(staging, 'www');
  const staged = (await readdir(www)).sort();
  for (const file of DISTRIBUTION_FILES) {
    assert.deepEqual(await readFile(join(www, file)), await readFile(join(projectRoot, file)), `${file} is inside assets/www byte-for-byte`);
  }
  assert.equal(staged.includes('package.json'), false, 'no repository file rides along');
  assert.equal(staged.includes('brand.json'), false);
  assert.deepEqual(staged.filter((name) => DISTRIBUTION_FILES.includes(name)).sort(), [...DISTRIBUTION_FILES].sort());
  // The notices are not precached entries: the offline shell never caches them.
  for (const file of DISTRIBUTION_FILES) assert.equal(manifest.files.includes(file), false);
});

test('a keystore written through the umask wrapper is 0600 from its first byte', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-umask-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = join(directory, 'probe.jks');
  // The same wrapper the build uses around keytool, with a stand-in command
  // that creates a file: what matters is the mode it lands with.
  execFileSync('sh', [...UMASK_WRAPPER, 'python3', '-c', `open(${JSON.stringify(probe)}, 'w').write('x')`]);
  assert.equal((await stat(probe)).mode & 0o777, 0o600, 'no 0664 window');

  // The keystore directory is 0700 before keytool writes anything into it.
  const script = read('scripts/build-android.mjs');
  assert.match(script, /await mkdir\(dir, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(script, /await chmod\(dir, 0o700\)/);
  assert.match(script, /await chmod\(pending, 0o600\)/, 'the store is 0600 before it is renamed into place');
  assert.match(script, /await rename\(pending, store\)/, 'a reader never sees a half-written key');
});

test('classes.dex is appended with a pinned timestamp', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-dex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dex = join(directory, 'classes.dex');
  await writeFile(dex, Buffer.from('dex\n035\0payload'));

  // The way aapt2 leaves the APK before the dex is added: one entry.
  const base = (path) =>
    execFileSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n    z.writestr("AndroidManifest.xml","x")\n', path]);
  const first = join(directory, 'base.apk');
  const second = join(directory, 'second.apk');
  base(first);
  base(second);

  addDexEntry({ apk: first, dex });
  addDexEntry({ apk: second, dex });

  const entries = readZipEntries(first);
  assert.deepEqual(entries.map((entry) => entry.name), ['AndroidManifest.xml', 'classes.dex'], 'the dex is appended last');
  assert.deepEqual(entries[1].dateTime, [1980, 1, 1, 0, 0, 0], 'the entry carries a fixed timestamp, not the wall clock');
  assert.equal(entries[1].size, Buffer.byteLength('dex\n035\0payload'), 'the payload is the dex file');
  assert.deepEqual(APK_ENTRY_DATE_TIME, [1980, 1, 1, 0, 0, 0]);
  assert.deepEqual(await readFile(second), await readFile(first), 'two builds of the same tree are the same bytes');
});

/** The entries of a zip, as python's zipfile reports them. */
function readZipEntries(path) {
  const script = [
    'import json, sys, zipfile',
    'archive = zipfile.ZipFile(sys.argv[1])',
    'print(json.dumps([{"name": i.filename, "dateTime": list(i.date_time), "size": i.file_size} for i in archive.infolist()]))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, path], { encoding: 'utf8' }));
}

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
