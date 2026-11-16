/**
 * A1: `brand.json` is the only authored product identity.
 *
 * Every generated surface is compared byte-for-byte with its renderer, the
 * hand-authored surfaces (index.html, README, package.json) are checked for the
 * same fact, and a tree scan proves the name was not copied into a second
 * owner. A generated file may never ship a placeholder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { BRAND } from '../src/core/brand.js';
import {
  OUTPUTS,
  assertNoPlaceholders,
  buildBrand,
  checkBrand,
  parseBrand,
  readThemeColor,
  renderAll,
} from '../scripts/build-brand.mjs';
import { projectRoot, readProjectFile as read } from './helpers/project-files.mjs';

const brandJson = JSON.parse(read('brand.json'));
const pkg = JSON.parse(read('package.json'));

/** The walk skips generated/deliverable trees; no file in them is authored. */
const SKIP = /^(?:node_modules|\.run|\.git|_site|dist)(?:\/|$)|^android\/build(?:-|\/|$)/;

function walk(directory = '.') {
  const out = [];
  for (const entry of readdirSync(join(projectRoot, directory), { withFileTypes: true })) {
    const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
    if (SKIP.test(path)) continue;
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}

const BINARY = /\.(?:png|jpe?g|gif|ico|woff2?|jks|apk|zip|keystore)$/i;

/** Text files only: a binary cannot repeat a product name as prose. */
function textFiles() {
  return walk().filter((file) => !BINARY.test(file) && !file.endsWith('keystore.properties'));
}

function text(file) {
  const bytes = readFileSync(join(projectRoot, file));
  return bytes.subarray(0, 1024).includes(0) ? null : bytes.toString('utf8');
}

test('brand.json is the one authored identity and BRAND mirrors it', () => {
  assert.deepEqual(BRAND, brandJson);
  assert.equal(Object.isFrozen(BRAND), true, 'the generated module is frozen');
  assert.equal('version' in brandJson, false, 'package.json owns the version');
});

test('every generated file byte-equals its renderer', async () => {
  const result = await checkBrand();
  assert.equal(result.ok, true, 'run: node scripts/build-brand.mjs --write');
  const { brand, files } = await buildBrand();
  const expected = renderAll(brand, { background: readThemeColor(read('assets/app.css')), version: pkg.version });
  assert.deepEqual(files, expected);
  for (const [file, content] of Object.entries(files)) {
    assert.equal(read(file), content, `${file} is generated output`);
  }
  assert.deepEqual(Object.keys(files).sort(), Object.values(OUTPUTS).sort());
});

test('index.html and the README name the product from BRAND', () => {
  const index = read('index.html');
  assert.equal(index.match(/<title>([^<]+)<\/title>/)?.[1], BRAND.name, 'index.html <title>');
  // The wordmark element is compared as one literal, so a nested element or a
  // second word does not silently pass a tag-stripping comparison.
  assert.ok(
    index.includes(`<span class="brand-text">${BRAND.name}<span class="visually-hidden"> on GitHub</span></span>`),
    'the header wordmark is the brand name plus the link destination'
  );
  assert.equal(read('README.md').match(/^#\s+(.+)$/m)?.[1].trim(), BRAND.name, 'README H1');
});

test('package.json name and description are the brand fact', () => {
  assert.equal(pkg.name, brandJson.slug);
  assert.equal(pkg.description, brandJson.description);
});

test('package.json metadata mirrors the authored identity', () => {
  // npm needs the URLs in package.json; brand.json owns them. A rename edits
  // brand.json and this contract fails until the metadata follows.
  assert.equal(pkg.repository?.url, `${brandJson.repository}.git`);
  assert.equal(pkg.homepage, brandJson.homepage);
  assert.equal(pkg.bugs?.url, `${brandJson.repository}/issues`);
  assert.equal(pkg.license, brandJson.license);
  assert.equal(pkg.author, brandJson.author);
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the app has no runtime dependencies');
  assert.deepEqual(pkg.devDependencies ?? {}, { yaml: '^2.9.1' }, 'the one dev-only dependency is the workflow policy parser');
});

test('slug, application id and prefixes are lower-case and path-safe', () => {
  assert.match(brandJson.slug, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(brandJson.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
  assert.match(brandJson.storagePrefix, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(brandJson.cachePrefix, /^[a-z0-9][a-z0-9-]*-$/);
  for (const hostile of [
    { slug: 'Drypoint' },
    { slug: '../drypoint' },
    { appId: 'Drypoint' },
    { appId: 'dev.llm4people.dry point' },
    { storagePrefix: 'dry point' },
    { cachePrefix: 'drypoint' },
  ]) {
    assert.throws(() => parseBrand(JSON.stringify({ ...brandJson, ...hostile })), /path-safe|non-empty/);
  }
});

test('a generated file may never ship a placeholder', () => {
  assert.throws(() => assertNoPlaceholders('x', 'name {{name}}'), /placeholder/);
  for (const [file, content] of Object.entries(renderAll(BRAND, { background: '#08080a', version: pkg.version }))) {
    assert.doesNotMatch(content, /\{\{/, `${file} is fully rendered`);
  }
});

test('the generated Android strings carry the app label and repository link', () => {
  const strings = read(OUTPUTS.strings);
  assert.ok(strings.includes(`<string name="app_name">${BRAND.name}</string>`), 'the launcher label is the brand name');
  assert.ok(
    strings.includes(`<string name="repository_url" translatable="false">${BRAND.repository}</string>`),
    'Android gets the one external link from the brand owner'
  );
});

test('the generated header is present where the format allows', () => {
  const header = /Generated by scripts\/build-brand\.mjs; do not edit\./;
  assert.match(read(OUTPUTS.module), header);
  assert.match(read(OUTPUTS.version), header);
  assert.match(read(OUTPUTS.strings), header);
  assert.match(read(OUTPUTS.icon), header);
  // JSON has no comment syntax; the manifest is generated but cannot carry one.
  assert.doesNotThrow(() => JSON.parse(read(OUTPUTS.manifest)));
});

test('the app version is generated from package.json, not handwritten', () => {
  assert.match(read(OUTPUTS.version), new RegExp(`APP_VERSION = ${JSON.stringify(pkg.version)}`));
  assert.match(read('src/core/config.js'), /import \{ APP_VERSION \} from '\.\/version\.js'/);
  assert.doesNotMatch(read('src/core/config.js'), /version:\s*['"`]\d+\.\d+\.\d+/, 'config has no version literal');
});

test('the manifest colours mirror the CSS theme owner', () => {
  const manifest = JSON.parse(read(OUTPUTS.manifest));
  assert.equal(manifest.name, BRAND.name);
  assert.equal(manifest.short_name, BRAND.name);
  assert.equal(manifest.description, brandJson.shortDescription);
  assert.equal(manifest.background_color, readThemeColor(read('assets/app.css')));
  assert.equal(manifest.theme_color, manifest.background_color);
});

test('the product name has no owner outside brand.json and the read-only surfaces', () => {
  // index.html, the README and the public prose files are hand-authored by
  // design; docs and tests are prose and fixtures. Everything else must import
  // BRAND or a generated file.
  const publicProse = new Set([
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'SUPPORT.md',
    'CODE_OF_CONDUCT.md',
    'THIRD_PARTY_NOTICES.md',
  ]);
  const allowed = (file) =>
    file === 'brand.json' ||
    file === 'index.html' ||
    publicProse.has(file) ||
    file === OUTPUTS.manifest ||
    file === OUTPUTS.strings ||
    file === OUTPUTS.module ||
    file === OUTPUTS.icon ||
    file.startsWith(`docs${sep}`) ||
    file.startsWith(`test${sep}`) ||
    file.startsWith(`.github${sep}`) ||
    // The Android shell names its log tag after the product; the package path
    // is the application id, generated once into the manifest.
    file.startsWith(`android${sep}app${sep}src${sep}main${sep}java${sep}`);

  const offenders = [];
  for (const file of textFiles()) {
    const body = text(file);
    if (body === null || !body.includes(BRAND.name)) continue;
    if (!allowed(file)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `the product name is repeated outside its owners: ${offenders.join(', ')}`);
});

test('no legacy product identity survives the rename', () => {
  // Shipped code, docs and build files must be free of the old identity. Tests
  // are fixtures: this one and the Android signing test name the old strings to
  // prove they are gone.
  const skipLegacy = (file) => file.startsWith(`test${sep}`);
  const legacy = [
    'D110 Label Studio',
    'd110-studio',
    'd110.local',
    'D110Shell',
    'd110-release',
    'D110_KEYSTORE',
    'd110-sign',
    'd110-diagnostics',
    'd110.studio.v1',
  ];
  const hits = [];
  for (const file of textFiles()) {
    if (skipLegacy(file)) continue;
    const body = text(file);
    if (body === null) continue;
    for (const token of legacy) {
      if (body.includes(token)) hits.push(`${file}: ${token}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('no personal home-directory path is committed', () => {
  // A test helper used to carry one developer's Chromium path. Discovery is
  // D110_CHROME/CHROME_PATH/PATH now; no file may name a home directory.
  const hits = [];
  for (const file of textFiles()) {
    const body = text(file);
    if (body !== null && /\/home\/[a-z0-9._-]+\//i.test(body)) hits.push(file);
  }
  assert.deepEqual(hits, []);
});

test('the generated identity is what the app and the shell read', () => {
  assert.equal(read('src/core/config.js').includes("from './brand.js'"), true, 'CONFIG imports BRAND');
  assert.match(read('src/core/config.js'), /name: BRAND\.name/);
  assert.match(read('src/core/config.js'), /storagePrefix: BRAND\.storagePrefix/);
  assert.equal(statSync(join(projectRoot, OUTPUTS.strings)).isFile(), true);
});
