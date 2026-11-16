#!/usr/bin/env node
/**
 * Artifact-level check of a built APK.
 *
 * The workflow tests the template and the source tree; this checks the bytes a
 * user would install: the bundled `assets/www` surface is exactly the precache
 * manifest plus the distribution notices, no permission grants INTERNET, and
 * `allowBackup` is false.
 *
 * The package is a zip and the manifest is binary XML, so the check uses
 * `unzip` and `aapt2` from the Android build-tools the release already
 * installs. The pure rules live here so a test can drive them without an APK.
 *
 * Usage:
 *   node scripts/check-apk.mjs --apk android/build/drypoint.apk --aapt2 <path>
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import { DISTRIBUTION_FILES } from './lib/distribution.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
const WWW = 'assets/www/';

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

/** The badging output must not grant INTERNET to an offline app. */
export function badgingFindings(badging) {
  return /uses-permission:\s*name='android\.permission\.INTERNET'/.test(String(badging))
    ? ['the APK requests android.permission.INTERNET']
    : [];
}

/** The binary manifest tree must carry allowBackup=false. */
export function manifestXmlFindings(xmltree) {
  // aapt2 36 prints `(...)=false`; older builds print the typed scalar
  // `(...)=(type 0x12)0x0`. Both mean the same attribute value.
  const match = String(xmltree).match(/android:allowBackup\([^)]*\)\s*=\s*([^\r\n]+)/);
  const value = match?.[1].trim();
  if (!value || !/^(?:false|\(type 0x12\)0x0)$/.test(value)) {
    return ['AndroidManifest.xml does not set android:allowBackup="false"'];
  }
  return [];
}

/**
 * Check one APK. `exec` is injectable so the rule composition is testable.
 *
 * @param {{apk: string, aapt2: string, root?: string, exec?: Function}} options
 * @returns {{ok: boolean, findings: string[]}}
 */
export function checkApk({ apk, aapt2, root = ROOT, exec = execFileSync }) {
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
  return { ok: findings.length === 0, findings };
}

function parseArguments(argv) {
  const options = { apk: '', aapt2: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--apk') options.apk = argv[++index] ?? '';
    else if (argument === '--aapt2') options.aapt2 = argv[++index] ?? '';
    else throw new Error(`unknown option ${argument}`);
  }
  if (!options.apk) throw new Error('--apk is required');
  if (!options.aapt2) throw new Error('--aapt2 is required');
  return options;
}

function main(argv) {
  try {
    const result = checkApk(parseArguments(argv));
    if (result.ok) {
      console.log('apk: assets/www matches the precache manifest, no INTERNET permission, allowBackup=false');
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
