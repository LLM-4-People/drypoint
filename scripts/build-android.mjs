#!/usr/bin/env node
/**
 * Build the sideloadable Android APK without Gradle or Maven.
 *
 *   precache manifest → bundled assets → aapt2 link → javac → d8
 *   → zipalign → apksigner → verify → publish the stable name → verify again
 *
 * The web files come from the generated precache manifest, so the APK can never
 * ship a hand-copied or stale file list. The shell itself is plain Java against
 * the Android framework: no AndroidX, no external dependencies.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import brand from '../brand.json' with { type: 'json' };
import { isAllowed, resolveSurfacePath } from './precache.mjs';

const root = resolve(import.meta.dirname, '..');
const androidDir = join(root, 'android');
const buildDir = join(androidDir, 'build');
const appDir = join(androidDir, 'app', 'src', 'main');
const javaDir = join(appDir, 'java');

const fail = (message) => {
  console.error(`android: ${message}`);
  process.exit(1);
};

function sdkRoot() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Android', 'Sdk')];
  const found = candidates.filter(Boolean).find((dir) => existsSync(join(dir, 'platforms')));
  if (!found) fail('Android SDK not found; set ANDROID_HOME or install it at ~/Android/Sdk');
  return found;
}

const latest = (dir) =>
  readdirSync(dir)
    .filter((name) => /\d/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

/**
 * Pick the SDK directories. An explicit version always wins so CI builds with
 * the toolchain it proved; without one the newest installed directory is used.
 * The result reports whether both directories exist so the caller can fail with
 * the requested names instead of a missing-binary message.
 */
export function sdkDirs({
  sdk,
  buildTools = process.env.ANDROID_BUILD_TOOLS,
  platform = process.env.ANDROID_PLATFORM,
  latest: latestName = latest,
  exists = existsSync,
} = {}) {
  const buildToolsName = buildTools || latestName(join(sdk, 'build-tools'));
  const platformName = platform || latestName(join(sdk, 'platforms'));
  const buildToolsDir = join(sdk, 'build-tools', buildToolsName);
  const platformDir = join(sdk, 'platforms', platformName);
  return {
    buildToolsName,
    platformName,
    buildToolsDir,
    platformDir,
    ok: Boolean(buildToolsName && platformName && exists(buildToolsDir) && exists(platformDir)),
  };
}

/** Resolve the SDK tools at run time so the module stays importable by tests. */
function resolveTools() {
  const sdk = sdkRoot();
  const chosen = sdkDirs({ sdk });
  if (!chosen.ok) {
    fail(
      `Android SDK ${chosen.platformName ?? '?'} / build-tools ${chosen.buildToolsName ?? '?'} is not installed; ` +
        'set ANDROID_PLATFORM and ANDROID_BUILD_TOOLS or install those packages'
    );
  }
  const buildTools = chosen.buildToolsDir;
  const platform = chosen.platformDir;
  const tools = {
    androidJar: join(platform, 'android.jar'),
    aapt2: join(buildTools, 'aapt2'),
    d8: join(buildTools, 'd8'),
    zipalign: join(buildTools, 'zipalign'),
    apksigner: join(buildTools, 'apksigner'),
  };
  for (const tool of Object.values(tools)) {
    if (!existsSync(tool)) fail(`missing Android tool: ${tool}`);
  }
  return tools;
}

async function walk(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, suffix)));
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
}

function run(command, args, label) {
  process.stdout.write(`android: ${label}\n`);
  execFileSync(command, args, { stdio: 'inherit' });
}

async function readPrecache() {
  const source = await readFile(join(root, 'assets', 'precache.js'), 'utf8');
  const sandbox = { self: {} };
  vm.runInNewContext(source, sandbox, { filename: 'assets/precache.js' });
  const manifest = sandbox.self.__PRECACHE;
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) fail('assets/precache.js has no file list');
  return manifest;
}

/**
 * Stage the precached web files under a fresh assets root.
 *
 * aapt2 packages everything under `-A <dir>`, so the directory must contain
 * exactly the manifest's files: pointing it at the checked-in app assets would
 * ship a stray `leak.txt`, a stale `www-old/` tree, or a keystore copy that
 * happens to sit there.
 */
async function syncAssets(manifest, assetsDir) {
  const wwwDir = join(assetsDir, 'www');
  await rm(wwwDir, { recursive: true, force: true });
  for (const file of manifest.files) {
    if (!isAllowed(file)) fail(`manifest entry is outside the app surface: ${file}`);
    // The shared resolver rejects a symlink that escapes the repository; a
    // manifest entry can never ship bytes from outside the app surface.
    let real;
    try {
      ({ real } = await resolveSurfacePath(file));
    } catch (error) {
      fail(error.code === 'ENOENT' ? `manifest entry is missing: ${file}` : error.message);
    }
    const to = join(wwwDir, file);
    await mkdir(dirname(to), { recursive: true });
    await cp(real, to);
  }
  console.log(`android: bundled ${manifest.files.length} web files (${manifest.version})`);
}

/**
 * Publish the stable, version-less APK name only after the signed build has
 * verified, and only by an atomic rename.
 *
 * A copy straight onto the stable name truncates it first: an I/O error, a full
 * disk or an interrupt mid-copy destroyed the previous good artifact and the
 * follow-up verify never ran. The copy now lands on `stable.tmp`, that copy is
 * verified, and only then does a rename replace the stable name in one step.
 *
 * @param {{ signed: string, stable: string, verify: Function, copy?: Function,
 *           rename?: Function, remove?: Function }} options
 *   `verify(file, label)` runs the signature check; `copy(from, to)` stages the
 *   published bytes; `rename(from, to)` publishes atomically; `remove(file)`
 *   discards a staged copy that failed verification.
 */
export async function publishApk({ signed, stable, verify, copy = cp, rename: move = rename, remove = rm }) {
  await verify(signed, 'verifying the signature');
  const temporary = `${stable}.tmp`;
  try {
    await copy(signed, temporary);
    await verify(temporary, 'verifying the staged copy');
    await move(temporary, stable);
  } catch (error) {
    await remove(temporary, { force: true });
    throw error;
  }
  return stable;
}

/**
 * Publish the versioned and stable APK names as one transaction.
 *
 * Two independent publishes can leave a new versioned file beside the previous
 * stable one when the second fails. Stage and verify both copies first, back up
 * the previous pair, then rename both into place; on any failure restore the
 * previous pair byte-for-byte and never delete the last good artifacts. A
 * failure while creating a backup is itself before any visible name changed, so
 * it leaves that pair exactly as it found it.
 *
 * @returns {Promise<{versioned:string, stable:string}>}
 */
export async function publishApkPair({
  signed,
  versioned,
  stable,
  verify,
  copy = cp,
  rename: move = rename,
  remove = rm,
  exists = existsSync,
}) {
  await verify(signed, 'verifying the signature');
  const versionedTmp = `${versioned}.tmp`;
  const stableTmp = `${stable}.tmp`;
  const versionedBackup = `${versioned}.bak`;
  const stableBackup = `${stable}.bak`;

  const discard = async (paths) => {
    for (const path of paths) await remove(path, { force: true }).catch(() => {});
  };

  try {
    // Both names are verified before either visible name is touched.
    await copy(signed, versionedTmp);
    await verify(versionedTmp, 'verifying the versioned copy');
    await copy(signed, stableTmp);
    await verify(stableTmp, 'verifying the stable copy');
  } catch (error) {
    await discard([versionedTmp, stableTmp]);
    throw error;
  }

  const hadVersioned = exists(versioned);
  const hadStable = exists(stable);
  // Per-name state, so recovery touches exactly what this transaction changed.
  let versionedBackedUp = false;
  let stableBackedUp = false;
  let versionedReplaced = false;
  let stableReplaced = false;
  try {
    if (hadVersioned) {
      await copy(versioned, versionedBackup);
      versionedBackedUp = true;
    }
    if (hadStable) {
      await copy(stable, stableBackup);
      stableBackedUp = true;
    }
    await move(versionedTmp, versioned);
    versionedReplaced = true;
    await move(stableTmp, stable);
    stableReplaced = true;
  } catch (error) {
    // Restore only a name this transaction actually replaced, and only from the
    // backup it successfully created. A failure while creating a backup leaves
    // both visible names untouched: they are the recovery point, and deleting
    // them before checking that a backup exists destroyed the last good pair.
    const restores = [];
    if (versionedReplaced) {
      restores.push({ target: versioned, backup: versionedBackup, had: hadVersioned, backedUp: versionedBackedUp });
    }
    if (stableReplaced) {
      restores.push({ target: stable, backup: stableBackup, had: hadStable, backedUp: stableBackedUp });
    }

    let restoreError = null;
    const unrestored = new Set();
    for (const { target, backup, had, backedUp } of restores) {
      try {
        // A name the pair did not have before is removed again; a name it did
        // have is replaced atomically by its backup.
        if (!had) await remove(target, { force: true });
        else if (backedUp) await move(backup, target);
        else throw new Error(`${target} was replaced without a backup`);
      } catch (failure) {
        unrestored.add(target);
        restoreError ??= failure;
      }
    }

    // Staged copies and backups that no longer own a recovery point are
    // discarded; a backup whose restore failed stays on disk for recovery.
    const leftovers = [versionedTmp, stableTmp];
    if (!unrestored.has(versioned)) leftovers.push(versionedBackup);
    if (!unrestored.has(stable)) leftovers.push(stableBackup);
    await discard(leftovers);

    if (restoreError) {
      throw new Error(`publishing the APK pair failed (${error.message}) and the previous pair could not be restored (${restoreError.message})`);
    }
    throw error;
  }
  await discard([versionedBackup, stableBackup]);
  return { versioned, stable };
}

/**
 * Fill the Android manifest template. This is the only place the version
 * placeholders are resolved, and the result is checked: a template that gains a
 * placeholder the builder does not know fails the build instead of shipping a
 * literal version placeholder to the package manager.
 *
 * @param {string} template the checked-in AndroidManifest.template.xml
 * @param {{versionName:string, versionCode:number}} version
 * @returns {string} the rendered AndroidManifest.xml
 */
export function renderManifest(template, { versionName, versionCode }) {
  const rendered = template
    .replaceAll('@VERSION_NAME@', String(versionName))
    .replaceAll('@VERSION_CODE@', String(versionCode));
  const unresolved = rendered.match(/@[A-Z][A-Z0-9_]*@/g);
  if (unresolved) throw new Error(`unresolved manifest placeholder: ${[...new Set(unresolved)].join(', ')}`);
  return rendered;
}

/**
 * Render the manifest template into the build directory.
 *
 * This is the only writer, so the file that `aapt2 link` consumes is exactly
 * the renderer's output: a second replacement in `main()` cannot disagree with
 * what the tests verify.
 *
 * @param {{androidDir: string, buildDir: string, versionName: string, versionCode: number}} options
 * @returns {Promise<string>} the written file
 */
export async function writeManifest({ androidDir, buildDir, versionName, versionCode }) {
  const template = await readFile(join(androidDir, 'AndroidManifest.template.xml'), 'utf8');
  const output = join(buildDir, 'AndroidManifest.xml');
  await writeFile(output, renderManifest(template, { versionName, versionCode }));
  return output;
}

async function syncResources(buildDirectory) {
  const res = join(buildDirectory, 'res');
  await mkdir(join(res, 'values'), { recursive: true });
  await mkdir(join(res, 'drawable'), { recursive: true });
  await cp(join(appDir, 'res', 'values', 'strings.xml'), join(res, 'values', 'strings.xml'));
  await cp(join(root, 'assets', 'icon-192.png'), join(res, 'drawable', 'app_icon.png'));
}

function parseProperties(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) map[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return map;
}

/**
 * Hand a password to keytool/apksigner without an argument.
 *
 * A password on the command line is readable by every local process (`ps`,
 * `/proc/<pid>/cmdline`) for as long as the tool runs. These helpers write each
 * password to a 0600 file, pass the path, and delete the directory in a
 * `finally` so a failed build leaves no secret behind.
 *
 * @param {Record<string,string>} passwords name → secret
 * @param {(files: Record<string,string>) => Promise<any>} fn
 */
export async function withPasswordFiles(passwords, fn) {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-sign-'));
  const files = {};
  try {
    for (const [name, value] of Object.entries(passwords)) {
      const file = join(directory, `${name}.txt`);
      await writeFile(file, value, { mode: 0o600 });
      await chmod(file, 0o600);
      files[name] = file;
    }
    return await fn(files);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The public release identity; changing it changes every future signature. */
export const KEYSTORE_DN = `CN=${brand.name}, O=${brand.author}, C=CA`;

/** keytool argv for a new release key; the passwords are file paths only. */
export function keytoolArgs({ store, keyAlias, files }) {
  return [
    '-genkeypair',
    '-keystore', store,
    '-alias', keyAlias,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass:file', files.store,
    '-keypass:file', files.key,
    '-dname', KEYSTORE_DN,
  ];
}

/** One precedence rule for the signing identity: environment, then properties, then the default. */
export function resolveKeystore({ env = process.env, properties = {}, directory = join(androidDir, 'keystore') } = {}) {
  const store = env.ANDROID_KEYSTORE_FILE || join(directory, 'drypoint-release.jks');
  const storePassword = env.ANDROID_KEYSTORE_PASSWORD || properties.storePassword;
  const keyPassword = env.ANDROID_KEYSTORE_KEY_PASSWORD || properties.keyPassword || storePassword;
  const keyAlias = env.ANDROID_KEY_ALIAS || properties.keyAlias || 'drypoint';
  return { store, storePassword, keyPassword, keyAlias };
}

/**
 * What a missing keystore may do. A local build keeps the generate-if-absent
 * behaviour; CI and `--require-key` never invent a release key.
 */
export function keystoreAction({ exists, requireKey }) {
  if (exists) return 'use';
  return requireKey ? 'fail' : 'generate';
}

/** apksigner argv for the release build; the passwords are file paths only. */
export function apksignerArgs({ store, keyAlias, files, out, aligned }) {
  return [
    'sign',
    '--ks', store,
    '--ks-key-alias', keyAlias,
    '--ks-pass', `file:${files.ks}`,
    '--key-pass', `file:${files.key}`,
    '--out', out,
    aligned,
  ];
}

/**
 * Resolve the release signing identity.
 *
 * The environment overrides the local properties file, and CI (or an explicit
 * --require-key) may not invent a key: a release must be signed by the one key
 * the project backs up. A local build without either still generates a
 * throwaway key, but says loudly that it did.
 */
async function ensureKeystore({ requireKey = false } = {}) {
  const dir = join(androidDir, 'keystore');
  const propertiesFile = join(dir, 'keystore.properties');
  await mkdir(dir, { recursive: true });
  // The password is a secret: prefer the environment, then a local file that
  // .gitignore excludes. Only a throwaway run with neither gets a generated one.
  if (!existsSync(propertiesFile) && !process.env.ANDROID_KEYSTORE_PASSWORD) {
    const password = randomBytes(18).toString('base64url');
    await writeFile(propertiesFile, `storePassword=${password}\nkeyPassword=${password}\nkeyAlias=drypoint\n`, { mode: 0o600 });
    console.log('android: generated a local keystore password in android/keystore/ (ignored by git; back it up)');
  }
  const properties = existsSync(propertiesFile) ? parseProperties(await readFile(propertiesFile, 'utf8')) : {};
  const { store, storePassword, keyPassword, keyAlias } = resolveKeystore({ properties, directory: dir });
  if (!storePassword) {
    fail('set ANDROID_KEYSTORE_PASSWORD or keep android/keystore/keystore.properties');
  }
  const action = keystoreAction({ exists: existsSync(store), requireKey });
  if (action === 'fail') {
    fail(
      `the release keystore is missing (${store}). CI and --require-key never generate one: ` +
        'restore android/keystore/drypoint-release.jks or set ANDROID_KEYSTORE_FILE.'
    );
  }
  if (action === 'generate') {
    await withPasswordFiles({ store: storePassword, key: keyPassword }, async (files) => {
      run('keytool', keytoolArgs({ store, keyAlias, files }), 'creating the release keystore');
    });
    console.warn(`android: created a NEW signing key at ${store}`);
    console.warn('android: APKs signed with it cannot upgrade an install signed by another key');
  }
  // The keystore is a secret in its own right, whether this build created it or
  // an earlier one did: only this user may read it.
  await chmod(store, 0o600);
  return { store, storePassword, keyPassword, keyAlias };
}

async function main() {
  const requireKey = process.argv.includes('--require-key') || process.env.CI === 'true';
  const { aapt2, d8, zipalign, apksigner, androidJar } = resolveTools();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const [major = 1, minor = 0, patch = 0] = String(pkg.version).split('.').map(Number);
  const versionCode = major * 10000 + minor * 100 + (Number.isFinite(patch) ? patch : 0);

  run(process.execPath, [join(root, 'scripts', 'precache.mjs'), '--write'], 'refreshing the precache manifest');
  const manifest = await readPrecache();

  // Build into a scratch directory. `android/build/` holds the last verified
  // artifacts and is only touched by the atomic renames below, so a failed
  // build (javac, d8, apksigner, a full disk) leaves the published APK intact.
  const staging = await mkdtemp(join(androidDir, 'build-'));
  try {
    const assetsRoot = join(staging, 'assets');
    await syncAssets(manifest, assetsRoot);
    await syncResources(staging);

    await writeManifest({ androidDir, buildDir: staging, versionName: pkg.version, versionCode });

    run(aapt2, ['compile', '--dir', join(staging, 'res'), '-o', join(staging, 'res.zip')], 'compiling resources');
    run(
      aapt2,
      [
        'link',
        '-o', join(staging, 'base.apk'),
        '-I', androidJar,
        '--manifest', join(staging, 'AndroidManifest.xml'),
        // Exactly the precached files, under a fresh root: nothing else in the
        // app assets directory can ride along into the package.
        '-A', assetsRoot,
        '-R', join(staging, 'res.zip'),
        '--auto-add-overlay',
      ],
      'linking the APK'
    );

    const sources = await walk(javaDir, '.java');
    if (!sources.length) fail('no Java sources found');
    run(
      'javac',
      ['--release', '11', '-classpath', androidJar, '-d', join(staging, 'classes'), ...sources],
      `compiling ${sources.length} Java sources`
    );

    const classes = await walk(join(staging, 'classes'), '.class');
    await mkdir(join(staging, 'dex'), { recursive: true });
    run(
      d8,
      ['--lib', androidJar, '--min-api', '26', '--output', join(staging, 'dex'), ...classes],
      'dexing'
    );

    run(
      'python3',
      [
        '-c',
        'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "a", zipfile.ZIP_DEFLATED) as z:\n    z.write(sys.argv[2], "classes.dex")\n',
        join(staging, 'base.apk'),
        join(staging, 'dex', 'classes.dex'),
      ],
      'adding classes.dex'
    );

    run(zipalign, ['-f', '4', join(staging, 'base.apk'), join(staging, 'aligned.apk')], 'aligning');

    const keystore = await ensureKeystore({ requireKey });
    const name = `drypoint-${pkg.version}.apk`;
    const signedInStaging = join(staging, name);
    await withPasswordFiles({ ks: keystore.storePassword, key: keystore.keyPassword }, async (files) => {
      run(
        apksigner,
        apksignerArgs({
          store: keystore.store,
          keyAlias: keystore.keyAlias,
          files,
          out: signedInStaging,
          aligned: join(staging, 'aligned.apk'),
        }),
        'signing'
      );
    });

    const verify = (file, label) => run(apksigner, ['verify', '--print-certs', file], label);
    const versioned = join(buildDir, name);
    const stable = join(buildDir, 'drypoint.apk');
    await mkdir(buildDir, { recursive: true });
    // Publish both names as one transaction: on any failure the previous
    // stable and versioned APKs are restored byte-for-byte.
    await publishApkPair({ signed: signedInStaging, versioned, stable, verify });

    const badging = execFileSync(aapt2, ['dump', 'badging', versioned], { encoding: 'utf8' });
    for (const line of badging.split('\n')) {
      if (line.startsWith('package:') || line.startsWith('sdkVersion:') || line.startsWith('targetSdkVersion:') || line.startsWith('application-label:')) {
        console.log(`android: ${line}`);
      }
    }
    console.log(`android: built ${relative(root, versioned)}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`android: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
