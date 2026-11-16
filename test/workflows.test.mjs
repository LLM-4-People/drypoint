/**
 * Workflow policy: an action tag is mutable, so every `uses:` must name a
 * commit, every job must be bounded, and the release must be tag-only.
 *
 * The synthetic workflows below are the failure cases; the real tree is then
 * held to the same rules, including the exact pinned allowlist and the one
 * aggregate job `required`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PINNED_ACTIONS,
  RELEASE_FILE,
  WORKFLOW_DIR,
  checkReleaseWorkflow,
  checkWorkflow,
  checkWorkflows,
  jobsOf,
  topLevelBlock,
  usesReferences,
} from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

/** A workflow that satisfies every policy rule. */
const VALID = `name: Example

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: example-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1
        with:
          persist-credentials: false
`;

test('a compliant workflow has no findings', () => {
  assert.deepEqual(checkWorkflow(VALID), []);
});

test('a tag or branch reference is rejected', () => {
  for (const reference of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@3d3c42e', `actions/checkout@${CHECKOUT_SHA.slice(1)}x`]) {
    const findings = checkWorkflow(VALID.replace(`actions/checkout@${CHECKOUT_SHA}`, reference));
    assert.ok(findings.some((finding) => /not pinned to a 40-character commit/.test(finding)), `${reference} is rejected`);
  }
});

test('an action outside the pinned allowlist is rejected', () => {
  const text = VALID.replace('actions/checkout@' + CHECKOUT_SHA, 'some/unknown-action@' + CHECKOUT_SHA);
  assert.ok(checkWorkflow(text).some((finding) => /not on the pinned action allowlist/.test(finding)));
  const wrongSha = VALID.replace(CHECKOUT_SHA, '0'.repeat(40));
  assert.ok(checkWorkflow(wrongSha).some((finding) => /must be pinned to/.test(finding)));
});

test('a missing permissions block is rejected', () => {
  const findings = checkWorkflow(VALID.replace('permissions:\n  contents: read\n\n', ''));
  assert.ok(findings.some((finding) => /no top-level permissions block/.test(finding)));
});

test('a missing concurrency block is rejected', () => {
  const findings = checkWorkflow(VALID.replace(/concurrency:\n(?: {2}.*\n)+/, ''));
  assert.ok(findings.some((finding) => /no top-level concurrency block/.test(finding)));
});

test('pull_request_target is banned outright', () => {
  const findings = checkWorkflow(VALID.replace('pull_request:', 'pull_request_target:'));
  assert.ok(findings.some((finding) => /pull_request_target is banned/.test(finding)));
});

test('a job without timeout-minutes is rejected', () => {
  const findings = checkWorkflow(VALID.replace('    timeout-minutes: 5\n', ''));
  assert.ok(findings.some((finding) => /job "build" has no timeout-minutes/.test(finding)));
});

test('write-all is rejected and a checkout must not persist credentials', () => {
  const writeAll = VALID.replace('  contents: read', '  write-all');
  assert.ok(checkWorkflow(writeAll).some((finding) => /write-all/.test(finding)));
  const persisting = VALID.replace('          persist-credentials: false\n', '');
  assert.ok(checkWorkflow(persisting).some((finding) => /persist-credentials: false/.test(finding)));
});

test('the release workflow must be tag-only and verify the tag', () => {
  const release = `name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Publish
        run: gh release create "$GITHUB_REF_NAME" --verify-tag
`;
  assert.deepEqual(checkReleaseWorkflow(release), []);
  assert.ok(checkReleaseWorkflow(release.replace("tags: ['v*']", 'branches: [main]')).some((finding) => /must trigger on tags/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace('    tags:', '    branches: [main]\n    tags:')).some((finding) => /must not trigger on branches/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace(' --verify-tag', '')).some((finding) => /--verify-tag/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace('  push:', '  pull_request:')).some((finding) => /must not trigger on pull_request/.test(finding)));
});

test('every workflow file in the tree satisfies the policy', async () => {
  const { findings, files } = await checkWorkflows();
  assert.deepEqual(findings, []);
  assert.deepEqual(files, [
    'actionlint.yml',
    'checks.yml',
    'codeql.yml',
    'dependency-review.yml',
    'docs.yml',
    'pages.yml',
    RELEASE_FILE,
    'scorecard.yml',
    'stale.yml',
  ]);
});

test('the pinned allowlist is exactly the briefed commits', () => {
  assert.deepEqual(PINNED_ACTIONS, {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1',
    'actions/setup-java': 'd1374f8ac74474200d16ef8ecee22c7ae7a51880',
    'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
    'actions/download-artifact': '9000827ccba6bdab643e8b6fd33ac0654aef8333',
    'actions/attest-build-provenance': '4d101475d8b20a2381f78447822ac1eab6504dd8',
    'actions/dependency-review-action': 'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
    'actions/configure-pages': '45bfe0192ca1faeb007ade9deae92b16b8254a0d',
    'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
    'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346',
    'github/codeql-action': '33d7b85da1a04171e211befe2c739303b9a4c066',
    'ossf/scorecard-action': 'fa7117db83c52d787ae5a89f350999701505d78e',
    'actions/stale': '4391f3da665fdf50b6810c1a66712fb9ba21aa93',
    'actions/github-script': '3a2844b7e9c422d3c10d287c895573f7108da1b3',
    'raven-actions/actionlint': '3d39aea434753780c3b3d4a1a31c854b4dbf49d7',
  });
});

test('every action used is on the allowlist, and every allowlisted action is used', async () => {
  const files = await readdir(join(projectRoot, WORKFLOW_DIR));
  const used = new Map();
  for (const name of files) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8');
    for (const reference of usesReferences(text)) {
      const [action, sha] = reference.value.split('@');
      const repo = action.split('/').slice(0, 2).join('/');
      assert.equal(sha, PINNED_ACTIONS[repo], `${name}: ${repo} uses the pinned commit`);
      used.set(repo, (used.get(repo) ?? 0) + 1);
    }
  }
  assert.deepEqual([...used.keys()].sort(), Object.keys(PINNED_ACTIONS).sort(), 'no unused pin, no unpinned action');
});

test('every workflow runs on ubuntu-24.04', async () => {
  const files = await readdir(join(projectRoot, WORKFLOW_DIR));
  for (const name of files) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8');
    const runners = [...text.matchAll(/^\s+runs-on:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    assert.ok(runners.length > 0, `${name} declares a runner`);
    for (const runner of runners) assert.equal(runner, 'ubuntu-24.04', `${name} runs on the pinned image`);
  }
});

test('the aggregate job is named required and is the only one', async () => {
  const checks = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  const jobs = jobsOf(checks);
  assert.deepEqual(jobs.map((job) => job.name), ['web', 'browser', 'android', 'required']);
  const required = jobs.find((job) => job.name === 'required');
  assert.match(required.block, /^ {4}if: always\(\)$/m, 'it runs even when a leg failed');
  assert.match(required.block, /^ {4}needs: \[web, browser, android\]$/m);
  assert.match(required.block, /!== 'success'/, 'anything other than success fails it');
  assert.match(required.block, /core\.setFailed/, 'the failure is a failed check');

  for (const name of (await readdir(join(projectRoot, WORKFLOW_DIR)))) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8');
    if (name === 'checks.yml') continue;
    assert.equal(jobsOf(text).some((job) => job.name === 'required'), false, `${name} has no second required job`);
  }
});

test('checks.yml proves generated files did not drift and the browser fails closed', async () => {
  const checks = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  assert.match(checks, /node: \['22', '24'\]/, 'the web matrix covers both supported Node lines');
  assert.match(checks, /npm run build:brand -- --check/);
  assert.match(checks, /npm run check:precache/);
  assert.match(checks, /git diff --exit-code/, 'a build that rewrote a generated file fails');
  assert.match(checks, /D110_CHROME=/, 'the browser job names the browser explicitly');
  assert.match(checks, /CI: 'true'/, 'a missing browser fails, never skips');
  assert.match(checks, /ANDROID_PLATFORM: android-36/);
  assert.match(checks, /ANDROID_BUILD_TOOLS: '36\.0\.0'/);
  assert.match(checks, /apksigner.*verify/s);
});

test('the release builds with the same pinned Android toolchain the gate proved', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  assert.match(release, /ANDROID_PLATFORM: android-36/, 'the release names the platform');
  assert.match(release, /ANDROID_BUILD_TOOLS: '36\.0\.0'/, 'the release names the build tools');
  assert.match(release, /platforms;\$ANDROID_PLATFORM/, 'the release installs the platform it names');
  assert.match(release, /build-tools;\$ANDROID_BUILD_TOOLS/, 'the release installs the build tools it names');
});

test('the release publishes the APK, checksum and changelog notes', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  const jobs = jobsOf(release);
  const build = jobs.find((job) => job.name === 'build').block;
  const publish = jobs.find((job) => job.name === 'publish').block;

  assert.doesNotMatch(build, /contents:\s*write/, 'the build cannot write to the repository');
  assert.match(publish, /contents:\s*write/, 'only the publish job can create the release');
  assert.doesNotMatch(topLevelBlock(release, 'permissions'), /write/);

  assert.match(release, /release-notes\.mjs --tag "\$GITHUB_REF_NAME"/, 'the tag is checked against package.json by the tested script');
  assert.match(release, /sha256sum/, 'the checksum file is generated from the APK bytes');
  assert.match(release, /\.apk\.sha256/);
  assert.match(release, /actions\/attest-build-provenance@/);
  assert.match(release, /gh release create/);
  assert.match(release, /--verify-tag/);
  assert.doesNotMatch(release, /--draft/, 'a release is never a draft');
  assert.match(release, /--latest/, 'a non-prerelease is the latest release');
  assert.match(release, /--prerelease/);
  assert.match(release, /git diff --exit-code/, 'the build may not rewrite a tracked file');
  assert.match(release, /ANDROID_KEYSTORE_BASE64/);
  assert.match(release, /base64 --decode/);
});

test('pages deploys the staged site and smoke-tests the real responses', async () => {
  const pages = await readFile(join(projectRoot, WORKFLOW_DIR, 'pages.yml'), 'utf8');
  assert.match(pages, /^concurrency:\n  group: pages\n  cancel-in-progress: false$/m);
  const deploy = jobsOf(pages).find((job) => job.name === 'deploy').block;
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
  assert.match(deploy, /name: github-pages/);
  assert.match(pages, /npm run pages:build/);
  assert.match(pages, /node scripts\/build-pages\.mjs --check/);
  for (const path of ['/sw.js', '/manifest.webmanifest', '/assets/precache.js']) {
    assert.ok(pages.includes(`probe ${path}`), `the smoke test requests ${path}`);
  }
  assert.match(pages, /application\/manifest\+json/);
  assert.match(pages, /did not answer 200/);
});

test('docs runs on Markdown and workflow changes and runs every repository gate', async () => {
  const docs = await readFile(join(projectRoot, WORKFLOW_DIR, 'docs.yml'), 'utf8');
  const paths = docs.match(/paths:\n(?:\s+- .*\n)+/g) ?? [];
  assert.equal(paths.length, 2, 'both push and pull_request filter on paths');
  for (const block of paths) assert.match(block, /- '\*\*\/\*\.md'/);
  for (const script of ['npm run docs:check', 'npm run workflows:check', 'npm run privacy:check', 'npm run build:brand -- --check']) {
    assert.ok(docs.includes(script), `docs.yml runs ${script}`);
  }
});
