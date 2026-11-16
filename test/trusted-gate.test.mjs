/**
 * The org rule runs checks.yml from main, but its steps execute the checked-out
 * tree by default. These tests prove the two authoritative checks read main's
 * scripts and treat the candidate tree as data:
 *
 *   - `required` checks out main before running check-required.mjs;
 *   - `policy` checks out main for the parser and npm ci, and the candidate
 *     tree only as data for the policy and privacy scans.
 *
 * A pull request can therefore not weaken the parser or the aggregate it is
 * judged by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '../scripts/check-workflows.mjs';
import { REQUIRED_ROOTS } from '../scripts/check-privacy.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const CHECKS = join(projectRoot, '.github', 'workflows', 'checks.yml');
const POLICY = join(projectRoot, 'scripts', 'check-workflows.mjs');
const PRIVACY = join(projectRoot, 'scripts', 'check-privacy.mjs');
const AGGREGATE = join(projectRoot, 'scripts', 'check-required.mjs');

async function candidate(t) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(script, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('the workflow checks main before it runs the aggregate', async () => {
  const parsed = parseWorkflow(await readFile(CHECKS, 'utf8')).workflow;
  const required = parsed.jobs.required;
  const checkout = required.steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.ok(checkout, 'the required job checks out a tree explicitly');
  assert.equal(checkout.with.ref, 'main', "the aggregate is main's copy");
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 1);
  const aggregate = required.steps.find((step) => String(step.run ?? '').includes('check-required.mjs'));
  assert.equal(aggregate.run.trim(), 'node scripts/check-required.mjs');
  assert.equal(aggregate.env.NEEDS, '${{ toJSON(needs) }}');

  const policy = parsed.jobs.policy;
  const trusted = policy.steps[0];
  assert.equal(trusted.with.ref, 'main', 'the policy parser is main\'s copy');
  assert.equal(trusted.with['persist-credentials'], false);
  assert.ok(
    policy.steps.some((step) => step.run === 'npm ci'),
    'dependencies are installed from main'
  );
  const gate = policy.steps.find((step) => String(step.run ?? '').includes('check-workflows.mjs --workflows'));
  assert.ok(gate, 'the trusted parser runs');
  assert.ok(gate.run.includes('node scripts/check-workflows.mjs'), 'the script path is the trusted checkout');
  assert.ok(gate.run.includes('node scripts/check-privacy.mjs'), 'the privacy script is the trusted checkout');
  assert.ok(gate.run.includes('--workflows "$PR_TREE/.github/workflows"'), 'the candidate workflows are data');
  assert.ok(gate.run.includes('--root "$PR_TREE"'), 'the candidate tree is data');
  assert.doesNotMatch(gate.run, /node .*PR_TREE.*scripts\//, 'no script is executed from the candidate tree');
});

test('a no-op copy of check-required.mjs in the candidate tree cannot make the trusted aggregate pass', async (t) => {
  const root = await candidate(t);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'check-required.mjs'), 'process.exit(0);\n');

  const needs = JSON.stringify({ web: { result: 'failure' }, browser: { result: 'success' }, android: { result: 'success' }, policy: { result: 'success' } });
  // The workflow runs the script from the main checkout. The candidate copy is
  // never on that path; this is the property, not an implementation detail.
  const result = run(AGGREGATE, [], { NEEDS: needs });
  assert.equal(result.status, 1, 'the trusted aggregate still fails a failed leg');
  assert.match(result.stderr, /web=failure/);

  const passed = run(AGGREGATE, [], {
    NEEDS: JSON.stringify({ web: { result: 'success' }, browser: { result: 'success' }, android: { result: 'success' }, policy: { result: 'success' } }),
  });
  assert.equal(passed.status, 0);
});

test('a candidate workflow with an anchor grant or an unpinned action fails the trusted parser', async (t) => {
  const root = await candidate(t);
  const workflows = join(root, '.github', 'workflows');
  await mkdir(workflows, { recursive: true });
  const checks = await readFile(CHECKS, 'utf8');

  const anchor = checks.replace('permissions:\n  contents: read', 'env:\n  GRANT: &grant write-all\npermissions: *grant');
  await writeFile(join(workflows, 'checks.yml'), anchor);
  let result = run(POLICY, ['--workflows', workflows]);
  assert.notEqual(result.status, 0, 'the anchor grant is judged by main\'s parser');
  assert.match(result.stderr, /permissions must be a scope map/);

  const unpinned = checks.replace('uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'uses: actions/checkout@v4');
  await writeFile(join(workflows, 'checks.yml'), unpinned);
  result = run(POLICY, ['--workflows', workflows]);
  assert.notEqual(result.status, 0, 'the unpinned action is judged by main\'s parser');
  assert.match(result.stderr, /not pinned to a 40-character commit/);

  const real = run(POLICY, ['--workflows', join(projectRoot, '.github', 'workflows')]);
  assert.equal(real.status, 0, real.stderr);
});

test('a candidate PII string fails the trusted privacy scan', async (t) => {
  const root = await candidate(t);
  for (const path of REQUIRED_ROOTS) {
    const target = join(root, path);
    if (path.includes('.')) await writeFile(target, 'ok\n');
    else {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'example.md'), 'ok\n');
    }
  }
  // Assemble the banned value in this file so the test itself stays clean.
  const home = ['', 'home', 'someone', 'work'].join('/');
  await writeFile(join(root, 'src', 'leak.js'), `const path = '${home}/label.json';\n`);
  await writeFile(join(root, '.gitignore'), '');

  const result = run(PRIVACY, ['--root', root]);
  assert.equal(result.status, 1, 'the trusted scanner reads the candidate as data');
  assert.match(result.stderr, /src\/leak\.js:1: home-directory/);

  const real = run(PRIVACY, []);
  assert.equal(real.status, 0, real.stderr);
});
