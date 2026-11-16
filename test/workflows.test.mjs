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
  needsOf,
  shellCommands,
  topLevelBlock,
  usesReferences,
} from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';
import { collectFiles } from '../scripts/precache.mjs';
import { DISTRIBUTION_FILES } from '../scripts/lib/distribution.mjs';
import { manifestTypeProblem, probe, probeMethod, smokePaths } from '../scripts/smoke-pages.mjs';

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

test('a uses: line inside a run: script is not an action reference', () => {
  // Scanning the whole file as one blob reported an echo as an unpinned action,
  // and — worse — a real pin could hide behind that noise.
  const text = VALID.replace(
    '    steps:\n',
    '    steps:\n      - name: Echo\n        run: |\n          echo "uses: actions/checkout@v1"\n          echo done\n'
  );
  assert.deepEqual(checkWorkflow(text), [], 'a script line is not workflow YAML');
  // The real reference beside it is still read.
  const planted = text.replace(`uses: actions/checkout@${CHECKOUT_SHA}`, 'uses: actions/checkout@v7');
  assert.ok(checkWorkflow(planted).some((finding) => /not pinned to a 40-character commit/.test(finding)), 'the real one is still checked');
});

test('uses with a space before the colon is still a reference', () => {
  const spaced = VALID.replace('uses: actions/checkout@', 'uses : actions/checkout@');
  assert.deepEqual(checkWorkflow(spaced), [], 'the same action, the same pin, accepted');
  const unpinned = spaced.replace(CHECKOUT_SHA, 'v7');
  assert.ok(checkWorkflow(unpinned).some((finding) => /not pinned to a 40-character commit/.test(finding)), 'spacing is not a bypass');
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

test('write-all and read-all are rejected in every declaration, quoted or not', () => {
  const scalar = (value) => VALID.replace('permissions:\n  contents: read', `permissions: ${value}`);
  const nested = (value) => VALID.replace('  contents: read', `  ${value}`);
  const jobLevel = (value) => VALID.replace('    timeout-minutes: 5', `    timeout-minutes: 5\n    permissions: ${value}`);
  const quotedKey = (value) => VALID.replace('permissions:\n  contents: read', `"permissions": ${value}`);
  const quotedNestedKey = (value) => VALID.replace('permissions:\n  contents: read', `"permissions":\n  ${value}`);

  for (const value of ['write-all', '"write-all"', "'write-all'", 'read-all', '"read-all"', "'read-all'"]) {
    assert.ok(checkWorkflow(scalar(value)).some((finding) => /write-all\/read-all/.test(finding)), `inline ${value} is rejected`);
    assert.ok(checkWorkflow(nested(value)).some((finding) => /write-all\/read-all/.test(finding)), `nested ${value} is rejected`);
    assert.ok(checkWorkflow(jobLevel(value)).some((finding) => /write-all\/read-all/.test(finding)), `job-level ${value} overrides the default and is rejected`);
    assert.ok(checkWorkflow(quotedKey(value)).some((finding) => /write-all\/read-all/.test(finding)), `quoted key with ${value} is rejected`);
    assert.ok(
      checkWorkflow(quotedNestedKey(value)).some((finding) => /write-all\/read-all/.test(finding)),
      `quoted key with nested ${value} is rejected`
    );
  }

  // A per-scope grant is the supported shape in either key spelling, and a
  // comment mentioning the banned token is not a declaration.
  assert.deepEqual(checkWorkflow(VALID), []);
  assert.deepEqual(checkWorkflow(VALID.replace('permissions:', '"permissions":')), []);
  assert.deepEqual(checkWorkflow(VALID.replace('  contents: read', '  contents: read # never write-all')), []);

  const persisting = VALID.replace('          persist-credentials: false\n', '');
  assert.ok(checkWorkflow(persisting).some((finding) => /persist-credentials: false/.test(finding)));
});

test('a trailing comment does not relax the permissions rule', () => {
  // `permissions: write-all  # temporary` grants exactly what the bare form
  // grants; the `\s*$` anchor used to make the comment a bypass.
  assert.ok(checkWorkflow(VALID.replace('  contents: read', '  write-all  # temporary')).some((finding) => /write-all/.test(finding)));
  assert.ok(checkWorkflow(VALID.replace('  contents: read', '  read-all # TODO')).some((finding) => /write-all\/read-all/.test(finding)));
  // A comment that merely mentions it is not a grant.
  assert.deepEqual(checkWorkflow(VALID.replace('  contents: read', '  contents: read # never write-all')), []);
});

test('the aggregate lists every job and derives its result from toJSON(needs)', () => {
  const aggregate = ({
    extra = '',
    results = '            const results = ${{ toJSON(needs) }};\n            core.setFailed(JSON.stringify(results));',
  } = {}) => `name: Aggregate

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: aggregate
  cancel-in-progress: true

jobs:
  web:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: echo web
  browser:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    needs: [web]
    steps:
      - run: echo browser
  android:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    needs: [web]
    steps:
      - run: echo android
${extra}  required:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    if: always()
    needs: [web, browser, android]
    steps:
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
        with:
          script: |
${results}
`;

  assert.deepEqual(checkWorkflow(aggregate(), { file: 'checks.yml' }), [], 'the real shape is accepted');

  const unlisted = aggregate({
    extra: '  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo lint\n',
  });
  assert.ok(
    checkWorkflow(unlisted, { file: 'checks.yml' }).some((finding) => /job "lint" is not listed in required\.needs/.test(finding)),
    'a new job cannot quietly stay outside the aggregate'
  );

  const explicit = aggregate({
    results: '            const results = { web: "${{ needs.web.result }}", browser: "${{ needs.browser.result }}", android: "${{ needs.android.result }}" };',
  });
  assert.ok(
    checkWorkflow(explicit, { file: 'checks.yml' }).some((finding) => /must derive its result from toJSON\(needs\)/.test(finding)),
    'a hand-built results map is drift, even when it names every leg today'
  );

  const mixed = aggregate({
    results:
      '            const all = ${{ toJSON(needs) }};\n            core.info(JSON.stringify(all));\n            const web = "${{ needs.web.result }}";',
  });
  assert.ok(
    checkWorkflow(mixed, { file: 'checks.yml' }).some((finding) => /hardcodes a leg name/.test(finding)),
    'the toJSON expression does not excuse a second hardcoded leg read'
  );

  const unused = aggregate({ results: '            const results = ${{ toJSON(needs) }};' });
  assert.ok(
    checkWorkflow(unused, { file: 'checks.yml' }).some((finding) => /never reads it/.test(finding)),
    'assigning the expression and ignoring it is not a derived result'
  );

  assert.deepEqual(needsOf(jobsOf(aggregate()).find((job) => job.name === 'required').block), ['web', 'browser', 'android']);
});

test('the release workflow is tag-only and verifies the tag on the publish command', () => {
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
        run: |
          gh release create \\
            "$GITHUB_REF_NAME" \\
            "dist/drypoint.apk" \\
            --verify-tag
`;
  assert.deepEqual(checkReleaseWorkflow(release), []);
  assert.ok(checkReleaseWorkflow(release.replace("tags: ['v*']", 'branches: [main]')).some((finding) => /must trigger on tags/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace('    tags:', '    branches: [main]\n    tags:')).some((finding) => /must not trigger on branches/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace(/--verify-tag/g, '')).some((finding) => /--verify-tag/.test(finding)));
  assert.ok(checkReleaseWorkflow(release.replace('  push:', '  pull_request:')).some((finding) => /must not trigger on pull_request/.test(finding)));

  // The flag on an unrelated command is the bypass: it was found anywhere in
  // the run block, so an echo satisfied the gate while the publish did not.
  const unrelated = release.replace('            --verify-tag\n', '').replace('          gh release create', '          echo --verify-tag\n          gh release create');
  assert.ok(
    checkReleaseWorkflow(unrelated).some((finding) => /--verify-tag on the gh release create command itself/.test(finding)),
    'an echo is not the publish command'
  );

  // A commented-out flag is not a flag, including one inside the command.
  const commented = release.replace('            --verify-tag', '            # --verify-tag');
  assert.ok(checkReleaseWorkflow(commented).some((finding) => /--verify-tag/.test(finding)));

  // A flag collected in an array and expanded later is not visible on the
  // publish command, so the static check refuses it.
  const assembled = release.replace('            --verify-tag', '').replace('          gh release create', '          args+=(--verify-tag)\n          gh release create');
  assert.ok(checkReleaseWorkflow(assembled).some((finding) => /--verify-tag/.test(finding)));

  // An unrelated command before the publish does not satisfy it either.
  const chained = release
    .replace('            --verify-tag\n', '')
    .replace('          gh release create', '          echo --verify-tag && gh release create');
  assert.ok(checkReleaseWorkflow(chained).some((finding) => /--verify-tag/.test(finding)));
});

test('every workflow file in the tree satisfies the policy', async () => {
  const { findings, files } = await checkWorkflows();
  assert.deepEqual(findings, []);
  assert.deepEqual(files, [
    'actionlint.yml',
    'checks.yml',
    'codeql.yml',
    'dependency-review.yml',
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
  assert.match(required.block, /toJSON\(needs\)/, 'the legs are read from the needs map, not a copied list');
  assert.doesNotMatch(required.block, /needs\.[A-Za-z0-9_-]+/, 'no leg is hardcoded');
  assert.match(required.block, /!== 'success'/, 'anything other than success fails it');
  assert.match(required.block, /core\.setFailed/, 'the failure is a failed check');

  for (const name of (await readdir(join(projectRoot, WORKFLOW_DIR)))) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8');
    if (name === 'checks.yml') continue;
    assert.equal(jobsOf(text).some((job) => job.name === 'required'), false, `${name} has no second required job`);
  }
});

test('checks.yml runs the gates, covers the Node matrix and proves the APK identity', async () => {
  const checks = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  assert.match(checks, /node: \['22', '24', '26'\]/, 'the web matrix covers every supported Node line');
  assert.match(checks, /npm run build:brand -- --check/);
  assert.match(checks, /npm run check:precache/);
  assert.match(checks, /npm run docs:check/, 'the documentation gate is in the merge gate');
  assert.match(checks, /node scripts\/build-docs\.mjs --check/, 'the generated docs blocks are in the merge gate');
  assert.match(checks, /npm run workflows:check/, 'the workflow policy is in the merge gate');
  assert.match(checks, /git diff --exit-code/, 'a build that rewrote a generated file fails');
  assert.match(checks, /git status --porcelain/, 'an untracked generated file fails too');
  assert.match(checks, /D110_CHROME=/, 'the browser job names the browser explicitly');
  assert.match(checks, /CI: 'true'/, 'a missing browser fails, never skips');
  assert.match(checks, /ANDROID_PLATFORM: android-36/);
  assert.match(checks, /ANDROID_BUILD_TOOLS: '36\.0\.0'/);
  assert.match(checks, /bash scripts\/android-sdk\.sh/, 'the toolchain install is one shared script');
  assert.match(checks, /apksigner.*verify/s);
  // The package the phone installs, not only its versionName.
  assert.match(checks, /brand\.json'\)\.appId/);
  assert.match(checks, /--version-code/);
  assert.match(checks, /versionCode='\$\{version_code\}'/);
  assert.match(checks, /ANDROID_ALLOW_TEST_KEY: 'true'/, 'the gate declares its throwaway key');
});

test('the Android toolchain is installed by one script, with no masked licence failure', async () => {
  const script = await readFile(join(projectRoot, 'scripts', 'android-sdk.sh'), 'utf8');
  assert.match(script, /platforms;\$\{ANDROID_PLATFORM\}/);
  assert.match(script, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/);
  assert.match(script, /All SDK package licenses accepted/, 'only the known benign outcome is accepted');
  assert.doesNotMatch(script, /--licenses[^\n]*\|\|\s*true/, 'a licence failure is not masked');
  assert.match(script, /set \+o pipefail/, "yes's SIGPIPE is not read as a licence failure");
  for (const workflow of ['checks.yml', RELEASE_FILE]) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, workflow), 'utf8');
    assert.match(text, /bash scripts\/android-sdk\.sh/, `${workflow} uses the one script`);
    assert.doesNotMatch(text, /sdkmanager" --licenses/, `${workflow} does not keep a second copy`);
  }
});

test('the release builds with the same pinned Android toolchain the gate proved', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  assert.match(release, /ANDROID_PLATFORM: android-36/, 'the release names the platform');
  assert.match(release, /ANDROID_BUILD_TOOLS: '36\.0\.0'/, 'the release names the build tools');
});

test('a tag off main cannot publish, and the build runs in the release environment', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  const build = jobsOf(release).find((job) => job.name === 'build').block;
  // A depth-1 clone cannot answer "is this commit on main?", so the checkout
  // fetches the history and the tags the check needs.
  assert.match(build, /fetch-depth: 0/);
  assert.match(build, /fetch-tags: true/);
  assert.match(release, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/, 'the tagged commit must be an ancestor of main');
  assert.match(release, /is not an ancestor of origin\/main/, 'the refusal is explicit');
  assert.match(build, /^ {4}environment: release$/m, 'the build job uses the v* -scoped environment');
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
  assert.doesNotMatch(release, /--prerelease/, 'tags are strict vMAJOR.MINOR.PATCH, so the prerelease branch was dead');
  assert.doesNotMatch(release, /--draft/, 'a release is never a draft');
  assert.match(release, /--latest/, 'a release is the latest release');
  assert.match(release, /git diff --exit-code/, 'the build may not rewrite a tracked file');
  assert.match(release, /git status --porcelain/, 'nor leave an untracked one');
  assert.match(release, /ANDROID_KEYSTORE_BASE64/);
  assert.match(release, /base64 --decode/);
});

test('the release attaches the provenance bundle and checks the built APK', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  assert.match(
    release,
    /gh attestation download "drypoint-\$\{version\}\.apk" -R "\$GITHUB_REPOSITORY"/,
    'the bundle is downloaded for the attested subject'
  );
  assert.match(release, /sha256-\*\.jsonl/, 'download writes sha256-<digest>.jsonl');
  assert.match(release, /drypoint-\$\{version\}\.apk\.intoto\.jsonl/, 'the bundle is renamed to the release asset');
  assert.doesNotMatch(release, /attestation download[^\n]*--bundle/, 'gh attestation download has no --bundle flag');
  const publishes = shellCommands(release).filter((command) => /(?:^|\s)gh\s+release\s+create(?:\s|$)/.test(command));
  assert.equal(publishes.length, 1, 'one publish command');
  assert.ok(
    publishes[0].includes('"dist/drypoint-${version}.apk.intoto.jsonl"'),
    'the bundle is passed to gh release create'
  );
  assert.match(release, /node scripts\/check-apk\.mjs/, 'the built bytes are checked, not only the template');
  assert.match(release, /--aapt2 "\$ANDROID_HOME\/build-tools\/\$ANDROID_BUILD_TOOLS\/aapt2"/);
  assert.match(release, /"drypoint-\$\{version\}\.apk\.intoto\.jsonl"; do/, 'a re-run compares the bundle too');
});

test('actionlint is downloaded directly and checksum-verified', async () => {
  const actionlint = await readFile(join(projectRoot, WORKFLOW_DIR, 'actionlint.yml'), 'utf8');
  assert.match(actionlint, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(actionlint, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(actionlint, /sha256sum -c -/, 'the archive is verified before extraction');
  assert.match(actionlint, /tar -xzf/);
  assert.match(actionlint, /run: actionlint -color/);
  assert.doesNotMatch(actionlint, /raven-actions\/actionlint/, 'the unverified action is gone');
});

test('re-running the release for an existing tag verifies it instead of failing', async () => {
  const release = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  const publish = jobsOf(release).find((job) => job.name === 'publish').block;
  assert.match(publish, /gh release view "\$GITHUB_REF_NAME"/, 'an existing release is detected');
  assert.match(publish, /gh release download "\$GITHUB_REF_NAME"/, 'its assets are fetched for comparison');
  assert.match(publish, /cmp -s "dist\/\$\{asset\}" "\$RUNNER_TEMP\/existing\/\$\{asset\}"/, 'the bytes are compared, not the names');
  assert.match(publish, /differs from this build/, 'a different asset fails the job');
  assert.match(publish, /already exists with these exact assets/);
  assert.match(publish, /exit 0/, 'an identical release is a pass, not a failure');
});

test('pages checks out main, then proves it is the commit Checks validated', async () => {
  const pages = await readFile(join(projectRoot, WORKFLOW_DIR, 'pages.yml'), 'utf8');
  assert.match(pages, /^concurrency:\n  group: pages\n  cancel-in-progress: false$/m);
  assert.match(pages, /workflow_run:/, 'the trigger is the Checks run');
  assert.match(pages, /workflows: \[Checks\]/);
  assert.match(pages, /types: \[completed\]/);
  assert.match(pages, /branches: \[main\]/);
  assert.match(pages, /github\.event\.workflow_run\.conclusion == 'success'/, 'a red run cannot deploy');

  // No checkout may interpolate a SHA from the triggering event: Scorecard
  // flags that pattern even when a step guard protects it. The constant ref is
  // checked out and the next step proves it is the validated commit.
  const refs = [...pages.matchAll(/^\s+ref:\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.equal(refs.some((ref) => ref.includes('head_sha')), false, 'no checkout interpolates head_sha');
  assert.equal(refs.filter((ref) => ref === 'main').length, 2, 'both workflow_run checkouts use main');
  assert.equal(refs.filter((ref) => ref === 'refs/heads/main').length, 2, 'both manual checkouts use the constant main ref');

  // The guard that makes the run one of *this* repository on main sits on the
  // checkout it protects, for both jobs that check the commit out.
  assert.equal(
    (pages.match(/github\.event\.workflow_run\.head_repository\.full_name == github\.repository/g) ?? []).length,
    2,
    'each checkout refuses a run from a fork'
  );
  assert.equal(
    (pages.match(/expected="\$\{\{ github\.event\.workflow_run\.head_sha \}\}"/g) ?? []).length,
    2,
    'both jobs compare the checked-out commit with the run head'
  );
  assert.equal((pages.match(/actual="\$\(git rev-parse HEAD\)"/g) ?? []).length, 2, 'both jobs read HEAD');
  assert.equal((pages.match(/if \[ "\$actual" != "\$expected" \]/g) ?? []).length, 2, 'both jobs refuse a moved main');

  const jobs = jobsOf(pages);
  assert.deepEqual(jobs.map((job) => job.name), ['build', 'deploy', 'smoke']);
  for (const name of ['build', 'smoke']) {
    const block = jobs.find((job) => job.name === name).block;
    assert.match(block, /ref: main/, `${name} checks out main`);
    assert.match(block, /The checked-out commit is the one Checks validated/, `${name} asserts the commit`);
    assert.match(block, /git rev-parse HEAD/, `${name} reads the real HEAD`);
  }

  const deploy = jobs.find((job) => job.name === 'deploy').block;
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
  assert.match(deploy, /name: github-pages/);
  // The only job with `pages: write` runs one pinned action: it checks out no
  // code and runs no shell, so no commit's code can reach that token.
  assert.doesNotMatch(deploy, /actions\/checkout@/, 'the privileged job checks nothing out');
  assert.doesNotMatch(deploy, /^\s+run:/m, 'the privileged job runs no shell');
  assert.equal((deploy.match(/uses:/g) ?? []).length, 1, 'one action, the deploy');
  assert.match(deploy, /outputs:\n\s+page_url:/, 'it reports the deployed URL to the smoke job');
  assert.match(pages, /permissions:\n\s+contents: read\n\s+steps:/, 'the smoke job is read-only');
  assert.match(pages, /npm run pages:build/);
  assert.match(pages, /node scripts\/build-pages\.mjs --check/);
  assert.match(pages, /node scripts\/smoke-pages\.mjs --base "\$BASE_URL" --cache-bust "\$RUN_ID"/, 'the smoke test reads the worker manifest');

  // The operator override is stated where the trigger is defined.
  assert.match(pages, /manual dispatch[\s\S]{0,200}without a Checks run/i);
  assert.match(pages, /operator override/i);
});

test('the pages smoke test covers every precached file and notice exactly once', async () => {
  const paths = await smokePaths();
  const files = await collectFiles();
  const notices = DISTRIBUTION_FILES.map((file) => `/${file}`);
  assert.ok(files.length >= 64, `the runtime surface lists every file (${files.length})`);
  assert.deepEqual(
    paths,
    ['/', ...files.map((file) => `/${file}`), ...notices].sort(),
    'every runtime file, the document root and every distribution notice'
  );
  assert.equal(paths.filter((path) => path === '/').length, 1, 'the root is requested once');
  assert.equal(paths.includes('/manifest.webmanifest'), true);
  for (const notice of notices) assert.ok(paths.includes(notice), `${notice} is probed`);
  assert.equal(manifestTypeProblem('application/manifest+json; charset=utf-8'), null);
  assert.match(manifestTypeProblem('text/plain'), /served as "text\/plain"/);
  assert.match(manifestTypeProblem(null), /no content type/);

  // GET where a body proves the file exists (the manifest and the notices);
  // HEAD is enough for a binary asset.
  assert.equal(probeMethod('/'), 'HEAD');
  assert.equal(probeMethod('/assets/app.css'), 'HEAD');
  assert.equal(probeMethod('/manifest.webmanifest'), 'GET');
  for (const notice of notices) assert.equal(probeMethod(notice), 'GET', `${notice} uses GET`);
});

test('a deployment that forgot a notice fails the smoke probe', async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (url.endsWith('/LICENSE')) return { status: 404, headers: { get: () => null } };
    return { status: 200, headers: { get: () => 'text/plain' } };
  };
  await assert.rejects(
    probe('https://example.test/drypoint/', '/LICENSE', {
      attempts: 2,
      delayMs: 0,
      fetchImpl,
      sleep: async () => {},
    }),
    /never answered 200/
  );
  assert.deepEqual(methods, ['GET', 'GET'], 'the notice is fetched twice and then refused');
});

test('codeql analyses the Android shell too', async () => {
  const codeql = await readFile(join(projectRoot, WORKFLOW_DIR, 'codeql.yml'), 'utf8');
  assert.match(codeql, /- language: java-kotlin/);
  assert.match(codeql, /- language: java-kotlin\n\s+build-mode: none/, 'no SDK or Gradle build is needed');
  assert.match(codeql, /build-mode: \$\{\{ matrix\.build-mode \}\}/);
  for (const language of ['javascript-typescript', 'actions']) {
    assert.match(codeql, new RegExp(`- language: ${language}\\n\\s+build-mode: none`));
  }
});

test('there is no duplicate Docs workflow; every web leg runs the docs gates', async () => {
  const names = await readdir(join(projectRoot, WORKFLOW_DIR));
  assert.equal(names.includes('docs.yml'), false, 'the path-filtered duplicate is gone');
  const checks = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  for (const script of ['npm run docs:check', 'npm run workflows:check', 'npm run privacy:check', 'npm run build:brand -- --check']) {
    assert.ok(checks.includes(script), `checks.yml runs ${script}`);
  }
});
