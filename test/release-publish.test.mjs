/**
 * The publish step is workflow-owned, so the test executes the `run:` body the
 * workflow actually runs instead of re-typing the shell.
 *
 * The job has no checkout, so `gh` cannot discover a repository from the
 * working directory. The shim reproduces that: without `GH_REPO` (or `-R`) and
 * outside a git repository it fails exactly as `gh` does. A temporary `gh`
 * records its argv, which proves the tag, flags, assets, the existing-release
 * byte comparison and the notes refresh on a re-run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflow } from '../scripts/check-workflows.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const RELEASE = join(projectRoot, '.github', 'workflows', 'release.yml');
const SIGN_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const APK_BYTES = 'the signed apk bytes';

/** One DSSE bundle line for an APK digest and a git commit. */
function attestationLine(apkSha, gitCommit) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'drypoint-1.0.3.apk', digest: { sha256: apkSha } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/LLM-4-People/drypoint@refs/tags/v1.0.3',
            digest: { gitCommit },
          },
        ],
      },
    },
  };
  return JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      signatures: [],
    },
  });
}

/** The exact publish shell the workflow runs. */
async function publishScript() {
  const { workflow } = parseWorkflow(await readFile(RELEASE, 'utf8'));
  const step = workflow.jobs.publish.steps.find((entry) => entry.name === 'Publish the release, or prove it already is');
  assert.ok(step?.run, 'the publish step exists');
  return step.run;
}

const SCRIPT = await publishScript();

async function harness(t, { existing = false, existingAsset = 'same', existingBundle = 'same' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const dist = join(root, 'dist');
  const runnerTemp = join(root, 'tmp');
  const existingBundlePath = join(root, 'existing-bundle.jsonl');
  await Promise.all([mkdir(bin), mkdir(dist), mkdir(runnerTemp)]);
  const log = join(root, 'gh.log');
  await writeFile(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GH_LOG"',
      'if [ -z "${GH_REPO:-}" ]; then',
      '  case " $* " in',
      '    *" -R "*|*" --repo "*) ;;',
      '    *) if ! git rev-parse --git-dir >/dev/null 2>&1; then',
      '         echo "failed to run git: fatal: not a git repository (or any of the parent directories): .git" >&2',
      '         exit 1',
      '       fi ;;',
      '  esac',
      'fi',
      'if [ "$1" = release ] && [ "$2" = view ]; then',
      `  exit ${existing ? 0 : 1}`,
      'fi',
      'if [ "$1" = release ] && [ "$2" = download ]; then',
      '  dir=""',
      '  shift 2',
      '  while [ $# -gt 0 ]; do',
      '    case "$1" in',
      '      --dir) shift; dir="$1" ;;',
      '    esac',
      '    shift',
      '  done',
      '  mkdir -p "$dir"',
      '  cp "$PWD"/dist/* "$dir"/',
      '  cp "$GH_EXISTING_BUNDLE" "$dir/drypoint-1.0.3.apk.intoto.jsonl"',
      ...(existing && existingAsset === 'changed' ? ['  printf "different" > "$dir/drypoint-1.0.3.apk"'] : []),
      '  exit 0',
      'fi',
      'if [ "$1" = release ] && [ "$2" = create ] && [ -z "$3" ]; then',
      '  echo "missing tag" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await chmod(join(bin, 'gh'), 0o755);
  for (const name of ['drypoint-1.0.3.apk', 'drypoint-1.0.3.apk.sha256', 'drypoint-1.0.3.apk.intoto.jsonl', 'notes.md']) {
    await writeFile(join(dist, name), name === 'notes.md' ? 'the generated notes\n' : name.endsWith('.apk') ? APK_BYTES : 'x');
  }
  // The published bundle is not reproducible: two lines, other bytes. The
  // step must verify it semantically, never compare it byte-for-byte.
  const digest = createHash('sha256').update(APK_BYTES).digest('hex');
  const lines = [
    attestationLine(digest, OTHER_SHA),
    attestationLine(digest, existingBundle === 'same' ? SIGN_SHA : OTHER_SHA),
  ];
  await writeFile(existingBundlePath, `${lines.join('\n')}\n`);
  return { root, bin, dist, runnerTemp, log, existingBundlePath };
}

function env({ bin, runnerTemp, log, existingBundlePath }, { tag = 'v1.0.3', ghRepo = 'LLM-4-People/drypoint' } = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: log,
    GH_EXISTING_BUNDLE: existingBundlePath,
    RUNNER_TEMP: runnerTemp,
    GITHUB_REF_NAME: 'decoy-branch',
    GITHUB_REPOSITORY: 'LLM-4-People/drypoint',
    ...(ghRepo ? { GH_REPO: ghRepo } : { GH_REPO: '' }),
    TAG: tag,
    VERSION: '1.0.3',
    SHA: SIGN_SHA,
  };
}

function run(paths, environment) {
  return execFileSync('bash', ['-c', SCRIPT], { cwd: paths.root, env: environment, encoding: 'utf8', stdio: 'pipe' });
}

test('without GH_REPO and outside a git repository the publish step fails like gh', async (t) => {
  const paths = await harness(t);
  assert.throws(
    () => run(paths, env(paths, { ghRepo: '' })),
    (error) => error.status !== 0 && /not a git repository/.test(`${error.stdout}${error.stderr}`),
    'the shim reproduces gh\'s repository resolution'
  );
});

test('the real publish step creates the release with the resolved tag and assets', async (t) => {
  const paths = await harness(t);
  run(paths, env(paths));
  const calls = (await readFile(paths.log, 'utf8')).trim().split('\n');
  const create = calls.find((call) => call.startsWith('release create'));
  assert.ok(create, 'the create command ran');
  const args = create.split(' ').filter(Boolean);
  assert.equal(args[2], 'v1.0.3', 'the tag argument is $TAG');
  assert.ok(args.includes('--verify-tag'), '--verify-tag is on the real command');
  for (const asset of ['drypoint-1.0.3.apk', 'drypoint-1.0.3.apk.sha256', 'drypoint-1.0.3.apk.intoto.jsonl']) {
    assert.ok(args.some((argument) => argument.endsWith(asset)), `${asset} is attached`);
  }
  assert.ok(args.includes('--latest'));
  assert.ok(args.includes('--notes-file'));
  assert.equal(args.includes('decoy-branch'), false, 'GITHUB_REF_NAME never reaches the command');
});

test('an existing release with a non-reproducible bundle refreshes the notes and exits 0', async (t) => {
  const paths = await harness(t, { existing: true });
  assert.notDeepEqual(
    await readFile(paths.existingBundlePath),
    await readFile(join(paths.dist, 'drypoint-1.0.3.apk.intoto.jsonl')),
    'the published bundle is not byte-identical to this run'
  );
  run(paths, env(paths));
  const calls = (await readFile(paths.log, 'utf8')).trim().split('\n');
  assert.ok(calls.some((call) => call.startsWith('release view v1.0.3')), 'the existing release is detected');
  assert.ok(calls.some((call) => call.startsWith('release download v1.0.3')), 'the assets are downloaded');
  const verify = calls.find((call) => call.startsWith('attestation verify'));
  assert.ok(verify, 'the existing bundle signature and signer are verified');
  assert.ok(verify.includes('--bundle'), 'the downloaded bundle is verified');
  assert.ok(verify.includes('--signer-workflow'), 'the signer workflow is pinned');
  assert.ok(verify.includes('https://slsa.dev/provenance/v1'), 'the predicate type is pinned');
  const edit = calls.find((call) => call.startsWith('release edit v1.0.3'));
  assert.ok(edit, 'a re-run refreshes the body instead of keeping a stale one');
  assert.ok(edit.includes('--notes-file'), 'the refreshed body is the generated notes');
  assert.equal(calls.some((call) => call.startsWith('release create')), false, 'nothing is re-created');
});

test('an existing bundle that binds another commit fails before any edit', async (t) => {
  const paths = await harness(t, { existing: true, existingBundle: 'other' });
  assert.throws(
    () => run(paths, env(paths)),
    (error) => error.status !== 0 && /does not bind the published APK to the resolved commit/.test(`${error.stdout}${error.stderr}`)
  );
  const calls = await readFile(paths.log, 'utf8');
  assert.equal(calls.includes('release edit'), false, 'an unbound attestation never updates the body');
});

test('a changed notes file still reaches gh release edit', async (t) => {
  const paths = await harness(t, { existing: true });
  await writeFile(join(paths.dist, 'notes.md'), 'the changelog changed\n');
  run(paths, env(paths));
  const calls = (await readFile(paths.log, 'utf8')).trim().split('\n');
  assert.ok(calls.some((call) => call.startsWith('release edit v1.0.3') && call.includes('--notes-file')));
});

test('an existing release with a different asset fails before any edit', async (t) => {
  const paths = await harness(t, { existing: true, existingAsset: 'changed' });
  assert.throws(
    () => run(paths, env(paths)),
    (error) => error.status !== 0 && /differs from this build/.test(`${error.stdout}${error.stderr}`)
  );
  const calls = await readFile(paths.log, 'utf8');
  assert.equal(calls.includes('release edit'), false, 'a mismatched asset never updates the body');
});

test('an empty tag makes the real publish step fail', async (t) => {
  const paths = await harness(t);
  assert.throws(
    () => run(paths, env(paths, { tag: '' })),
    (error) => error.status !== 0 && /missing tag/.test(`${error.stdout}${error.stderr}`),
    'the command cannot publish without a tag'
  );
});
