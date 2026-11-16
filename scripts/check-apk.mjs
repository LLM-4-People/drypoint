#!/usr/bin/env node
/**
 * Artifact-level check of a built APK.
 *
 * The workflow tests the template and the source tree; this checks the bytes a
 * user would install: the bundled `assets/www` surface is exactly the precache
 * manifest plus the distribution notices, no permission grants INTERNET
 * (including the API-23 form), `allowBackup` is false, exactly one exported
 * MAIN/LAUNCHER activity exists, no provider/service/receiver is declared, and
 * the package is not debuggable or cleartext-enabled. With `--apksigner` it
 * also requires the v2 and v3 signatures.
 *
 * The package is a zip and the manifest is binary XML, so the check uses
 * `unzip`, `aapt2` and `apksigner` from the Android build-tools the release
 * already installs. The pure rules live here so a test can drive them without
 * an APK.
 *
 * Usage:
 *   node scripts/check-apk.mjs --aapt2 <path> [--apksigner <path>] [--apk <path>]
 *
 * `--apk` defaults to `android/build/drypoint-<package.json version>.apk`, the
 * name `build-android.mjs` publishes. The workflow gate therefore passes the
 * tool paths only, so the gated command is one exact command with no shell
 * arithmetic around it.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import { DISTRIBUTION_FILES } from './lib/distribution.mjs';
import { minSdkVersionOf, targetSdkVersionOf, versionCodeOf } from './build-android.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
const WWW = 'assets/www/';
const INTERNET = /uses-permission(?:-sdk-23)?:\s*name='android\.permission\.INTERNET'/;

/** The version in package.json: one owner of the default artifact name. */
export function packageVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/** The APK `build-android.mjs` publishes for the current package version. */
export function defaultApkPath(root = ROOT) {
  return join(root, 'android', 'build', `drypoint-${packageVersion(root)}.apk`);
}

/** The generated precache manifest, read without importing the app. */
export function readPrecache(root = ROOT) {
  const source = readFileSync(join(root, 'assets', 'precache.js'), 'utf8');
  const sandbox = { self: {} };
  vm.runInNewContext(source, sandbox, { filename: 'assets/precache.js' });
  const manifest = sandbox.self.__PRECACHE;
  if (!manifest || !Array.isArray(manifest.files) || !manifest.digests) {
    throw new Error('assets/precache.js has no file list and digests');
  }
  return manifest;
}

/** Zip entry names under `assets/www/`, without the prefix. */
export function bundledFiles(entries) {
  return entries.filter((entry) => entry.startsWith(WWW)).map((entry) => entry.slice(WWW.length)).sort();
}

/**
 * Set equality between what the APK carries and what the two owners declare.
 * @returns {string[]} findings
 */
export function surfaceFindings({ manifest, distribution = DISTRIBUTION_FILES, entries }) {
  const expected = [...manifest.files, ...distribution].sort();
  const actual = bundledFiles(entries);
  const findings = [];
  for (const file of expected) {
    if (!actual.includes(file)) findings.push(`assets/www is missing ${file}`);
  }
  for (const file of actual) {
    if (!expected.includes(file)) findings.push(`assets/www carries an unexpected file ${file}`);
  }
  return findings;
}

/**
 * The identity the APK must carry: package from brand.json, versionName from
 * package.json, versionCode from the one arithmetic owner. `build-android.mjs`
 * exports `versionCodeOf`; importing it keeps a second formula out of the
 * artifact check.
 */
export function expectedIdentity({ root = ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const brand = JSON.parse(readFileSync(join(root, 'brand.json'), 'utf8'));
  return { package: brand.appId, versionCode: versionCodeOf(pkg.version), versionName: pkg.version };
}

/**
 * The platform levels the APK must carry, read from the manifest template, the
 * same owner the build renders. A template change that the artifact does not
 * carry then fails here instead of only in review.
 */
export function platformExpectations({ root = ROOT } = {}) {
  const template = readFileSync(join(root, 'android', 'AndroidManifest.template.xml'), 'utf8');
  return { minSdkVersion: minSdkVersionOf(template), targetSdkVersion: targetSdkVersionOf(template) };
}

/**
 * The badging output must name the exact package, versionCode and versionName,
 * must not grant INTERNET to an offline app, and must name exactly one launcher
 * activity. `uses-permission-sdk-23` applies at minSdk 26 just as
 * `uses-permission` does, so the optional suffix is not a bypass.
 */
export function badgingFindings(badging, expected = expectedIdentity()) {
  const text = String(badging);
  const findings = [];
  const identity = `package: name='${expected.package}' versionCode='${expected.versionCode}' versionName='${expected.versionName}'`;
  if (!text.split('\n').some((line) => line.startsWith(identity))) {
    findings.push(`the APK is not ${expected.package} ${expected.versionName} (versionCode ${expected.versionCode})`);
  }
  if (INTERNET.test(text)) findings.push('the APK requests android.permission.INTERNET');
  const launchers = text.split('\n').filter((line) => line.startsWith('launchable-activity: name=')).length;
  if (launchers !== 1) findings.push(`the APK must have exactly one MAIN/LAUNCHER activity, found ${launchers}`);
  return findings;
}

/**
 * The badging must report the minSdk/targetSdk the manifest template owns.
 * These are not cosmetic: minSdk decides the signing schemes and targetSdk is
 * the platform contract the WebView shell is tested against.
 */
export function platformFindings(badging, expected) {
  const text = String(badging);
  const min = Number(expected?.minSdkVersion);
  const target = Number(expected?.targetSdkVersion);
  if (!Number.isInteger(min) || !Number.isInteger(target)) {
    throw new Error('platformFindings needs integer minSdkVersion and targetSdkVersion');
  }
  const findings = [];
  const minMatch = text.match(/(?:^|\s)minSdkVersion:'(\d+)'/);
  if (!minMatch) findings.push('the APK does not report minSdkVersion');
  else if (Number(minMatch[1]) !== min) findings.push(`the APK reports minSdkVersion ${minMatch[1]}, expected ${min}`);
  const targetMatch = text.match(/(?:^|\s)targetSdkVersion:'(\d+)'/);
  if (!targetMatch) findings.push('the APK does not report targetSdkVersion');
  else if (Number(targetMatch[1]) !== target) findings.push(`the APK reports targetSdkVersion ${targetMatch[1]}, expected ${target}`);
  return findings;
}

/** Whether one xmltree line declares an exported component. */
const EXPORTED = /android:exported\([^)]*\)=true/;

/**
 * The binary manifest tree must carry allowBackup=false, exactly one exported
 * activity with MAIN/LAUNCHER, no provider/service/receiver, no debuggable flag
 * and no cleartext permission.
 */
export function manifestXmlFindings(xmltree) {
  const text = String(xmltree);
  const findings = [];
  // aapt2 36 prints `(...)=false`; older builds print the typed scalar
  // `(...)=(type 0x12)0x0`. Both mean the same attribute value.
  const match = text.match(/android:allowBackup\([^)]*\)\s*=\s*([^\r\n]+)/);
  const value = match?.[1].trim();
  if (!value || !/^(?:false|\(type 0x12\)0x0)$/.test(value)) {
    findings.push('AndroidManifest.xml does not set android:allowBackup="false"');
  }
  if (text.includes('android:debuggable')) findings.push('AndroidManifest.xml declares android:debuggable');
  if (text.includes('android:usesCleartextTraffic')) {
    findings.push('AndroidManifest.xml declares android:usesCleartextTraffic');
  }
  if (INTERNET.test(text) || text.includes('android.permission.INTERNET')) {
    findings.push('AndroidManifest.xml grants android.permission.INTERNET');
  }
  const components = text.match(/E: (provider|service|receiver)(?=\s|$)/g) ?? [];
  if (components.length) findings.push(`AndroidManifest.xml declares ${components.join(', ')}`);
  const activities = text.match(/E: activity(?=\s|$)/g) ?? [];
  const exported = text.match(new RegExp(EXPORTED.source, 'g')) ?? [];
  if (activities.length !== 1) {
    findings.push(`AndroidManifest.xml must declare exactly one activity, found ${activities.length}`);
  }
  if (exported.length !== 1) {
    findings.push(`AndroidManifest.xml must declare exactly one exported component, found ${exported.length}`);
  }
  if (!text.includes('android.intent.action.MAIN')) {
    findings.push('the launcher activity has no android.intent.action.MAIN filter');
  }
  if (!text.includes('android.intent.category.LAUNCHER')) {
    findings.push('the launcher activity has no android.intent.category.LAUNCHER filter');
  }
  return findings;
}

/**
 * `apksigner verify --verbose` must prove both modern schemes. v1 may be false:
 * the APK targets minSdk 26, where v2 is mandatory.
 */
export function signatureFindings(apksignerOutput) {
  const text = String(apksignerOutput);
  const findings = [];
  if (!/Verified using v2 scheme \(APK Signature Scheme v2\):\s*true/.test(text)) {
    findings.push('the APK has no verified v2 signature');
  }
  if (!/Verified using v3 scheme \(APK Signature Scheme v3\):\s*true/.test(text)) {
    findings.push('the APK has no verified v3 signature');
  }
  return findings;
}

/**
 * Check one APK. `exec` is injectable so the rule composition is testable.
 *
 * @param {{apk: string, aapt2: string, apksigner?: string, root?: string, exec?: Function}} options
 * @returns {{ok: boolean, findings: string[]}}
 */
export function checkApk({ apk, aapt2, apksigner = '', root = ROOT, expected, exec = execFileSync }) {
  const manifest = readPrecache(root);
  const identity = expected ?? expectedIdentity({ root });
  const entries = String(exec('unzip', ['-Z1', apk], { encoding: 'utf8' })).split('\n').filter(Boolean);
  const present = new Set(entries);
  const findings = surfaceFindings({ manifest, entries });

  // `surfaceFindings` already names a missing or unexpected file. Reading a
  // missing entry with `unzip -p` would abort the whole check with a tool
  // error and hide that rule, so the byte loops only visit present files.
  for (const file of manifest.files) {
    if (!present.has(`${WWW}${file}`)) continue;
    const body = exec('unzip', ['-p', apk, `${WWW}${file}`], { maxBuffer: 64 * 1024 * 1024 });
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== manifest.digests[file]) findings.push(`assets/www/${file} does not match its precache digest`);
  }
  for (const file of DISTRIBUTION_FILES) {
    if (!present.has(`${WWW}${file}`)) continue;
    const bundled = exec('unzip', ['-p', apk, `${WWW}${file}`], { maxBuffer: 64 * 1024 * 1024 });
    const authored = readFileSync(join(root, file));
    if (!bundled.equals(authored)) findings.push(`assets/www/${file} is not the authored notice`);
  }

  const badging = String(exec(aapt2, ['dump', 'badging', apk], { encoding: 'utf8' }));
  findings.push(...badgingFindings(badging, identity));
  findings.push(...platformFindings(badging, platformExpectations({ root })));
  findings.push(...manifestXmlFindings(exec(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], { encoding: 'utf8' })));
  if (apksigner) {
    let output = '';
    try {
      output = String(exec(apksigner, ['verify', '--verbose', apk], { encoding: 'utf8' }));
    } catch (error) {
      // `apksigner verify` exits nonzero for an unverifiable APK. Keep the
      // scheme findings (v1-only still names the missing v2) and name the tool
      // failure instead of aborting before the rule is printed.
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      const detail = String(error.stderr || error.message || '').split('\n')[0].trim();
      findings.push(`apksigner could not verify the APK${detail ? `: ${detail}` : ''}`);
    }
    findings.push(...signatureFindings(output));
  }
  return { ok: findings.length === 0, findings };
}

function parseArguments(argv) {
  const options = { apk: '', aapt2: '', apksigner: '', expected: null };
  const identity = { package: '', versionCode: '', versionName: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--apk') options.apk = argv[++index] ?? '';
    else if (argument === '--aapt2') options.aapt2 = argv[++index] ?? '';
    else if (argument === '--apksigner') options.apksigner = argv[++index] ?? '';
    else if (argument === '--package') identity.package = argv[++index] ?? '';
    else if (argument === '--version-code') identity.versionCode = argv[++index] ?? '';
    else if (argument === '--version-name') identity.versionName = argv[++index] ?? '';
    else throw new Error(`unknown option ${argument}`);
  }
  const overrides = Object.values(identity).filter(Boolean).length;
  if (overrides) {
    if (overrides !== 3) throw new Error('--package, --version-code and --version-name must be given together');
    const versionCode = Number(identity.versionCode);
    if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('--version-code must be a positive integer');
    options.expected = { package: identity.package, versionCode, versionName: identity.versionName };
  }
  if (!options.apk) options.apk = defaultApkPath();
  if (!options.aapt2) throw new Error('--aapt2 is required');
  return options;
}

function main(argv) {
  try {
    const result = checkApk(parseArguments(argv));
    if (result.ok) {
      console.log(
        'apk: assets/www matches the precache manifest, no INTERNET, allowBackup=false, one exported launcher, no extra components'
      );
      return 0;
    }
    for (const finding of result.findings) console.error(`apk: ${finding}`);
    return 1;
  } catch (error) {
    console.error(`apk: ${error.message}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
