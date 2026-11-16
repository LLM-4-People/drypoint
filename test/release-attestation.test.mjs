/**
 * The attestation must name the resolved tag commit, not the workflow_run
 * default-branch HEAD. The sign job sets GITHUB_SHA from
 * `needs.resolve.outputs.sha` and then proves the downloaded predicate carries
 * that commit and this APK's digest. This test executes the exact `run:` body
 * against a generated `.intoto.jsonl`, so the assertion is not a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const RELEASE = join(projectRoot, '.github', 'workflows', 'release.yml');
const SHA = 'b'.repeat(40);
const MAIN_HEAD = 'c'.repeat(40);

async function provenanceStep() {
  const { workflow } = parseWorkflow(await readFile(RELEASE, 'utf8'));
  const sign = workflow.jobs.sign;
  const step = sign.steps.find((entry) => entry.name === 'Prove the provenance binds the tag commit');
  assert.ok(step?.run, 'the provenance assertion exists');
  const attest = sign.steps.find((entry) => String(entry.uses ?? '').startsWith('actions/attest-build-provenance@'));
  assert.ok(attest, 'the attest action exists');
  return { script: step.run, attest };
}

const { script: SCRIPT, attest: ATTEST } = await provenanceStep();

function statement({ gitCommit, apkSha }) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'drypoint-1.0.3.apk', digest: { sha256: apkSha } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/LLM-4-People/drypoint@refs/heads/main',
            digest: { gitCommit },
          },
        ],
      },
    },
  };
}

async function harness(t, { gitCommit = SHA, apkSha = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-attest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  const apk = join(root, 'dist', 'drypoint-1.0.3.apk');
  await writeFile(apk, 'signed apk bytes');
  const digest = createHash('sha256').update(await readFile(apk)).digest('hex');
  const bundle = join(root, 'dist', 'drypoint-1.0.3.apk.intoto.jsonl');
  const payload = Buffer.from(JSON.stringify(statement({ gitCommit, apkSha: apkSha ?? digest }))).toString('base64');
  await writeFile(
    bundle,
    `${JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload, signatures: [] },
    })}\n`
  );
  return { root, digest };
}

function run(paths, sha = SHA) {
  return execFileSync('bash', ['-c', SCRIPT], {
    cwd: paths.root,
    env: { ...process.env, VERSION: '1.0.3', SHA: sha },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('the sign job binds the attestation to needs.resolve.outputs.sha', () => {
  assert.equal(ATTEST.env.GITHUB_SHA, '${{ needs.resolve.outputs.sha }}');
});

test('the generated predicate passes when it names the tag commit and this APK', async (t) => {
  const paths = await harness(t);
  const output = run(paths);
  assert.match(output, new RegExp(`provenance binds ${paths.digest} to ${SHA}`));
});

test('a predicate carrying the default-branch HEAD fails the release', async (t) => {
  const paths = await harness(t, { gitCommit: MAIN_HEAD });
  assert.throws(
    () => run(paths),
    (error) => error.status !== 0,
    'the workflow_run default-branch HEAD must not satisfy the binding'
  );
});

test('a predicate for a different APK digest fails the release', async (t) => {
  const paths = await harness(t, { apkSha: 'd'.repeat(64) });
  assert.throws(
    () => run(paths),
    (error) => error.status !== 0,
    'the subject digest is part of the binding'
  );
});

test('a missing bundle fails closed', async (t) => {
  const paths = await harness(t);
  await rm(join(paths.root, 'dist', 'drypoint-1.0.3.apk.intoto.jsonl'));
  assert.throws(() => run(paths), (error) => error.status !== 0);
});
