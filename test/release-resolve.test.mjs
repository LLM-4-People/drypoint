/**
 * Execute the release resolve block extracted from release.yml against a
 * throwaway repository. The test does not re-type the shell: it runs the exact
 * `run:` body and evaluates the exact job-level `if`, so the cases and the
 * workflow cannot drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';

async function resolveJob() {
  const text = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8');
  const { workflow } = parseWorkflow(text);
  const job = workflow.jobs.resolve;
  const step = job.steps.find((entry) => entry.id === 'tag');
  assert.ok(step, 'the resolve step exists');
  return { script: step.run, condition: job.if ?? '' };
}

const RESOLVE = await resolveJob();

/**
 * Evaluate the workflow job-level `if` for one event context. The expression
 * is the simple boolean subset GitHub documents; the test refuses anything it
 * does not understand instead of silently treating it as true.
 */
function evaluateJobIf(expression, context) {
  let js = String(expression).trim();
  assert.doesNotMatch(js, /\$\{\{/, 'the job condition is a bare expression');
  js = js.replace(/github\.event_name/g, JSON.stringify(context.event_name));
  js = js.replace(/github\.event\.workflow_run\.event/g, JSON.stringify(context.workflow_run?.event ?? null));
  js = js.replace(/github\.event\.workflow_run\.conclusion/g, JSON.stringify(context.workflow_run?.conclusion ?? null));
  assert.doesNotMatch(js, /github\./, 'the evaluator understands every reference in the condition');
  return Function(`"use strict"; return (${js});`)();
}

function jobContext({ event = 'workflow_run', runEvent = 'push', conclusion = 'success' } = {}) {
  return {
    event_name: event,
    workflow_run: event === 'workflow_dispatch' ? undefined : { event: runEvent, conclusion },
  };
}

async function repository(t, { version = '1.0.3' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'drypoint', version }, null, 2)}\n`);
  git('add', 'package.json');
  git('commit', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', head);

  const bin = join(root, 'bin');
  await mkdir(bin);
  const log = join(root, 'gh.log');
  const shim = join(bin, 'gh');
  // `gh release view` fails: these fixtures start without an existing release.
  await writeFile(shim, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\nexit 1\n', { mode: 0o755 });
  await chmod(shim, 0o755);

  const feature = () => {
    git('checkout', '-b', 'feature');
    git('commit', '--allow-empty', '-m', 'off main');
    const sha = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    return sha;
  };

  return { root, git, head, bin, log, feature };
}

async function resolve(t, repo, { event = 'workflow_run', runEvent = 'push', conclusion = 'success', tag = '', sha = '', publish = false } = {}) {
  if (!evaluateJobIf(RESOLVE.condition, jobContext({ event, runEvent, conclusion }))) {
    return { status: 0, skipped: true, values: {}, output: 'skipped by the resolve job condition' };
  }
  const output = join(repo.root, `out-${Math.random().toString(16).slice(2)}.txt`);
  await writeFile(output, '');
  const env = {
    ...process.env,
    PATH: `${repo.bin}:${process.env.PATH}`,
    GH_LOG: repo.log,
    GITHUB_OUTPUT: output,
    EVENT: event,
    INPUT_TAG: String(tag),
    RUN_SHA: String(sha),
    INPUT_PUBLISH: publish ? 'true' : 'false',
  };
  let result;
  try {
    const stdout = execFileSync('bash', ['-c', RESOLVE.script], { cwd: repo.root, encoding: 'utf8', stdio: 'pipe', env });
    result = { status: 0, output: `${stdout}`, combined: stdout };
  } catch (error) {
    result = { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}`, combined: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
  const values = {};
  for (const line of (await readFile(output, 'utf8')).split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return { ...result, skipped: false, values };
}

test('the resolve job only runs for a successful push Checks run or a dispatch', () => {
  const condition = RESOLVE.condition.replace(/\s+/g, ' ');
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(condition, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(condition, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(condition, /workflow_run\.event == 'push' && github\.event\.workflow_run\.conclusion == 'success'/);

  const runs = (context) => evaluateJobIf(RESOLVE.condition, jobContext(context));
  assert.equal(runs({}), true, 'a successful push Checks run');
  assert.equal(runs({ conclusion: 'failure' }), false, 'a failed tag run must not publish');
  assert.equal(runs({ conclusion: 'cancelled' }), false, 'a cancelled tag run must not publish');
  assert.equal(runs({ runEvent: 'pull_request' }), false, 'a pull request run must not publish');
  assert.equal(runs({ runEvent: 'schedule' }), false, 'only a push is accepted');
  assert.equal(runs({ event: 'workflow_dispatch' }), true, 'a manual dry run is explicit');
});

test('a failed, cancelled or non-push workflow_run never reaches the tag lookup', async (t) => {
  const repo = await repository(t);
  repo.git('tag', 'v1.0.3');
  for (const context of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { runEvent: 'pull_request' }]) {
    const skipped = await resolve(t, repo, { sha: repo.head, ...context });
    assert.equal(skipped.skipped, true, `${context.runEvent ?? 'push'}/${context.conclusion ?? 'success'} is skipped`);
    assert.equal(skipped.values.publish, undefined, 'no publish=true output exists');
  }
});

test('the extracted resolve block verifies the tag at HEAD and the no-tag path', async (t) => {
  const tagged = await repository(t);
  tagged.git('tag', 'v1.0.3');
  const published = await resolve(t, tagged, { sha: tagged.head });
  assert.equal(published.status, 0, published.combined);
  assert.deepEqual(published.values, {
    publish: 'true',
    tag: 'v1.0.3',
    sha: tagged.head,
    version: '1.0.3',
    ref: 'v1.0.3',
    existing: 'false',
  });

  const plain = await repository(t);
  const skipped = await resolve(t, plain, { sha: plain.head });
  assert.equal(skipped.status, 0, skipped.combined);
  assert.deepEqual(skipped.values, { publish: 'false' });
  assert.match(skipped.output, new RegExp(`no release tag at ${plain.head}`));
});

test('the resolve block refuses a version mismatch, an off-main tag and ambiguity', async (t) => {
  const mismatch = await repository(t, { version: '1.0.3' });
  mismatch.git('tag', 'v1.0.4');
  const wrongVersion = await resolve(t, mismatch, { sha: mismatch.head });
  assert.equal(wrongVersion.status, 1);
  assert.match(wrongVersion.output, /tag v1\.0\.4 does not match package\.json version 1\.0\.3/);

  const offMain = await repository(t);
  const feature = offMain.feature();
  offMain.git('tag', 'v1.0.3', feature);
  const notAncestor = await resolve(t, offMain, { sha: feature });
  assert.equal(notAncestor.status, 1);
  assert.match(notAncestor.output, new RegExp(`${feature} is not an ancestor of origin/main`));

  const ambiguous = await repository(t);
  ambiguous.git('tag', 'v1.0.3');
  ambiguous.git('tag', 'v1.0.4');
  const twoTags = await resolve(t, ambiguous, { sha: ambiguous.head });
  assert.equal(twoTags.status, 1);
  assert.match(twoTags.output, /multiple release tags/);
});

test('workflow_dispatch requires a real tag or a full SHA and never publishes a SHA', async (t) => {
  const repo = await repository(t);
  repo.git('tag', 'v1.0.3');

  const missing = await resolve(t, repo, { event: 'workflow_dispatch', tag: 'v9.9.9' });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /tag v9\.9\.9 does not exist/);

  const short = await resolve(t, repo, { event: 'workflow_dispatch', tag: repo.head.slice(0, 8) });
  assert.equal(short.status, 1);
  assert.match(short.output, /full 40-character SHA/);

  const shaDryRun = await resolve(t, repo, { event: 'workflow_dispatch', tag: repo.head });
  assert.equal(shaDryRun.status, 0, shaDryRun.combined);
  assert.deepEqual(shaDryRun.values, {
    publish: 'false',
    tag: 'v1.0.3',
    sha: repo.head,
    version: '1.0.3',
    ref: repo.head,
    existing: 'false',
  });

  const shaPublish = await resolve(t, repo, { event: 'workflow_dispatch', tag: repo.head, publish: true });
  assert.equal(shaPublish.status, 1);
  assert.match(shaPublish.output, /publish=true requires a release tag/);

  const realTag = await resolve(t, repo, { event: 'workflow_dispatch', tag: 'v1.0.3' });
  assert.equal(realTag.status, 0, realTag.combined);
  assert.equal(realTag.values.tag, 'v1.0.3');
  assert.equal(realTag.values.ref, 'v1.0.3');
  assert.equal(realTag.values.publish, 'false');

  const publishedTag = await resolve(t, repo, { event: 'workflow_dispatch', tag: 'v1.0.3', publish: true });
  assert.equal(publishedTag.status, 0, publishedTag.combined);
  assert.equal(publishedTag.values.publish, 'true');
  assert.equal(publishedTag.values.ref, 'v1.0.3');
});

test('a SHA dry run refuses a commit off main and a non-semver package version', async (t) => {
  const repo = await repository(t);
  const feature = repo.feature();
  const offMain = await resolve(t, repo, { event: 'workflow_dispatch', tag: feature });
  assert.equal(offMain.status, 1);
  assert.match(offMain.output, /is not an ancestor of origin\/main/);

  const loose = await repository(t, { version: '1.0' });
  const noSemver = await resolve(t, loose, { event: 'workflow_dispatch', tag: loose.head });
  assert.equal(noSemver.status, 1);
  assert.match(noSemver.output, /has no strict semantic version/);
});
