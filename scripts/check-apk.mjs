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
 * The badging output must not grant INTERNET to an offline app, and must name
 * exactly one launcher activity. `uses-permission-sdk-23` applies at minSdk 26
 * just as `uses-permission` does, so the optional suffix is not a bypass.
 */
export function badgingFindings(badging) {
  const text = String(badging);
  const findings = [];
  if (INTERNET.test(text)) findings.push('the APK requests android.permission.INTERNET');
  const launchers = text.split('\n').filter((line) => line.startsWith('launchable-activity: name=')).length;
  if (launchers !== 1) findings.push(`the APK must have exactly one MAIN/LAUNCHER activity, found ${launchers}`);
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
export function checkApk({ apk, aapt2, apksigner = '', root = ROOT, exec = execFileSync }) {
  const manifest = readPrecache(root);
  const entries = String(exec('unzip', ['-Z1', apk], { encoding: 'utf8' })).split('\n').filter(Boolean);
  const findings = surfaceFindings({ manifest, entries });

  for (const file of manifest.files) {
    const body = exec('unzip', ['-p', apk, `${WWW}${file}`], { maxBuffer: 64 * 1024 * 1024 });
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== manifest.digests[file]) findings.push(`assets/www/${file} does not match its precache digest`);
  }
  for (const file of DISTRIBUTION_FILES) {
    const bundled = exec('unzip', ['-p', apk, `${WWW}${file}`], { maxBuffer: 64 * 1024 * 1024 });
    const authored = readFileSync(join(root, file));
    if (!bundled.equals(authored)) findings.push(`assets/www/${file} is not the authored notice`);
  }

  findings.push(...badgingFindings(exec(aapt2, ['dump', 'badging', apk], { encoding: 'utf8' })));
  findings.push(...manifestXmlFindings(exec(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], { encoding: 'utf8' })));
  if (apksigner) {
    findings.push(...signatureFindings(exec(apksigner, ['verify', '--verbose', apk], { encoding: 'utf8' })));
  }
  return { ok: findings.length === 0, findings };
}

function parseArguments(argv) {
  const options = { apk: '', aapt2: '', apksigner: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--apk') options.apk = argv[++index] ?? '';
    else if (argument === '--aapt2') options.aapt2 = argv[++index] ?? '';
    else if (argument === '--apksigner') options.apksigner = argv[++index] ?? '';
    else throw new Error(`unknown option ${argument}`);
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
