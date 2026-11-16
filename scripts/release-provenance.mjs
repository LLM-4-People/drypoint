#!/usr/bin/env node
/**
 * The SLSA v1 predicate that binds a release attestation to the resolved tag
 * commit.
 *
 * `actions/attest-build-provenance` builds its default predicate from
 * `github.context`, where a `workflow_run` sees the default-branch HEAD, not
 * the tag commit. A step-level `GITHUB_SHA` does not change that: GitHub
 * overwrites `GITHUB_*` after the step env is applied. The workflow therefore
 * passes this predicate with `predicate-type`/`predicate-path`, so the commit
 * in the attestation is the `needs.resolve.outputs.sha` the build proved.
 *
 * The file is data: the sign job never executes repository code and only
 * forwards the JSON produced by the build commit.
 *
 * Usage:
 *   node scripts/release-provenance.mjs \
 *     --sha <40-character commit> --tag vMAJOR.MINOR.PATCH \
 *     --version MAJOR.MINOR.PATCH --out dist/provenance.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stable build type for this repository's release pipeline. */
export const BUILD_TYPE = 'https://github.com/LLM-4-People/drypoint/release/v1';
/** The public repository URL recorded in `resolvedDependencies`. */
export const REPOSITORY_URL = 'https://github.com/LLM-4-People/drypoint';
/** The fixed builder id when the script runs outside GitHub Actions. */
export const FALLBACK_BUILDER = `${REPOSITORY_URL}/actions`;

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

function fail(message) {
  throw new Error(message);
}

/**
 * The workflow run URL, from the Actions environment. Outside Actions the
 * fallback names the repository's actions page; it never invents a commit.
 */
export function builderId(env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = env.GITHUB_REPOSITORY || 'LLM-4-People/drypoint';
  const runId = env.GITHUB_RUN_ID;
  return runId ? `${server}/${repository}/actions/runs/${runId}` : FALLBACK_BUILDER;
}

/**
 * The predicate passed to the attest action. It has exactly one resolved
 * dependency: this repository at the release tag, with the resolved commit.
 *
 * @param {{sha: string, tag: string, version: string, builder?: string}} options
 * @returns {object}
 */
export function provenancePredicate({ sha, tag, version, builder = builderId() }) {
  const commit = String(sha ?? '');
  const releaseTag = String(tag ?? '');
  const releaseVersion = String(version ?? '');
  if (!SHA.test(commit)) fail(`--sha must be a 40-character lowercase commit SHA: ${JSON.stringify(commit)}`);
  if (!TAG.test(releaseTag)) fail(`--tag must be vMAJOR.MINOR.PATCH: ${JSON.stringify(releaseTag)}`);
  if (!VERSION.test(releaseVersion)) fail(`--version must be MAJOR.MINOR.PATCH: ${JSON.stringify(releaseVersion)}`);
  if (releaseTag !== `v${releaseVersion}`) {
    fail(`tag ${releaseTag} does not match version ${releaseVersion}`);
  }
  const run = String(builder ?? '').trim();
  if (!run) fail('the builder id must not be empty');

  return {
    buildDefinition: {
      buildType: BUILD_TYPE,
      externalParameters: { tag: releaseTag, version: releaseVersion },
      internalParameters: {},
      resolvedDependencies: [
        {
          uri: `git+${REPOSITORY_URL}@refs/tags/${releaseTag}`,
          digest: { gitCommit: commit },
        },
      ],
    },
    runDetails: {
      builder: { id: run },
      metadata: { invocationId: run },
    },
  };
}

/** Parse the CLI flags; every value is required. */
export function parseArguments(argv) {
  const options = { sha: '', tag: '', version: '', out: '' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--sha') options.sha = argv[++index] ?? '';
    else if (argument === '--tag') options.tag = argv[++index] ?? '';
    else if (argument === '--version') options.version = argv[++index] ?? '';
    else if (argument === '--out') options.out = argv[++index] ?? '';
    else throw new Error(`unknown option ${argument}`);
  }
  for (const name of ['sha', 'tag', 'version', 'out']) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  return options;
}

async function main(argv) {
  try {
    const options = parseArguments(argv);
    const predicate = provenancePredicate(options);
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(predicate, null, 2)}\n`);
    console.log(`provenance: wrote ${out} for ${options.tag} at ${options.sha}`);
    return 0;
  } catch (error) {
    console.error(`provenance: ${error.message}`);
    console.error(
      'usage: node scripts/release-provenance.mjs --sha <40hex> --tag vX.Y.Z --version X.Y.Z --out dist/provenance.json'
    );
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
