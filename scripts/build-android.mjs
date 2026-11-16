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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import brand from '../brand.json' with { type: 'json' };
import { DISTRIBUTION_FILES, resolveDistributionFile } from './lib/distribution.mjs';
import { isAllowed, readManifest, resolveSurfacePath } from './precache.mjs';

const root = resolve(import.meta.dirname, '..');
const androidDir = join(root, 'android');
const buildDir = join(androidDir, 'build');
const appDir = join(androidDir, 'app', 'src', 'main');
const javaDir = join(appDir, 'java');

/**
 * A build refusal: the message is the whole story, so the command line prints
 * it without a stack.
 *
 * `fail()` used to call `process.exit(1)` where it stood, which killed the
 * process before `main()`'s `finally` ran: every failed build left its
 * `android/build-XXXXXX` staging directory (and its keystore copy, its dex and
 * its APK) behind. Throwing unwinds normally, so the cleanup always runs and
 * the exit code is still 1.
 */
export class BuildError extends Error {}

const fail = (message) => {
  throw new BuildError(message);
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

/**
 * Run one command with a payload on its standard input.
 *
 * Used where a path must reach a helper without appearing in its arguments: the
 * command line stays a constant program, so nothing a build step derived from
 * the tree becomes part of another process's argv.
 */
function runWithInput(command, args, input, label) {
  process.stdout.write(`android: ${label}\n`);
  execFileSync(command, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
}

/**
 * Stage the precached web files under a fresh assets root.
 *
 * aapt2 packages everything under `-A <dir>`, so the directory must contain
 * exactly the manifest's files: pointing it at the checked-in app assets would
 * ship a stray `leak.txt`, a stale `www-old/` tree, or a keystore copy that
 * happens to sit there.
 */
export async function syncAssets(manifest, assetsDir) {
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
  // The licence and the third-party notices travel with every distribution,
  // from the one list the site also reads. They are deliberately not precached
  // entries: they are not part of the offline app shell.
  for (const file of DISTRIBUTION_FILES) {
    let real;
    try {
      ({ real } = await resolveDistributionFile(file));
    } catch (error) {
      fail(`distribution notice is missing: ${file} (${error.message})`);
    }
    await mkdir(wwwDir, { recursive: true });
    await cp(real, join(wwwDir, file));
  }
  console.log(`android: bundled ${manifest.files.length} web files (${manifest.version}) and ${DISTRIBUTION_FILES.length} notices`);
}

/**
 * Publish the versioned and stable APK names as one transaction.
 *
 * Both names are verified before either visible name is touched, then backed
 * up, then renamed into place; on any failure the previous pair is restored
 * byte-for-byte and the last good artifacts are never deleted. A failure while
 * creating a backup is itself before any visible name changed, so it leaves
 * that pair exactly as it found it.
 *
 * This is the only publish path: the single-name copy this replaced survived
 * only in tests, where it proved an ordering the real build never used.
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
 * Fill the Android manifest template. This is the only place the brand package
 * and version placeholders are resolved, and the result is checked: a template
 * that gains a placeholder the builder does not know fails the build instead of
 * shipping a literal placeholder to the package manager.
 *
 * @param {string} template the checked-in AndroidManifest.template.xml
 * @param {{versionName:string, versionCode:number, packageName:string}} values
 * @returns {string} the rendered AndroidManifest.xml
 */
export function renderManifest(template, { versionName, versionCode, packageName }) {
  const rendered = template
    .replaceAll('@PACKAGE@', String(packageName))
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
 * @param {{androidDir: string, buildDir: string, versionName: string, versionCode: number, packageName: string}} options
 * @returns {Promise<string>} the written file
 */
export async function writeManifest({ androidDir, buildDir, versionName, versionCode, packageName }) {
  const template = await readFile(join(androidDir, 'AndroidManifest.template.xml'), 'utf8');
  const output = join(buildDir, 'AndroidManifest.xml');
  await writeFile(output, renderManifest(template, { versionName, versionCode, packageName }));
  return output;
}

/**
 * The Android versionCode for a semver version.
 *
 * `major * 10000 + minor * 100 + patch` has room for two digits in the minor
 * and the patch. A larger component would silently borrow from the next one —
 * 1.100.0 and 2.0.0 would both be 20000, and patch 100 would collide with the
 * next minor — so an out-of-range component is refused instead of colliding.
 * A prerelease suffix is refused for the same reason: the release contract is a
 * strict `vMAJOR.MINOR.PATCH` tag, and `1.0.0-rc.1` has no versionCode.
 *
 * @param {string} version package.json's version
 * @returns {number}
 */
export function versionCodeOf(version) {
  const text = String(version ?? '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) fail(`package.json version must be MAJOR.MINOR.PATCH with no suffix: ${JSON.stringify(text)}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 99) fail(`package.json minor ${minor} does not fit the versionCode (0-99): ${text}`);
  if (patch > 99) fail(`package.json patch ${patch} does not fit the versionCode (0-99): ${text}`);
  return major * 10000 + minor * 100 + patch;
}

/**
 * The minimum SDK the rendered manifest declares.
 *
 * The signing schemes are chosen from this one value: API 24+ verifies the APK
 * Signature Scheme v2, so the JAR (v1) signature is only needed below it.
 *
 * @param {string} manifestXml the rendered AndroidManifest.xml
 * @returns {number}
 */
export function minSdkVersionOf(manifestXml) {
  const match = /android:minSdkVersion="(\d+)"/.exec(String(manifestXml));
  if (!match) fail('the rendered manifest declares no android:minSdkVersion');
  return Number(match[1]);
}

/** The template's target SDK, the one owner the artifact check reads. */
export function targetSdkVersionOf(manifestXml) {
  const match = /android:targetSdkVersion="(\d+)"/.exec(String(manifestXml));
  if (!match) fail('the rendered manifest declares no android:targetSdkVersion');
  return Number(match[1]);
}

/**
 * The signing schemes for one minimum SDK. This is the only rule: API 24 and
 * later verify the APK Signature Scheme v2, so the JAR (v1) signature is only
 * needed below it. The build and the sign job both consume this answer.
 *
 * @param {number|string} minSdkVersion
 * @returns {{minSdkVersion: number, v1SigningEnabled: boolean}}
 */
export function signingSchemeForMinSdk(minSdkVersion) {
  const value = Number(minSdkVersion);
  if (!Number.isInteger(value) || value <= 0) fail(`minSdkVersion must be a positive integer: ${JSON.stringify(minSdkVersion)}`);
  return { minSdkVersion: value, v1SigningEnabled: !(value >= 24) };
}

/**
 * The signing scheme the rendered manifest declares. The manifest is the one
 * owner of the minimum SDK.
 *
 * @param {string} manifestXml the rendered AndroidManifest.xml
 * @returns {{minSdkVersion: number, v1SigningEnabled: boolean}}
 */
export function signingSchemeOf(manifestXml) {
  return signingSchemeForMinSdk(minSdkVersionOf(manifestXml));
}

/**
 * The SHA-256 of the certificate `apksigner verify --print-certs` reported.
 *
 * Lower-case hex, the form `brand.json` stores, so a comparison never depends
 * on how the tool spells its digest.
 *
 * @param {string} output apksigner's stdout
 * @returns {string}
 */
export function certificateSha256(output) {
  const match = /Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(String(output));
  if (!match) fail('apksigner did not print a signer certificate digest');
  return match[1].toLowerCase();
}

/**
 * Whether this build must prove it used the release signing identity.
 *
 * The pin is enforced by default: an APK this repository builds is the release
 * APK unless the build says otherwise. There are exactly two declared
 * exceptions, and both are visible in the build log: a key this run just
 * generated cannot be the release key (the build already warns loudly), and a
 * caller may set ANDROID_ALLOW_TEST_KEY=1. `scripts/ci-keystore.mjs` sets it
 * for the unprivileged CI jobs, which prove the toolchain with a throwaway key
 * and publish nothing; the release sign job never sets it.
 *
 * @param {{generated: boolean, env?: Record<string,string|undefined>}} options
 * @returns {boolean}
 */
export function releaseIdentityRequired({ generated, env = process.env }) {
  if (generated) return false;
  return !['1', 'true'].includes(String(env.ANDROID_ALLOW_TEST_KEY ?? '').toLowerCase());
}

/**
 * Stage the Android resources: the one launcher icon comes from the web app's
 * 192 px icon, byte-for-byte, so the APK cannot ship a differently drawn mark.
 */
export async function syncResources(buildDirectory) {
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

/**
 * The `sh -c` wrapper that runs keytool with umask 077.
 *
 * keytool creates the store with the process umask, so on a standard login it
 * would be 0664 — readable by every local user — until the chmod at the end.
 * With umask 077 the file is 0600 from its first byte. `"$@"` keeps every
 * argument verbatim, so no password or path is ever shell-parsed.
 */
export const UMASK_WRAPPER = Object.freeze(['-c', 'umask 077; exec "$@"', 'keytool']);

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

/**
 * apksigner argv for the release build; the passwords are file paths only.
 *
 * `minSdkVersion` decides the schemes. API 24 and later verify the APK
 * Signature Scheme v2, and the manifest's own minimum (26) always has it, so v1
 * is disabled: a JAR signature would add three META-INF entries that apksigner
 * stamps with the wall clock, and the same tree would produce different bytes
 * on every build. Below API 24 the v1 signature is still required.
 */
export function apksignerArgs({ store, keyAlias, files, out, aligned, minSdkVersion }) {
  const scheme = signingSchemeForMinSdk(minSdkVersion);
  return [
    'sign',
    '--ks', store,
    '--ks-key-alias', keyAlias,
    '--ks-pass', `file:${files.ks}`,
    '--key-pass', `file:${files.key}`,
    '--min-sdk-version', String(scheme.minSdkVersion),
    '--v1-signing-enabled', scheme.v1SigningEnabled ? 'true' : 'false',
    '--out', out,
    aligned,
  ];
}

/** The zip timestamp every entry this build writes carries. */
export const APK_ENTRY_DATE_TIME = Object.freeze([1980, 1, 1, 0, 0, 0]);

/**
 * Append `classes.dex` with a fixed entry timestamp.
 *
 * `ZipFile.write()` stamps the entry with the current wall clock, so two builds
 * of the same tree produced different archives. The entry is written through an
 * explicit `ZipInfo` instead: the same 1980-01-01 timestamp aapt2 gives every
 * entry it emits, the same compression and the same permission bits. Python's
 * `zipfile` is the only zip writer here because Node has none without a
 * dependency.
 *
 * The two paths travel over stdin, never on the command line: the invocation
 * stays `python3 -c <fixed program>`, so no path a caller controls is part of
 * the process arguments. What this cannot pin is documented in docs/ANDROID.md.
 */
const DEX_ENTRY_SCRIPT = [
  'import json, sys, zipfile',
  'request = json.load(sys.stdin)',
  'stamp = tuple(int(part) for part in request["dateTime"])',
  'with zipfile.ZipFile(request["apk"], "a", zipfile.ZIP_DEFLATED) as archive:',
  '    info = zipfile.ZipInfo("classes.dex", stamp)',
  '    info.compress_type = zipfile.ZIP_DEFLATED',
  '    info.create_system = 0',
  '    info.external_attr = 0o644 << 16',
  '    with open(request["dex"], "rb") as source, archive.open(info, "w") as entry:',
  '        for chunk in iter(lambda: source.read(65536), b""):',
  '            entry.write(chunk)',
].join('\n');

/**
 * @param {{apk: string, dex: string, dateTime?: number[], exec?: Function}} options
 *   `exec(command, args, options)` runs the writer; the tests inject a recorder.
 */
export function addDexEntry({ apk, dex, dateTime = APK_ENTRY_DATE_TIME, exec = runWithInput }) {
  exec('python3', ['-c', DEX_ENTRY_SCRIPT], JSON.stringify({ apk, dex, dateTime: [...dateTime] }), 'adding classes.dex');
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
  // 0700 before anything is written. The directory is what keeps another local
  // user out while keytool creates the store with the login umask (0664); a
  // default 0775 directory left the key world-traversable until the final
  // chmod.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
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
  const generated = action === 'generate';
  if (generated) {
    // keytool creates the store with the process umask. `umask 077` makes the
    // file 0600 from its first byte instead of 0664 until the chmod, and the
    // temporary name means a reader never observes a half-written key.
    const pending = `${store}.new`;
    await withPasswordFiles({ store: storePassword, key: keyPassword }, async (files) => {
      run('sh', [...UMASK_WRAPPER, 'keytool', ...keytoolArgs({ store: pending, keyAlias, files })], 'creating the release keystore');
      await chmod(pending, 0o600);
      await rename(pending, store);
    });
    console.warn(`android: created a NEW signing key at ${store}`);
    console.warn('android: APKs signed with it cannot upgrade an install signed by another key');
  }
  // The keystore is a secret in its own right, whether this build created it or
  // an earlier one did: only this user may read it.
  await chmod(store, 0o600);
  return { store, storePassword, keyPassword, keyAlias, generated };
}

/**
 * Run one build in a scratch directory under `android/`, removing it whether
 * the build succeeded or threw.
 *
 * This is the only owner of the staging lifetime. `fail()` used to call
 * `process.exit(1)` where it stood, so the cleanup below never ran and every
 * failed build left its `build-XXXXXX` tree — assets, dex, keystore copy and
 * signed APK — behind on disk.
 *
 * @template T
 * @param {string} directory the parent the scratch directory lives in
 * @param {(staging: string) => Promise<T>} build
 * @returns {Promise<T>}
 */
export async function withStaging(directory, build) {
  const staging = await mkdtemp(join(directory, 'build-'));
  try {
    return await build(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // The gate prints the code the build will stamp, from the one owner of the
  // arithmetic, instead of recomputing it in shell.
  if (process.argv.includes('--version-code')) {
    console.log(versionCodeOf(pkg.version));
    return;
  }
  // The sign job must not hard-code the scheme: it reads this answer from the
  // same manifest owner the build uses.
  if (process.argv.includes('--signing-scheme')) {
    const template = await readFile(join(androidDir, 'AndroidManifest.template.xml'), 'utf8');
    console.log(JSON.stringify(signingSchemeOf(template)));
    return;
  }
  const requireKey = process.argv.includes('--require-key') || process.env.CI === 'true';
  const { aapt2, d8, zipalign, apksigner, androidJar } = resolveTools();
  const versionCode = versionCodeOf(pkg.version);

  run(process.execPath, [join(root, 'scripts', 'precache.mjs'), '--write'], 'refreshing the precache manifest');
  const manifest = await readManifest(root);

  // Build into a scratch directory. `android/build/` holds the last verified
  // artifacts and is only touched by the atomic renames below, so a failed
  // build (javac, d8, apksigner, a full disk) leaves the published APK intact.
  await withStaging(androidDir, async (staging) => {
    const assetsRoot = join(staging, 'assets');
    await syncAssets(manifest, assetsRoot);
    await syncResources(staging);

    const manifestPath = await writeManifest({
      androidDir,
      buildDir: staging,
      versionName: pkg.version,
      versionCode,
      packageName: brand.appId,
    });
    const minSdkVersion = minSdkVersionOf(await readFile(manifestPath, 'utf8'));

    run(
      aapt2,
      [
        'compile',
        '--dir', join(staging, 'res'),
        '-o', join(staging, 'res.zip'),
        // Without this aapt2 re-encodes the PNG, so the APK's drawable would
        // not be the file the tests checked: same artwork, different bytes.
        '--no-crunch',
      ],
      'compiling resources'
    );
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
      ['--lib', androidJar, '--min-api', String(minSdkVersion), '--output', join(staging, 'dex'), ...classes],
      'dexing'
    );

    addDexEntry({ apk: join(staging, 'base.apk'), dex: join(staging, 'dex', 'classes.dex') });

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
          minSdkVersion,
        }),
        'signing'
      );
    });

    // The one signature this project will publish: compared before either
    // visible name is touched, so a build that somehow ran with another key
    // cannot replace the released APKs.
    if (releaseIdentityRequired({ generated: keystore.generated })) {
      const actual = certificateSha256(execFileSync(apksigner, ['verify', '--print-certs', signedInStaging], { encoding: 'utf8' }));
      if (actual !== brand.androidSigningCertificateSha256) {
        fail(`the APK is signed by ${actual}, not the release certificate ${brand.androidSigningCertificateSha256}`);
      }
      console.log(`android: signing certificate matches brand.json (${actual})`);
    } else {
      console.warn('android: the signing certificate was not compared with brand.json (test key or generated key)');
    }

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
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`android: ${error instanceof BuildError ? error.message : (error.stack ?? error.message)}`);
    process.exit(1);
  });
}
