#!/usr/bin/env node
/**
 * Workflow policy gate on parsed YAML.
 *
 * A GitHub Actions workflow is executable supply chain, and a tag reference is
 * mutable. A line-oriented scan is not a policy: YAML can spell the same grant
 * as a quoted scalar, a folded block scalar, a tag or an alias, and the parser
 * — not a regular expression — is the authority on what GitHub will run.
 * This gate therefore parses each file once and asserts on the resolved values:
 *
 *   - every `uses:` names a commit only (40 hex characters, no tag or branch),
 *   - only the actions on the pinned allowlist may be used at all,
 *   - every workflow declares a top-level `permissions:` scope map, never
 *     `write-all`/`read-all` in any spelling or through an anchor,
 *   - every workflow declares a top-level `concurrency:`,
 *   - every job declares `timeout-minutes:`,
 *   - a checkout never persists credentials,
 *   - `pull_request_target` is banned outright,
 *   - the aggregate job reads every leg from `toJSON(needs)` and runs even when
 *     a leg failed,
 *   - the merge gate commands are exact and cannot be masked with `|| true`,
 *     `; true`, `echo`, `continue-on-error` or a step condition,
 *   - the release publishes with `--verify-tag` on the real `gh release create`
 *     command, never through a quoted command name, eval or a decoy echo.
 *
 * GitHub is the syntax authority; `actionlint.yml` runs the pinned actionlint
 * on the same files. This script checks the policy YAML cannot express.
 *
 * Usage:
 *   node scripts/check-workflows.mjs                         # exit 1 on any finding
 *   node scripts/check-workflows.mjs --list                  # also print the scanned count
 *   node scripts/check-workflows.mjs --workflows <dir>       # scan a tree as data
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { THROWAWAY as CI_THROWAWAY } from './ci-keystore.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WORKFLOW_DIR = '.github/workflows';
export const RELEASE_FILE = 'release.yml';
/** The one aggregate job whose whole purpose is to read its legs' results. */
export const AGGREGATE_JOB = 'required';
/** The one environment that holds the release signing key. */
export const RELEASE_ENVIRONMENT = 'release';

/** The pinned action commits the trusted wiring names explicitly below. */
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';

/** How the trusted gate selects the candidate tree as data, never as code. */
const PR_TREE_EXPRESSION =
  "${{ github.event_name == 'pull_request' && format('{0}/pr', github.workspace) || github.event_name == 'push' && format('{0}/data', github.workspace) || github.workspace }}";

/**
 * The exact trusted wiring of `policy` and `required`.
 *
 * These two jobs decide every merge, and a candidate checkout is present in
 * the policy job. The gate therefore does not approve "equivalent" wiring: the
 * exact steps, refs, paths, conditions, environment and shell bodies are the
 * contract. A missing/extra/reordered step, a `working-directory`, a job
 * `defaults` or `container`, a fork `repository:` or a moved checkout path is
 * a finding.
 */
export const TRUSTED_STEPS = Object.freeze({
  policy: Object.freeze([
    Object.freeze({ name: 'Checkout main (trusted policy scripts)', uses: CHECKOUT, with: Object.freeze({ ref: 'main', 'persist-credentials': false }) }),
    Object.freeze({ name: 'Use the pinned Node', uses: SETUP_NODE, with: Object.freeze({ 'node-version-file': '.node-version' }) }),
    Object.freeze({ name: 'Install the one dev-only dependency', run: 'npm ci' }),
    Object.freeze({
      name: 'Checkout the pull request as data',
      if: "github.event_name == 'pull_request'",
      uses: CHECKOUT,
      with: Object.freeze({
        repository: '${{ github.event.pull_request.head.repo.full_name }}',
        ref: '${{ github.event.pull_request.head.sha }}',
        path: 'pr',
        'persist-credentials': false,
        'fetch-depth': 1,
      }),
    }),
    Object.freeze({
      name: 'Checkout the pushed commit as data',
      if: "github.event_name == 'push'",
      uses: CHECKOUT,
      with: Object.freeze({ ref: '${{ github.sha }}', path: 'data', 'persist-credentials': false, 'fetch-depth': 1 }),
    }),
    Object.freeze({
      name: 'Workflow policy and privacy on the candidate tree',
      env: Object.freeze({ PR_TREE: PR_TREE_EXPRESSION }),
      run: Object.freeze([
        'set -euo pipefail',
        'node scripts/check-workflows.mjs --workflows "$PR_TREE/.github/workflows"',
        'node scripts/check-privacy.mjs --root "$PR_TREE" --tracked',
        'bash scripts/actionlint.sh "$PR_TREE/.github/workflows"',
      ]).join('\n'),
    }),
  ]),
  required: Object.freeze([
    Object.freeze({
      name: 'Checkout main (trusted aggregate)',
      uses: CHECKOUT,
      with: Object.freeze({ ref: 'main', 'persist-credentials': false, 'fetch-depth': 1 }),
    }),
    Object.freeze({
      name: 'Every leg must have succeeded',
      env: Object.freeze({ NEEDS: '${{ toJSON(needs) }}' }),
      run: 'node scripts/check-required.mjs',
    }),
  ]),
});

/**
 * The exact step names of the four release jobs. The names are the step list's
 * identity: an added, removed or reordered step changes the list even when the
 * body would be harmless. The security-critical bodies are checked separately.
 */
export const RELEASE_STEP_NAMES = Object.freeze({
  resolve: Object.freeze(['Checkout main with tags', 'Resolve the tag']),
  build: Object.freeze([
    'Checkout main',
    'Materialize the resolved commit',
    'Prove the worktree is the resolved commit',
    'Use the pinned Node',
    'Install the one dev-only dependency',
    'Locate a Chromium binary',
    'Gate the resolved tree',
    'Release notes from the changelog',
    'Generate the notes',
    'Use JDK 21',
    'Install the pinned SDK packages',
    'Create a throwaway signing key',
    'Build the unsigned APK with a throwaway key',
    'Package the unsigned artifact',
    'The built APK matches its manifest and policy',
    'Write the provenance predicate',
    'The build changed no tracked file',
    'The build left no untracked file',
    'Upload the unsigned artifact',
  ]),
  sign: Object.freeze([
    'Download the unsigned artifact',
    'Use the gate-proved JDK',
    'Install the pinned build tools',
    'Sign, verify and describe the APK',
    'Attest the signed APK',
    'Download the provenance bundle',
    'Prove the provenance binds the tag commit',
    'Upload the release files',
  ]),
  publish: Object.freeze(['Download the release files', 'Publish the release, or prove it already is']),
});

/**
 * The exact permission map of every workflow and job. A write scope a job does
 * not need is a grant the token holder can exercise; equality, not a minimum
 * check, is the only way a widening edit shows up here.
 */
export const EXPECTED_PERMISSIONS = Object.freeze({
  'actionlint.yml': Object.freeze({ top: Object.freeze({ contents: 'read' }), jobs: Object.freeze({}) }),
  'checks.yml': Object.freeze({ top: Object.freeze({ contents: 'read' }), jobs: Object.freeze({}) }),
  'codeql.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({ analyze: Object.freeze({ 'security-events': 'write', contents: 'read', actions: 'read' }) }),
  }),
  'dependency-review.yml': Object.freeze({
    top: Object.freeze({ contents: 'read', 'pull-requests': 'write' }),
    jobs: Object.freeze({}),
  }),
  'pages.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      build: null,
      deploy: Object.freeze({ pages: 'write', 'id-token': 'write' }),
      smoke: Object.freeze({ contents: 'read' }),
    }),
  }),
  'release.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      resolve: null,
      build: Object.freeze({ contents: 'read' }),
      sign: Object.freeze({ contents: 'read', 'id-token': 'write', attestations: 'write' }),
      publish: Object.freeze({ contents: 'write' }),
    }),
  }),
  'scorecard.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      analysis: Object.freeze({ 'security-events': 'write', 'id-token': 'write', contents: 'read', actions: 'read' }),
    }),
  }),
  'stale.yml': Object.freeze({ top: Object.freeze({ issues: 'write', 'pull-requests': 'write' }), jobs: Object.freeze({}) }),
});

/** The exact concurrency group of every workflow; `release` is reserved. */
export const EXPECTED_CONCURRENCY = Object.freeze({
  'actionlint.yml': Object.freeze({ group: 'actionlint-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'checks.yml': Object.freeze({ group: 'checks-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'codeql.yml': Object.freeze({ group: 'codeql-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'dependency-review.yml': Object.freeze({ group: 'dependency-review-${{ github.ref }}', 'cancel-in-progress': true }),
  'pages.yml': Object.freeze({ group: 'pages', 'cancel-in-progress': false }),
  'release.yml': Object.freeze({ group: 'release', 'cancel-in-progress': false }),
  'scorecard.yml': Object.freeze({ group: 'scorecard', 'cancel-in-progress': false }),
  'stale.yml': Object.freeze({ group: 'stale', 'cancel-in-progress': false }),
});

/**
 * Environment variables that change what a trusted script executes or where it
 * writes. They are rejected at workflow, job and step level.
 */
export const INJECTION_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_OUTPUT',
]);

/**
 * Every workflow this repository owns. A candidate can add `.github/workflows/
 * release.yaml`, which GitHub runs exactly like `release.yml` but which the
 * release-specific policy would never inspect. The set is therefore closed:
 * an added, renamed or removed workflow is a finding.
 */
export const OWNED_WORKFLOWS = Object.freeze([
  'actionlint.yml',
  'checks.yml',
  'codeql.yml',
  'dependency-review.yml',
  'pages.yml',
  'release.yml',
  'scorecard.yml',
  'stale.yml',
]);

/**
 * The only actions this repository may use, each pinned to one commit. A
 * version comment may travel beside the SHA; the SHA is what runs.
 */
export const PINNED_ACTIONS = Object.freeze({
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

/**
 * The exact commands each merge-gate job must run.
 *
 * This table is the owner of what the gate *is*. The workflow is checked
 * against it, never the other way around: a command can be weakened in the
 * workflow without weakening the expectation. Each command is matched as one
 * logical shell command (backslash continuations joined, `&&`/`||`/`;`/`|`
 * split, comments removed), so `npm run test:unit || true` is two commands and
 * the extra `true` is caught.
 */
export const GATE_COMMANDS = Object.freeze({
  'checks.yml': Object.freeze({
    web: Object.freeze([
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
    ]),
    browser: Object.freeze(['npm ci', 'node scripts/find-chrome.mjs', 'npm run test:browser']),
    android: Object.freeze([
      'npm ci',
      'bash scripts/android-sdk.sh',
      'node scripts/ci-keystore.mjs',
      'npm run build:android',
      'node scripts/check-apk.mjs --aapt2 "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2" --apksigner "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner"',
      'git diff --exit-code',
      'test -z "$(git status --porcelain)"',
    ]),
    policy: Object.freeze([
      'npm ci',
      'node scripts/check-workflows.mjs --workflows "$PR_TREE/.github/workflows"',
      'node scripts/check-privacy.mjs --root "$PR_TREE" --tracked',
      'bash scripts/actionlint.sh "$PR_TREE/.github/workflows"',
    ]),
    required: Object.freeze(['node scripts/check-required.mjs']),
  }),
});

/** Commands that are a no-op or that discard the command they follow. */
const MASK_COMMANDS = new Set(['true', ':', 'exit 0']);
const SHA = /^[0-9a-f]{40}$/;
/** A masked gate step is rejected in both workflows that hold authority. */
const MASKABLE_WORKFLOWS = new Set(['checks.yml', RELEASE_FILE]);
/** A secret reference in any job that is not the one signing job. */
const SECRET_REFERENCE = /secrets\.[A-Za-z_][A-Za-z0-9_]*/;
/** The exact opt-in a gated step may put before its registered command. */
const GATE_PREAMBLE = 'set -euo pipefail';
/** The one owner of the CI throwaway key; both unprivileged jobs call it. */
export const CI_KEYSTORE_COMMAND = 'node scripts/ci-keystore.mjs';

/** YAML may hold a scalar or a list in either form; callers want a list. */
function list(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse one workflow with the merge and duplicate-key semantics GitHub uses.
 *
 * `stringKeys` keeps a quoted job key and a bare one the same map key;
 * `uniqueKeys` turns a duplicate key into an error instead of silently keeping
 * one; `merge` resolves `<<` merge keys.
 *
 * @param {string} text
 * @returns {{workflow: object|null, findings: string[]}}
 */
export function parseWorkflow(text) {
  const doc = parseDocument(String(text), { stringKeys: true, uniqueKeys: true, merge: true });
  const findings = doc.errors.map((error) => {
    const line = error.linePos?.[0]?.line;
    return `${error.code ?? 'YAML'}${line ? ` at line ${line}` : ''}: ${error.message.split('\n')[0]}`;
  });
  if (findings.length) return { workflow: null, findings };
  try {
    return { workflow: doc.toJS({ maxAliasCount: 200 }), findings: [] };
  } catch (error) {
    return { workflow: null, findings: [`YAML: ${error.message.split('\n')[0]}`] };
  }
}

/**
 * Remove one shell trailing comment, keeping `#` inside a quoted argument.
 *
 * @param {string} line
 * @returns {string}
 */
function stripShellCommentLine(line) {
  const text = String(line);
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function stripShellComments(text) {
  return String(text)
    .split(/\r?\n/)
    .map(stripShellCommentLine)
    .join('\n');
}

/**
 * Split a shell script into simple commands, respecting quotes and escapes.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitShellCommands(command) {
  const parts = [];
  let current = '';
  let quote = null;
  const text = String(command);
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index];
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      current += character + text[++index];
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (character === ';' || character === '|' || character === '\n' || pair === '&&' || pair === '||') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (pair === '&&' || pair === '||') index++;
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Collapse runs of whitespace outside quotes. Shell treats them as one
 * separator, and a backslash continuation adds indentation that must not make
 * an otherwise identical gate command look different.
 *
 * @param {string} command
 * @returns {string}
 */
export function normalizeCommand(command) {
  const text = String(command);
  let output = '';
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      output += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      if (pendingSpace && output) output += ' ';
      pendingSpace = false;
      quote = character;
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) output += ' ';
    pendingSpace = false;
    output += character;
  }
  return output;
}

/**
 * The logical commands in one `run:` string.
 *
 * A backslash continuation joins the next physical line before the command is
 * examined; otherwise `--verify-tag` on a line of its own looked present even
 * when it was not part of the `gh release create` invocation.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function logicalCommands(text) {
  const cleaned = stripShellComments(text).replace(/\\\r?\n[ \t]*/g, ' ');
  return splitShellCommands(cleaned).map((command) => normalizeCommand(command.trim())).filter(Boolean);
}

/**
 * Tokenize one shell command. Quotes delimit tokens; they are not part of the
 * token, and whitespace inside them does not split.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  const text = String(command);
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index];
        continue;
      }
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      current += text[++index];
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Every `run:` string in a workflow, in job order. */
function runStrings(text) {
  const { workflow, findings } = parseWorkflow(text);
  if (!workflow || findings.length || !isMap(workflow.jobs)) return [];
  const runs = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of list(job?.steps)) {
      if (typeof step?.run === 'string') runs.push(step.run);
    }
  }
  return runs;
}

/** The logical commands in every `run:` string of a workflow. */
export function shellCommands(text) {
  return runStrings(text).flatMap((run) => logicalCommands(run));
}

/** Whether one logical command is the real publish command. */
function isPublishCommand(command) {
  const tokens = shellTokens(command);
  return tokens[0] === 'gh' && tokens[1] === 'release' && tokens[2] === 'create';
}

/**
 * The real `gh release create` commands in a workflow, extracted from the
 * parsed `run:` strings. The test suite executes what this returns, so a test
 * cannot drift from the workflow.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function publishCommands(text) {
  return shellCommands(text).filter(isPublishCommand);
}

/**
 * Every `permissions:` declaration must be a scope map. A scalar is the
 * `write-all`/`read-all` shorthand; YAML folds, tags and anchors all resolve to
 * that same string before this runs.
 */
function permissionFindings(permissions, file, where) {
  const findings = [];
  if (permissions == null) return findings;
  if (!isMap(permissions)) {
    findings.push(`${file}: ${where}permissions must be a scope map, not ${JSON.stringify(permissions)}`);
    return findings;
  }
  for (const [scope, level] of Object.entries(permissions)) {
    if (level === 'write-all' || level === 'read-all') {
      findings.push(`${file}: ${where}permission ${scope} is ${level}; declare each scope`);
    } else if (!['read', 'write', 'none'].includes(level)) {
      findings.push(`${file}: ${where}permission ${scope} has invalid value ${JSON.stringify(level)}`);
    }
  }
  return findings;
}

/** Whether a parsed trigger document mentions a key anywhere. */
function mentionsKey(value, wanted) {
  if (!isMap(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === wanted) return true;
    if (mentionsKey(child, wanted)) return true;
  }
  return false;
}

/** The job names in a parsed workflow, including quoted and spaced keys. */
export function jobNames(workflow) {
  return isMap(workflow?.jobs) ? Object.keys(workflow.jobs) : [];
}

/** Whether two plain maps have the same keys and values (order-insensitive). */
function sameMap(actual, expected) {
  if (actual == null && expected == null) return true;
  if (!isMap(actual) || !isMap(expected)) return false;
  const entries = (map) => Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries(actual)) === JSON.stringify(entries(expected));
}

/** The exact permission table, applied to every owned workflow. */
function permissionTableFindings(workflow, file) {
  const table = EXPECTED_PERMISSIONS[file];
  if (!table) return [];
  const findings = [];
  if (!sameMap(workflow?.permissions, table.top)) {
    findings.push(`${file}: top-level permissions must be exactly ${JSON.stringify(table.top)}`);
  }
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const expected = Object.hasOwn(table.jobs, name) ? table.jobs[name] : null;
    if (!sameMap(job.permissions, expected)) {
      findings.push(
        `${file}: job "${name}" permissions must be exactly ${JSON.stringify(expected)}, not ${JSON.stringify(job.permissions ?? null)}`
      );
    }
  }
  return findings;
}

/** The exact concurrency group, so a checks run cannot join `release`. */
function concurrencyFindings(workflow, file) {
  const expected = EXPECTED_CONCURRENCY[file];
  if (!expected) return [];
  const findings = [];
  if (workflow?.concurrency?.group !== expected.group) {
    findings.push(
      `${file}: concurrency group must be exactly "${expected.group}", not ${JSON.stringify(workflow?.concurrency?.group ?? null)}`
    );
  }
  if (workflow?.concurrency?.['cancel-in-progress'] !== expected['cancel-in-progress']) {
    findings.push(`${file}: concurrency cancel-in-progress must be ${expected['cancel-in-progress']}`);
  }
  return findings;
}

/** Reject every env key that changes what the trusted scripts execute. */
function injectionFindings(workflow, file) {
  const findings = [];
  const check = (env, where) => {
    if (!isMap(env)) return;
    for (const key of Object.keys(env)) {
      if (INJECTION_KEYS.includes(key)) findings.push(`${file}: ${where} must not set ${key}`);
    }
  };
  check(workflow?.env, 'the workflow env');
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    check(job?.env, `job "${name}" env`);
    for (const step of stepsOf(job)) check(step.env, `job "${name}" step env`);
  }
  return findings;
}

/** Normalize one GitHub expression for an exact comparison. */
export function conditionText(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

/** Require one exact job or step condition. */
export function exactConditionFindings(value, expected, file, where) {
  if (conditionText(value) === expected) return [];
  return [`${file}: ${where} must be exactly "${expected}", not ${JSON.stringify(conditionText(value) || null)}`];
}

/**
 * The exact trusted step list. Any added, missing, reordered or reshaped step
 * is a finding, as is a job-level `defaults`, `container`, `env` or
 * `continue-on-error`.
 */
function trustedStepFindings(job, file, jobName) {
  const expected = TRUSTED_STEPS[jobName];
  if (!expected) return [];
  if (!isMap(job)) return [`${file}: job "${jobName}" is missing`];
  const findings = [];
  for (const key of ['defaults', 'container']) {
    if (job[key] != null) findings.push(`${file}: job "${jobName}" must not declare ${key}`);
  }
  if (job.env != null) findings.push(`${file}: job "${jobName}" must not declare job-level env`);
  if (job['continue-on-error'] != null && job['continue-on-error'] !== false) {
    findings.push(`${file}: job "${jobName}" must not set continue-on-error`);
  }
  const steps = stepsOf(job);
  if (steps.length !== list(job.steps).length) {
    findings.push(`${file}: job "${jobName}" steps must all be mappings`);
  }
  if (steps.length !== expected.length) {
    findings.push(`${file}: job "${jobName}" must have exactly ${expected.length} steps; found ${steps.length}`);
  }
  const allowed = ['name', 'if', 'uses', 'with', 'run', 'env'];
  for (let index = 0; index < Math.min(steps.length, expected.length); index++) {
    const step = steps[index];
    const wanted = expected[index];
    const where = `job "${jobName}" step ${index + 1} ("${wanted.name}")`;
    for (const key of Object.keys(step)) {
      if (!allowed.includes(key)) findings.push(`${file}: ${where} must not set ${key}`);
    }
    if (step.name !== wanted.name) {
      findings.push(`${file}: ${where} has the name ${JSON.stringify(step.name ?? null)}`);
      continue;
    }
    if (conditionText(step.if) !== conditionText(wanted.if)) {
      findings.push(`${file}: ${where} condition must be ${JSON.stringify(conditionText(wanted.if) || null)}`);
    }
    if (step.uses !== wanted.uses) {
      findings.push(`${file}: ${where} must use ${JSON.stringify(wanted.uses ?? null)}`);
    }
    if (!sameMap(step.with, wanted.with)) {
      findings.push(`${file}: ${where} with: must be exactly ${JSON.stringify(wanted.with ?? null)}`);
    }
    if (!sameMap(step.env, wanted.env)) {
      findings.push(`${file}: ${where} env: must be exactly ${JSON.stringify(wanted.env ?? null)}`);
    }
    if ((step.run == null ? '' : String(step.run).trim()) !== (wanted.run ?? '')) {
      findings.push(`${file}: ${where} run: must be the trusted body, not ${JSON.stringify(step.run ?? null)}`);
    }
  }
  return findings;
}

/** The exact step names of one release job. */
function releaseStepNamesFindings(job, file, jobName) {
  const expected = RELEASE_STEP_NAMES[jobName];
  if (!expected) return [];
  if (!isMap(job)) return [`${file}: job "${jobName}" is missing`];
  const findings = [];
  for (const key of ['defaults', 'container']) {
    if (job[key] != null) findings.push(`${file}: job "${jobName}" must not declare ${key}`);
  }
  const names = stepsOf(job).map((step) => step.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    findings.push(
      `${file}: job "${jobName}" must have exactly these steps: ${expected.join(' | ')}; found ${names.join(' | ') || 'none'}`
    );
  }
  return findings;
}

/** Reject the write token outside the release workflow. */
function tokenFindings(workflow, file) {
  if (file === RELEASE_FILE) return [];
  if (JSON.stringify([workflow?.env ?? {}, workflow?.jobs ?? {}]).includes('github.token')) {
    return [`${file}: must not read github.token; the trusted jobs need no write capability`];
  }
  return [];
}

/** Reject `source`/`.` in a shell body; both execute repository data. */
function sourceFindings(job, file, jobName) {
  const findings = [];
  for (const command of stepsOf(job).flatMap(stepCommands)) {
    const tokens = shellTokens(command);
    if (tokens[0] === 'source' || tokens[0] === '.') {
      findings.push(`${file}: job "${jobName}" must not source a file: "${command}"`);
    }
  }
  return findings;
}

/** Sign and publish steps are plain: no condition, shell, directory or mask. */
function plainStepFindings(job, file, jobName) {
  const findings = [];
  for (const step of stepsOf(job)) {
    for (const key of ['if', 'shell', 'working-directory']) {
      if (step[key] != null) findings.push(`${file}: job "${jobName}" step must not set ${key}`);
    }
    if (step['continue-on-error'] != null && step['continue-on-error'] !== false) {
      findings.push(`${file}: job "${jobName}" step must not set continue-on-error`);
    }
  }
  return findings;
}

/** The `needs:` list of one parsed job. */
export function needsOf(job) {
  return list(job?.needs).map(String);
}

function stepsOf(job) {
  return list(job?.steps).filter(isMap);
}

/**
 * Gate and release logic must be a shell `run:` step, not an opaque script
 * passed to an action. `with.script` is still inspected: moving the aggregate,
 * the policy or the publish command there is refused.
 */
function withScriptFindings(workflow, file) {
  if (!MASKABLE_WORKFLOWS.has(file)) return [];
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of stepsOf(job)) {
      const script = step.with?.script;
      if (typeof script !== 'string') continue;
      if (/(?:toJSON\(needs\)|check-required|check-workflows|gh release create|--verify-tag|npm run test:|npm run verify)/.test(script)) {
        findings.push(`${file}: job "${name}" must keep gate or release logic in a run: step, not with.script`);
      }
    }
  }
  return findings;
}

/** One step's logical shell commands (only `run:` is shell). */
function stepCommands(step) {
  return typeof step.run === 'string' ? logicalCommands(step.run) : [];
}

/** Every logical shell command in a parsed workflow. */
function workflowCommands(workflow) {
  return Object.values(workflow?.jobs ?? {}).flatMap((job) => stepsOf(job).flatMap(stepCommands));
}

function usesFindings(step, file, jobName) {
  const findings = [];
  if (step.uses == null) return findings;
  if (typeof step.uses !== 'string') {
    findings.push(`${file}: job "${jobName}" has a uses: that is not a string`);
    return findings;
  }
  const value = step.uses;
  if (value.startsWith('./')) {
    // A local action is candidate or repository code, not a pinned action. In
    // the trusted `policy` job the candidate checkout is present, so a local
    // action there would run candidate code before the gate.
    findings.push(`${file}: job "${jobName}" must not run a local action: ${value}`);
    return findings;
  }
  const at = value.lastIndexOf('@');
  const action = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? '' : value.slice(at + 1);
  if (!SHA.test(ref)) {
    findings.push(`${file}: ${value} is not pinned to a 40-character commit`);
    return findings;
  }
  const repo = action.split('/').slice(0, 2).join('/');
  if (!Object.hasOwn(PINNED_ACTIONS, repo)) {
    findings.push(`${file}: ${repo} is not on the pinned action allowlist`);
  } else if (PINNED_ACTIONS[repo] !== ref) {
    findings.push(`${file}: ${repo} must be pinned to ${PINNED_ACTIONS[repo]}`);
  }
  if (repo === 'actions/checkout' && step.with?.['persist-credentials'] !== false) {
    findings.push(`${file}: checkout must set persist-credentials: false`);
  }
  return findings;
}

/** Reject a step that can silently skip or mask the command it owns. */
function maskedStepFindings(step, file, jobName, commands) {
  const findings = [];
  if (step['continue-on-error'] != null && step['continue-on-error'] !== false) {
    findings.push(`${file}: job "${jobName}" step must not set continue-on-error`);
  }
  if (step.if != null) {
    findings.push(`${file}: job "${jobName}" gate step must not carry an if:`);
  }
  if (step.shell != null) {
    findings.push(`${file}: job "${jobName}" gate step must use the default shell, not ${JSON.stringify(step.shell)}`);
  }
  for (const command of commands) {
    const tokens = shellTokens(command);
    if (MASK_COMMANDS.has(command) || MASK_COMMANDS.has(tokens[0])) {
      findings.push(`${file}: job "${jobName}" gate step contains the masking command "${command}"`);
    } else if (tokens[0] === 'echo' || tokens[0] === 'printf') {
      findings.push(`${file}: job "${jobName}" gate step echoes instead of running the gate: "${command}"`);
    }
  }
  return findings;
}

/**
 * The aggregate job: it must list every other job, run even when a leg failed,
 * and derive its result from the whole `needs` map by calling the tested
 * script. A second hand-written map or a `needs.<name>` read is drift.
 */
function aggregateFindings(workflow, jobs, file) {
  const findings = [];
  const aggregate = jobs[AGGREGATE_JOB];
  if (!aggregate) return findings;

  const needed = needsOf(aggregate);
  for (const name of Object.keys(jobs)) {
    if (name !== AGGREGATE_JOB && !needed.includes(name)) {
      findings.push(`${file}: job "${name}" is not listed in ${AGGREGATE_JOB}.needs`);
    }
  }
  for (const name of needed) {
    if (name === AGGREGATE_JOB) continue;
    const leg = jobs[name];
    if (!leg) {
      findings.push(`${file}: ${AGGREGATE_JOB}.needs names the missing job "${name}"`);
      continue;
    }
    if (leg.if != null) {
      const condition = typeof leg.if === 'string' ? leg.if.replace(/\$\{\{|\}\}/g, '').trim() : '';
      if (!/^(?:always\(\)|!cancelled\(\))$/.test(condition)) {
        findings.push(`${file}: job "${name}" must run on every trigger (including a tag push); the aggregate needs it`);
      }
    }
  }

  const condition = typeof aggregate.if === 'string' ? aggregate.if.replace(/\$\{\{|\}\}/g, '').trim() : '';
  if (!/^(?:always\(\)|!cancelled\(\))$/.test(condition)) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must run with if: always() (or !cancelled())`);
  }

  const steps = stepsOf(aggregate);
  const scriptStep = steps.find((step) => stepCommands(step).includes('node scripts/check-required.mjs'));
  if (!scriptStep) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must call node scripts/check-required.mjs`);
  } else if (String(scriptStep.env?.NEEDS ?? '').trim() !== '${{ toJSON(needs) }}') {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must pass NEEDS: \${{ toJSON(needs) }} to the script`);
  }
  findings.push(...gateStepFindings(aggregate, file, AGGREGATE_JOB, ['node scripts/check-required.mjs']));

  const logic = steps
    .flatMap((step) => [...stepCommands(step), JSON.stringify(step.env ?? {}), typeof step.with?.script === 'string' ? step.with.script : ''])
    .join('\n');
  if (/needs\.[A-Za-z0-9_-]+/.test(logic)) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" hardcodes a leg name; use toJSON(needs)`);
  }
  return findings;
}

/**
 * Check one parsed workflow against the general policy.
 *
 * @param {object} workflow
 * @param {string} file
 * @returns {string[]}
 */
export function parsedWorkflowFindings(workflow, file) {
  const findings = [];
  const jobs = workflow?.jobs;
  if (!isMap(jobs) || !Object.keys(jobs).length) return [`${file}: no jobs`];

  findings.push(...permissionFindings(workflow.permissions, file, ''));
  findings.push(...permissionTableFindings(workflow, file));
  findings.push(...concurrencyFindings(workflow, file));
  findings.push(...injectionFindings(workflow, file));
  findings.push(...tokenFindings(workflow, file));
  if (workflow.permissions == null) findings.push(`${file}: no top-level permissions block`);
  if (workflow.concurrency == null) findings.push(`${file}: no top-level concurrency block`);
  if (mentionsKey(workflow.on, 'pull_request_target')) findings.push(`${file}: pull_request_target is banned`);
  if (workflow.defaults != null) findings.push(`${file}: must not declare workflow-level defaults (a run shell override could no-op a gate)`);

  for (const [name, job] of Object.entries(jobs)) {
    if (!isMap(job)) {
      findings.push(`${file}: job "${name}" is not a mapping`);
      continue;
    }
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0) {
      findings.push(`${file}: job "${name}" has no timeout-minutes`);
    }
    // A trusted job must run on the image the gate proved. A self-hosted,
    // Windows or macOS label changes the shell and the tools silently.
    if (job['runs-on'] !== 'ubuntu-24.04') {
      findings.push(`${file}: job "${name}" must run on ubuntu-24.04, not ${JSON.stringify(job['runs-on'] ?? null)}`);
    }
    if (job['continue-on-error'] != null && job['continue-on-error'] !== false) {
      findings.push(`${file}: job "${name}" must not set continue-on-error`);
    }
    findings.push(...permissionFindings(job.permissions, file, `job "${name}" `));
    if (job.uses != null) {
      findings.push(`${file}: job "${name}" must not call a reusable workflow (secrets: inherit is the bypass this policy removes)`);
    }
    for (const step of stepsOf(job)) {
      findings.push(...usesFindings(step, file, name));
      if (MASKABLE_WORKFLOWS.has(file) && step['continue-on-error'] != null && step['continue-on-error'] !== false) {
        findings.push(`${file}: job "${name}" step must not set continue-on-error`);
      }
    }
  }

  findings.push(...aggregateFindings(workflow, jobs, file));
  findings.push(...withScriptFindings(workflow, file));
  findings.push(...environmentFindings(workflow, file));
  findings.push(...secretFindings(workflow, file));
  if (file === 'checks.yml') {
    const on = isMap(workflow.on) ? workflow.on : {};
    if (!list(on.push?.tags).includes('v*')) findings.push(`${file}: Checks must run on v* tag pushes so the release can resolve them`);
    if (!list(on.push?.branches).includes('main')) findings.push(`${file}: Checks must run on main`);
    if (!Object.hasOwn(on, 'pull_request')) findings.push(`${file}: Checks must run on pull requests`);
    for (const [name, job] of Object.entries(jobs)) {
      if (name === AGGREGATE_JOB) continue;
      if (job.if != null) findings.push(`${file}: job "${name}" must not carry an if: (the gate runs on every trigger)`);
    }
    findings.push(...trustedStepFindings(jobs.policy, file, 'policy'));
    findings.push(...trustedStepFindings(jobs.required, file, 'required'));
  }
  if (file === 'checks.yml' && !jobs[AGGREGATE_JOB]) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" is missing`);
  }
  findings.push(...gateFindings(workflow, jobs, file));
  return findings;
}

/**
 * The one gate-step grammar.
 *
 * A gate step's shell body must be exactly a contiguous slice of the job's
 * registered command list, optionally prefixed by `set -euo pipefail`. The
 * slices, in step order, must concatenate to the whole list exactly.
 *
 * Matching text is not enough: `if false; then <gate>; fi`, a here-doc, a
 * pipeline (`| cat`), `|| /bin/true`, a subshell, a brace group or a `sh -c`
 * wrapper all put commands around the registered one that a substring scan
 * never sees. Those forms add tokens, so the body is no longer the registered
 * sequence and the step is rejected. `set -euo pipefail` is the only accepted
 * preamble; every other command in a gate step is a finding.
 */
function gateStepFindings(job, file, jobName, required) {
  const findings = [];
  const observed = [];
  for (const step of stepsOf(job)) {
    const commands = stepCommands(step);
    if (!commands.length) continue;
    const body = commands[0] === GATE_PREAMBLE ? commands.slice(1) : commands;
    if (!body.some((command) => required.includes(command))) continue;

    findings.push(...maskedStepFindings(step, file, jobName, commands));
    const start = body.length ? required.indexOf(body[0]) : -1;
    const expected = start < 0 ? [] : required.slice(start, start + body.length);
    const exact =
      start >= 0 && body.length === expected.length && body.every((command, index) => command === expected[index]);
    if (!exact) {
      findings.push(
        `${file}: job "${jobName}" gate step must run only the registered commands; found ${JSON.stringify(body)}`
      );
      continue;
    }
    observed.push(...body);
  }
  if (observed.join('\n') !== required.join('\n')) {
    findings.push(
      `${file}: job "${jobName}" must run exactly these commands in order: ${required.join(' | ')}; found ${
        observed.join(' | ') || 'none'
      }`
    );
  }
  return findings;
}

/**
 * The throwaway key must be created before the build that consumes it. A
 * reordered workflow leaves `CI=true` with no key, which is a hard failure —
 * or worse, tempts someone to relax that rule instead.
 */
function keystoreOrderFindings(job, file, jobName) {
  const steps = stepsOf(job);
  const keystore = steps.findIndex((step) => stepCommands(step).includes(CI_KEYSTORE_COMMAND));
  const build = steps.findIndex((step) => stepCommands(step).includes('npm run build:android'));
  if (build < 0) return [];
  if (keystore < 0) {
    return [`${file}: job "${jobName}" must create the throwaway key with ${CI_KEYSTORE_COMMAND} before ${'npm run build:android'}`];
  }
  if (keystore > build) {
    return [`${file}: job "${jobName}" must create the throwaway key before npm run build:android`];
  }
  return [];
}

/**
 * Every required merge-gate command must appear in the registered order, in
 * gate steps that cannot be skipped or masked.
 */
function gateFindings(workflow, jobs, file) {
  const gates = GATE_COMMANDS[file];
  if (!gates) return [];
  const findings = [];
  for (const [jobName, required] of Object.entries(gates)) {
    const job = jobs[jobName];
    if (!job) {
      findings.push(`${file}: job "${jobName}" is missing`);
      continue;
    }
    findings.push(...gateStepFindings(job, file, jobName, required));
    findings.push(...keystoreOrderFindings(job, file, jobName));
  }
  return findings;
}

/**
 * The environment names one `environment:` value declares. GitHub accepts a
 * bare name or a map with `name`; both are the same environment grant.
 */
function environmentNames(value) {
  if (typeof value === 'string') return [value];
  if (isMap(value) && typeof value.name === 'string') return [value.name];
  return [];
}

/**
 * Only `release.yml`'s `sign` job may enter the release environment. Every
 * other job in every workflow is rejected, including a map-form spelling of the
 * same name. The environment holds the signing key; `environment:` is a grant
 * exactly like a permission.
 */
function environmentFindings(workflow, file) {
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!isMap(job) || job.environment == null) continue;
    if (!environmentNames(job.environment).includes(RELEASE_ENVIRONMENT)) continue;
    const owner = file === RELEASE_FILE && name === 'sign' && job.environment === RELEASE_ENVIRONMENT;
    if (!owner) {
      findings.push(
        `${file}: job "${name}" must not use the ${RELEASE_ENVIRONMENT} environment; only ${RELEASE_FILE}'s "sign" job may`
      );
    }
  }
  return findings;
}

/**
 * A secret reference anywhere in a job (env, step env, `with:`, or the `run:`
 * body itself) is a grant of the secret to that job. Only the signing job may
 * read one.
 */
function secretFindings(workflow, file) {
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!isMap(job)) continue;
    if (file === RELEASE_FILE && name === 'sign') continue;
    const text = JSON.stringify([
      job.env ?? {},
      stepsOf(job).map((step) => ({ env: step.env ?? {}, with: step.with ?? {}, run: step.run ?? '' })),
    ]);
    if (SECRET_REFERENCE.test(text)) {
      findings.push(`${file}: job "${name}" must not read secrets; only ${RELEASE_FILE}'s "sign" job may`);
    }
  }
  return findings;
}

/**
 * The throwaway identity has one owner: `scripts/ci-keystore.mjs`. A workflow
 * that spells the password, DN or a raw `keytool -genkeypair` is a second
 * owner, so it is rejected even if it would work.
 */
function keystoreOwnershipFindings(text, file) {
  const findings = [];
  const source = String(text);
  if (source.includes(CI_THROWAWAY.password)) {
    findings.push(`${file}: must not hardcode the CI throwaway password; call ${CI_KEYSTORE_COMMAND}`);
  }
  if (source.includes(CI_THROWAWAY.dn)) {
    findings.push(`${file}: must not hardcode the CI throwaway DN; call ${CI_KEYSTORE_COMMAND}`);
  }
  if (/keytool\s+-genkeypair/.test(source)) {
    findings.push(`${file}: must not run a raw keytool -genkeypair; call ${CI_KEYSTORE_COMMAND}`);
  }
  return findings;
}

/**
 * Check one workflow's text against the general policy.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {string[]}
 */
export function checkWorkflow(text, { file = 'workflow' } = {}) {
  const { workflow, findings } = parseWorkflow(text);
  if (!workflow) return findings.map((finding) => `${file}: ${finding}`);
  return [
    ...findings.map((finding) => `${file}: ${finding}`),
    ...keystoreOwnershipFindings(text, file),
    ...parsedWorkflowFindings(workflow, file),
  ];
}

function jobEnvText(job) {
  return JSON.stringify([job?.env ?? {}, ...stepsOf(job).map((step) => step.env ?? {})]);
}

function jobLogic(workflow, name) {
  const job = workflow?.jobs?.[name];
  return stepsOf(job).flatMap(stepCommands).join('\n');
}

function triggerObject(workflow) {
  return isMap(workflow?.on) ? workflow.on : {};
}

function resolveBlock(workflow) {
  const job = workflow?.jobs?.resolve;
  return isMap(job) ? job : null;
}

function triggerFindings(workflow, file) {
  const findings = [];
  const on = triggerObject(workflow);
  if (!isMap(workflow?.on)) {
    return [`${file}: release must declare workflow_run and workflow_dispatch triggers`];
  }
  const run = on.workflow_run;
  if (!isMap(run)) {
    findings.push(`${file}: release must trigger on the Checks workflow`);
  } else {
    if (!list(run.workflows).includes('Checks')) findings.push(`${file}: the release workflow_run must name Checks`);
    if (!list(run.types).includes('completed')) findings.push(`${file}: the release workflow_run must wait for completion`);
  }
  if (!isMap(on.workflow_dispatch)) {
    findings.push(`${file}: release must allow workflow_dispatch`);
  } else {
    const inputs = on.workflow_dispatch.inputs;
    if (!isMap(inputs) || !isMap(inputs.tag) || inputs.tag.required !== true || inputs.tag.type !== 'string') {
      findings.push(`${file}: workflow_dispatch must require a tag or commit string input`);
    }
    if (!isMap(inputs?.publish) || inputs.publish.type !== 'boolean' || inputs.publish.default !== false) {
      findings.push(`${file}: workflow_dispatch publish must default to false`);
    }
  }
  for (const forbidden of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_call']) {
    if (on[forbidden] != null) findings.push(`${file}: release must not trigger on ${forbidden}`);
  }
  return findings;
}

function resolveFindings(workflow, file) {
  const findings = [];
  const job = resolveBlock(workflow);
  if (!job) return [`${file}: job "resolve" is missing`];
  if (job.environment != null) findings.push(`${file}: job "resolve" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "resolve" must not read secrets`);

  const expectedCondition =
    "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success')";
  findings.push(...exactConditionFindings(job.if, expectedCondition, file, 'job "resolve" if:'));
  findings.push(...releaseStepNamesFindings(job, file, 'resolve'));

  const outputs = isMap(job.outputs) ? job.outputs : {};
  const expectedOutputs = ['publish', 'ref', 'sha', 'tag', 'version'];
  for (const name of expectedOutputs) {
    if (!(name in outputs)) findings.push(`${file}: job "resolve" must output ${name}`);
  }
  for (const name of Object.keys(outputs)) {
    if (!expectedOutputs.includes(name)) findings.push(`${file}: job "resolve" must not expose the unused output ${name}`);
  }

  const steps = stepsOf(job);
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) {
    findings.push(`${file}: job "resolve" must check out main`);
  } else {
    if (
      !sameMap(checkout.with, { ref: 'main', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false })
    ) {
      findings.push(`${file}: job "resolve" checkout must name exactly main with full history, tags and no credentials`);
    }
  }

  const logic = steps.flatMap(stepCommands).join('\n');
  const required = [
    [/git tag --points-at/, 'derive the tag from the resolved commit with git tag --points-at'],
    [/out "ref=/, 'report the ref the build checks out'],
    [/git merge-base --is-ancestor/, 'verify the commit is an ancestor of origin/main'],
    [/package\.json/, 'verify the tag version against package.json'],
    [/workflow_dispatch/, 'handle the manual dry run'],
    [/publish=true requires a release tag/, 'refuse publish=true with a commit SHA'],
    [/40-character SHA/, 'refuse a short commit SHA'],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(logic)) findings.push(`${file}: job "resolve" must ${message}`);
  }
  if (!logic.includes('v[0-9]+\\.[0-9]+\\.[0-9]+')) {
    findings.push(`${file}: job "resolve" must keep only strict vMAJOR.MINOR.PATCH tags`);
  }
  if (logic.includes('head_branch')) {
    findings.push(`${file}: job "resolve" must derive the tag from the commit, not head_branch`);
  }
  if (jobEnvText(job).includes('head_branch') || String(job.if ?? '').includes('head_branch')) {
    findings.push(`${file}: job "resolve" must not depend on head_branch`);
  }
  return findings;
}

function jobGateFindings(workflow, file, name, required) {
  const job = workflow?.jobs?.[name];
  if (!isMap(job)) return [`${file}: job "${name}" is missing`];
  const findings = gateStepFindings(job, file, name, required);
  const steps = stepsOf(job);
  for (const command of required) {
    const holder = steps.find((step) => stepCommands(step).includes(command));
    if (holder && holder['working-directory'] !== '${{ env.RELEASE_TREE }}') {
      findings.push(`${file}: job "${name}" must run "${command}" in the resolved worktree`);
    }
  }
  return findings;
}

function buildFindings(workflow, file) {
  const required = [
    'test "$(git rev-parse HEAD)" = "$SHA"',
    'npm ci',
    'node scripts/find-chrome.mjs',
    'npm run verify:all',
    'node scripts/release-notes.mjs --tag "$TAG" --commit "$SHA" --out dist/notes.md',
    CI_KEYSTORE_COMMAND,
    'npm run build:android',
    'node scripts/check-apk.mjs --apk "dist/drypoint-${VERSION}-unsigned.apk" --aapt2 "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2" --apksigner "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner"',
    'node scripts/release-provenance.mjs --sha "$SHA" --tag "$TAG" --version "$VERSION" --out dist/provenance.json',
    'git diff --exit-code',
    'test -z "$(git status --porcelain)"',
  ];
  const findings = jobGateFindings(workflow, file, 'build', required);
  const job = workflow?.jobs?.build;
  if (!isMap(job)) return findings;
  if (job.environment != null) findings.push(`${file}: job "build" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "build" must not read secrets`);
  findings.push(
    ...exactConditionFindings(
      job.if,
      "needs.resolve.outputs.publish == 'true' || github.event_name == 'workflow_dispatch'",
      file,
      'job "build" if:'
    )
  );
  findings.push(...releaseStepNamesFindings(job, file, 'build'));
  for (const [name, value] of [
    ['TAG', '${{ needs.resolve.outputs.tag }}'],
    ['SHA', '${{ needs.resolve.outputs.sha }}'],
    ['VERSION', '${{ needs.resolve.outputs.version }}'],
  ]) {
    if (job.env?.[name] !== value) findings.push(`${file}: job "build" env ${name} must be exactly ${value}`);
  }
  const steps = stepsOf(job);
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) findings.push(`${file}: job "build" must check out main`);
  else {
    // The build's own checkout is a fixed ref. A dynamic ref here is the
    // CodeQL cache-poisoning pattern: the resolved tag/SHA must be data for
    // git, materialized below, not an actions/checkout target.
    if (!sameMap(checkout.with, { ref: 'main', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false })) {
      findings.push(`${file}: job "build" checkout must name exactly main with full history, tags and no credentials`);
    }
  }
  const materialize = steps.find((step) => step.env?.REF === '${{ needs.resolve.outputs.ref }}');
  if (!materialize) {
    findings.push(`${file}: job "build" must materialize needs.resolve.outputs.ref`);
  } else {
    const run = String(materialize.run ?? '');
    if (!/git worktree add --detach/.test(run)) {
      findings.push(`${file}: job "build" must materialize the resolved ref as a detached worktree`);
    }
    if (!run.includes('"$REF"')) {
      findings.push(`${file}: job "build" must materialize "$REF", never a movable branch name`);
    }
    if (!run.includes('RELEASE_TREE') || !run.includes('GITHUB_ENV')) {
      findings.push(`${file}: job "build" must export RELEASE_TREE to later steps`);
    }
  }
  if (!steps.some((step) => stepCommands(step).some((command) => command.startsWith('node scripts/check-apk.mjs')))) {
    findings.push(`${file}: job "build" must check the built APK`);
  }
  for (const [flag, target] of [
    ['--version-code', 'dist/version-code.txt'],
    ['--signing-scheme', 'dist/signing.json'],
  ]) {
    if (!steps.some((step) => stepCommands(step).some((command) => command.includes(flag) && command.includes(target)))) {
      findings.push(`${file}: job "build" must publish ${target} from build-android.mjs ${flag}`);
    }
  }
  findings.push(...keystoreOrderFindings(job, file, 'build'));
  if (
    JSON.stringify(job.env ?? {}).includes('ANDROID_ALLOW_TEST_KEY') ||
    steps.some((step) => JSON.stringify(step.env ?? {}).includes('ANDROID_ALLOW_TEST_KEY'))
  ) {
    findings.push(`${file}: job "build" must not set ANDROID_ALLOW_TEST_KEY itself; ${CI_KEYSTORE_COMMAND} owns the flag`);
  }
  const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  if (!upload) {
    findings.push(`${file}: job "build" must upload the unsigned artifact`);
  } else {
    if (upload.with?.name !== 'drypoint-unsigned') findings.push(`${file}: job "build" must upload the artifact as drypoint-unsigned`);
    if (upload.with?.path !== '${{ env.RELEASE_TREE }}/dist/*') {
      findings.push(`${file}: job "build" upload path must be exactly \${{ env.RELEASE_TREE }}/dist/*`);
    }
  }
  return findings;
}

function signFindings(workflow, file) {
  const findings = [];
  const job = workflow?.jobs?.sign;
  if (!isMap(job)) return [`${file}: job "sign" is missing`];
  if (job.environment !== 'release') findings.push(`${file}: job "sign" must use the release environment`);
  const needs = needsOf(job);
  for (const name of ['resolve', 'build']) if (!needs.includes(name)) findings.push(`${file}: job "sign" must need ${name}`);
  findings.push(
    ...exactConditionFindings(
      job.if,
      "needs.resolve.outputs.publish == 'true' || github.event_name == 'workflow_dispatch'",
      file,
      'job "sign" if:'
    )
  );
  findings.push(...releaseStepNamesFindings(job, file, 'sign'));
  findings.push(...plainStepFindings(job, file, 'sign'));
  findings.push(...sourceFindings(job, file, 'sign'));
  for (const [name, value] of [
    ['TAG', '${{ needs.resolve.outputs.tag }}'],
    ['SHA', '${{ needs.resolve.outputs.sha }}'],
    ['VERSION', '${{ needs.resolve.outputs.version }}'],
  ]) {
    if (job.env?.[name] !== value) findings.push(`${file}: job "sign" env ${name} must be exactly ${value}`);
  }
  if (job.permissions?.contents !== 'read') findings.push(`${file}: job "sign" permissions must include contents: read`);
  if (job.permissions?.['id-token'] !== 'write') findings.push(`${file}: job "sign" must request id-token: write`);
  if (job.permissions?.attestations !== 'write') findings.push(`${file}: job "sign" must request attestations: write`);
  if (!jobEnvText(job).includes('vars.RELEASE_CERT_SHA256')) {
    findings.push(`${file}: job "sign" must compare the signer with vars.RELEASE_CERT_SHA256`);
  }
  if (!jobEnvText(job).includes('vars.ANDROID_KEY_ALIAS')) {
    findings.push(`${file}: job "sign" must read the alias from vars.ANDROID_KEY_ALIAS, not a secret`);
  }
  if (!jobEnvText(job).includes('secrets.ANDROID_KEYSTORE_BASE64')) {
    findings.push(`${file}: job "sign" must decode the keystore from the release environment`);
  }
  const signText = JSON.stringify(job);
  for (const [needle, message] of [
    ['ANDROID_ALLOW_TEST_KEY', 'must never set ANDROID_ALLOW_TEST_KEY'],
    ['ci-keystore', 'must never run the CI throwaway keystore script'],
    [CI_THROWAWAY.password, 'must never contain the CI throwaway password'],
  ]) {
    if (signText.includes(needle)) findings.push(`${file}: job "sign" ${message}`);
  }
  for (const step of stepsOf(job)) {
    if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
      findings.push(`${file}: job "sign" must not check out repository code`);
    }
    for (const command of stepCommands(step)) {
      const tokens = shellTokens(command);
      if (tokens[0] === 'npm' || tokens[0] === 'node' || tokens[0] === 'npx') {
        findings.push(`${file}: job "sign" must not execute repository code: "${command}"`);
      }
      if (command.includes('scripts/')) {
        findings.push(`${file}: job "sign" must not execute repository scripts: "${command}"`);
      }
    }
  }
  const commands = stepsOf(job).flatMap(stepCommands);
  const joined = commands.join('\n');
  for (const [pattern, message] of [
    [/apksigner"?\s+sign/, 'sign with apksigner'],
    [/--min-sdk-version"?\s+"\$min_sdk"/, 'take the minimum SDK from the build manifest'],
    [/--v1-signing-enabled"?\s+"\$v1_signing"/, 'take the v1 scheme from the manifest-derived answer'],
    [/--v2-signing-enabled"?\s+true/, 'enable the v2 signature'],
    [/--v3-signing-enabled"?\s+true/, 'enable the v3 signature'],
    [/apksigner"?\s+verify/, 'verify the signature'],
    [/zipalign"?\s+-c\s+-v\s+4/, 'assert four-byte alignment'],
    [/aapt2"?\s+dump\s+badging/, 'assert package and version'],
    [/aapt2"?\s+dump\s+xmltree/, 'assert the binary manifest'],
    [/gh attestation download/, 'download the provenance bundle'],
    [/expected_package="package: name='\$\{package_id\}' versionCode='\$\{expected_version_code\}' versionName='\$\{VERSION\}'"/, 'assert the exact package, versionCode and versionName'],
    [/resolvedDependencies/, 'attest with a custom predicate'],
    [/predicate\.buildDefinition\.resolvedDependencies/, 'prove the provenance resolves the tag commit'],
    [/digest\.gitCommit == \$sha/, 'require the resolved commit exactly'],
  ]) {
    if (!pattern.test(joined)) findings.push(`${file}: job "sign" must ${message}`);
  }
  // The scheme has one owner: the manifest. A second hard-coded answer is
  // exactly the latent divergence this policy removes.
  if (/--min-sdk-version"?\s+26\b/.test(joined) || /--v1-signing-enabled"?\s+false/.test(joined)) {
    findings.push(`${file}: job "sign" must not hard-code the minSdk/signing scheme; read dist/signing.json`);
  }
  if (!stepsOf(job).some((step) => step.uses === 'actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880' && step.with?.['java-version'] === '21')) {
    findings.push(`${file}: job "sign" must use the pinned Temurin 21 action`);
  }
  const attest = stepsOf(job).find((step) => step.uses === 'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8');
  if (!attest) {
    findings.push(`${file}: job "sign" must use the pinned attest action`);
  } else {
    // The default predicate comes from github.context, where workflow_run sees
    // the default-branch HEAD. A step-level GITHUB_SHA is overwritten by GitHub
    // and does not change the action's context; the binding must be a custom
    // predicate file produced from needs.resolve.outputs.sha.
    if (attest.env?.GITHUB_SHA != null) {
      findings.push(`${file}: job "sign" must not override GITHUB_SHA on the attest action; pass predicate-path`);
    }
    if (attest.with?.['predicate-type'] !== 'https://slsa.dev/provenance/v1') {
      findings.push(`${file}: job "sign" attest step must set predicate-type: https://slsa.dev/provenance/v1`);
    }
    if (attest.with?.['predicate-path'] !== 'dist/provenance.json') {
      findings.push(`${file}: job "sign" attest step must pass predicate-path: dist/provenance.json`);
    }
    if (attest.with?.predicate != null) {
      findings.push(`${file}: job "sign" attest step must use predicate-path, not an inline predicate`);
    }
  }
  return findings;
}

function publishFindings(workflow, file) {
  const findings = [];
  const job = workflow?.jobs?.publish;
  if (!isMap(job)) return [`${file}: job "publish" is missing`];
  if (job.permissions?.contents !== 'write') findings.push(`${file}: job "publish" must hold contents: write`);
  for (const [scope, level] of Object.entries(job.permissions ?? {})) {
    if (scope !== 'contents' && level === 'write') findings.push(`${file}: job "publish" must not hold ${scope}: write`);
  }
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "publish" must not read secrets`);
  if (job.env?.GH_REPO !== '${{ github.repository }}') {
    findings.push(
      `${file}: job "publish" must set GH_REPO to \${{ github.repository }}; it has no checkout for gh to discover one`
    );
  }
  if (!needsOf(job).includes('resolve') || !needsOf(job).includes('sign')) {
    findings.push(`${file}: job "publish" must need resolve and sign`);
  }
  findings.push(...exactConditionFindings(job.if, "needs.resolve.outputs.publish == 'true'", file, 'job "publish" if:'));
  findings.push(...releaseStepNamesFindings(job, file, 'publish'));
  findings.push(...plainStepFindings(job, file, 'publish'));
  findings.push(...sourceFindings(job, file, 'publish'));
  // The tag is the resolved tag, never the ref name, the workflow_run branch or
  // a literal. Equality is the contract; a substring check let every alternate
  // source through.
  if (job.env?.TAG !== '${{ needs.resolve.outputs.tag }}') {
    findings.push(`${file}: job "publish" env TAG must be exactly \${{ needs.resolve.outputs.tag }}`);
  }
  if (job.env?.VERSION !== '${{ needs.resolve.outputs.version }}') {
    findings.push(`${file}: job "publish" env VERSION must be exactly \${{ needs.resolve.outputs.version }}`);
  }
  for (const step of stepsOf(job)) {
    if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
      findings.push(`${file}: job "publish" must not check out repository code`);
    }
    const commands = stepCommands(step);
    for (const command of commands) {
      const tokens = shellTokens(command);
      if (tokens[0] === 'npm' || tokens[0] === 'node' || tokens[0] === 'npx') {
        findings.push(`${file}: job "publish" must not execute repository code: "${command}"`);
      }
      if (command.includes('scripts/')) findings.push(`${file}: job "publish" must not execute repository scripts: "${command}"`);
    }
  }
  // Publish is a command allowlist. `gh release upload --clobber` can replace
  // an asset after the byte comparison; delete/api/raw shell can do worse.
  const allowedRelease = new Set(['view', 'download', 'create', 'edit']);
  for (const command of stepsOf(job).flatMap(stepCommands)) {
    const tokens = shellTokens(command);
    if (['curl', 'wget', 'eval', 'bash', 'sh', 'zsh'].includes(tokens[0])) {
      findings.push(`${file}: job "publish" must not run ${tokens[0]}: "${command}"`);
    }
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] !== 'gh') continue;
      if (tokens[index + 1] !== 'release') {
        findings.push(`${file}: job "publish" may only run gh release commands: "${command}"`);
        break;
      }
      const subcommand = tokens[index + 2];
      if (!allowedRelease.has(subcommand)) {
        findings.push(`${file}: job "publish" must not run gh release ${subcommand}`);
        break;
      }
      if (subcommand === 'edit' && !tokens.includes('--notes-file')) {
        findings.push(`${file}: job "publish" may only edit the notes body`);
      }
      if (tokens.includes('--clobber') && subcommand !== 'download') {
        findings.push(`${file}: job "publish" may only use --clobber on gh release download`);
      }
    }
  }
  const logic = jobLogic(workflow, 'publish');
  if (logic.includes('GITHUB_REF_NAME')) findings.push(`${file}: job "publish" must use $TAG, never GITHUB_REF_NAME`);
  const publishes = workflowCommands(workflow).filter(isPublishCommand);
  if (publishes.length !== 1) {
    findings.push(`${file}: job "publish" must contain exactly one gh release create command`);
  }
  return findings;
}

function existingReleaseFindings(workflow, file) {
  const findings = [];
  const publish = workflow?.jobs?.publish;
  if (!isMap(publish)) return findings;
  const logic = jobLogic(workflow, 'publish');
  for (const [pattern, message] of [
    [/gh release view "\$TAG"/, 'detect an existing release'],
    [/gh release download "\$TAG"/, 'download the existing assets'],
    [/cmp -s/, 'compare the existing assets byte-for-byte'],
    [/differs from this build/, 'fail when an existing asset differs'],
    [/exit 0/, 'treat an identical existing release as a pass'],
    [/--latest/, 'mark the release latest'],
    [/--notes-file/, 'publish the generated notes'],
    [/gh release edit "\$TAG"[^\n]*--notes-file/, 'refresh the notes on a re-run instead of exiting with a stale body'],
  ]) {
    if (!pattern.test(logic)) findings.push(`${file}: job "publish" must ${message}`);
  }
  return findings;
}

/**
 * Check the release workflow: trusted triggers, resolved publish command and
 * the split build/sign/publish authority.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {string[]}
 */
export function checkReleaseWorkflow(text, { file = RELEASE_FILE } = {}) {
  const { workflow, findings: parseFindings } = parseWorkflow(text);
  if (!workflow) return parseFindings.map((finding) => `${file}: ${finding}`);
  const findings = [...parseFindings.map((finding) => `${file}: ${finding}`)];
  findings.push(...triggerFindings(workflow, file));
  findings.push(...resolveFindings(workflow, file));
  findings.push(...buildFindings(workflow, file));
  findings.push(...signFindings(workflow, file));
  findings.push(...publishFindings(workflow, file));
  findings.push(...existingReleaseFindings(workflow, file));

  const publishes = publishCommands(text);
  const quoted = shellCommands(text).filter((command) => /^\s*(['"])gh\1\s+release\s+create\b/.test(command));
  for (const command of quoted) findings.push(`${file}: the gh command name must not be quoted: "${command}"`);
  const wrapped = shellCommands(text).filter(
    (command) => /^\s*(?:eval|bash|sh|zsh)\b/.test(command) && /\bgh\s+release\s+create\b/.test(command)
  );
  for (const command of wrapped) findings.push(`${file}: the publish command must not be wrapped in eval or a shell: "${command}"`);
  const decoys = shellCommands(text).filter(
    (command) => !isPublishCommand(command) && shellTokens(command).includes('--verify-tag')
  );
  for (const command of decoys) {
    findings.push(`${file}: --verify-tag must appear only on the gh release create command: "${command}"`);
  }
  if (!publishes.length) {
    findings.push(`${file}: no gh release create command found`);
  } else if (publishes.length !== 1) {
    findings.push(`${file}: exactly one gh release create command is allowed, found ${publishes.length}`);
  } else if (!shellTokens(publishes[0]).includes('--verify-tag')) {
    findings.push(`${file}: the release must pass --verify-tag on the gh release create command itself`);
  }
  if (text.includes('GITHUB_REF_NAME')) findings.push(`${file}: the release must not use GITHUB_REF_NAME`);
  return findings;
}

/**
 * Check every workflow in a tree.
 *
 * @param {{root?: string, workflows?: string}} [options]
 *   `workflows` is an explicit directory to scan as data; `root` is the
 *   repository root used for the default directory.
 * @returns {Promise<{findings: string[], files: string[]}>}
 */
export async function checkWorkflows({ root = ROOT, workflows } = {}) {
  const directory = workflows ? resolve(workflows) : join(root, WORKFLOW_DIR);
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const findings = [];
  for (const name of names) {
    if (!OWNED_WORKFLOWS.includes(name)) {
      findings.push(
        `${name}: workflow is not owned; GitHub runs every .yml/.yaml file, so the owned set is exactly ${OWNED_WORKFLOWS.join(', ')}`
      );
    }
  }
  for (const name of OWNED_WORKFLOWS) {
    if (!names.includes(name)) findings.push(`${name}: owned workflow is missing`);
  }
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');
    // The general policy (environment, secrets, permissions, pins, masks) is
    // applied to every file, not only the release workflow.
    findings.push(...checkWorkflow(text, { file: name }));
    if (basename(name) === RELEASE_FILE) findings.push(...checkReleaseWorkflow(text, { file: name }));
  }
  if (!names.length) findings.push(`${directory}: no workflows found`);
  return { findings, files: names };
}

async function main(argv) {
  let list = false;
  let workflows = '';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--list') list = true;
    else if (argument === '--workflows') {
      workflows = argv[++index] ?? '';
      if (!workflows) {
        console.error('workflows: --workflows needs a directory');
        return 2;
      }
    } else {
      console.error(`workflows: unknown option ${argument}`);
      console.error('usage: node scripts/check-workflows.mjs [--list] [--workflows <dir>]');
      return 2;
    }
  }
  const { findings, files } = await checkWorkflows(workflows ? { workflows } : {});
  if (list) console.log(`workflows: ${files.length} files checked`);
  if (!findings.length) return 0;
  for (const finding of findings) console.error(finding);
  console.error(`workflows: ${findings.length} finding(s) in ${files.length} files`);
  return 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`workflows: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
