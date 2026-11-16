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

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WORKFLOW_DIR = '.github/workflows';
export const RELEASE_FILE = 'release.yml';
/** The one aggregate job whose whole purpose is to read its legs' results. */
export const AGGREGATE_JOB = 'required';

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
      'npm run build:android',
      'node scripts/check-apk.mjs --apk "android/build/drypoint-${version}.apk" --aapt2 "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2" --apksigner "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner"',
      'git diff --exit-code',
      'test -z "$(git status --porcelain)"',
    ]),
    policy: Object.freeze([
      'npm ci',
      'node scripts/check-workflows.mjs --workflows "$PR_TREE/.github/workflows"',
      'node scripts/check-privacy.mjs --root "$PR_TREE"',
    ]),
    required: Object.freeze(['node scripts/check-required.mjs']),
  }),
});

/** Commands that are a no-op or that discard the command they follow. */
const MASK_COMMANDS = new Set(['true', ':', 'exit 0']);
const SHA = /^[0-9a-f]{40}$/;
/** A masked gate step is rejected in both workflows that hold authority. */
const MASKABLE_WORKFLOWS = new Set(['checks.yml', RELEASE_FILE]);

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
  if (value.startsWith('./')) return findings;
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
  } else {
    if (String(scriptStep.env?.NEEDS ?? '').trim() !== '${{ toJSON(needs) }}') {
      findings.push(`${file}: job "${AGGREGATE_JOB}" must pass NEEDS: \${{ toJSON(needs) }} to the script`);
    }
    findings.push(...maskedStepFindings(scriptStep, file, AGGREGATE_JOB, stepCommands(scriptStep)));
  }

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
  if (workflow.permissions == null) findings.push(`${file}: no top-level permissions block`);
  if (workflow.concurrency == null) findings.push(`${file}: no top-level concurrency block`);
  if (mentionsKey(workflow.on, 'pull_request_target')) findings.push(`${file}: pull_request_target is banned`);

  for (const [name, job] of Object.entries(jobs)) {
    if (!isMap(job)) {
      findings.push(`${file}: job "${name}" is not a mapping`);
      continue;
    }
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0) {
      findings.push(`${file}: job "${name}" has no timeout-minutes`);
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
  if (file === 'checks.yml') {
    const on = isMap(workflow.on) ? workflow.on : {};
    if (!list(on.push?.tags).includes('v*')) findings.push(`${file}: Checks must run on v* tag pushes so the release can resolve them`);
    if (!list(on.push?.branches).includes('main')) findings.push(`${file}: Checks must run on main`);
    if (!Object.hasOwn(on, 'pull_request')) findings.push(`${file}: Checks must run on pull requests`);
    if (jobs.policy?.if != null) findings.push(`${file}: job "policy" must not skip a push or tag`);
  }
  if (file === 'checks.yml' && !jobs[AGGREGATE_JOB]) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" is missing`);
  }
  findings.push(...gateFindings(workflow, jobs, file));
  return findings;
}

/**
 * Every required merge-gate command must appear exactly once, in a step that
 * cannot be skipped or masked.
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
    for (const command of required) {
      const holders = stepsOf(job).filter((step) => stepCommands(step).includes(command));
      if (holders.length !== 1) {
        findings.push(
          `${file}: job "${jobName}" must run exactly one ${holders.length ? 'step with' : 'step containing'} "${command}"`
        );
        continue;
      }
      const [step] = holders;
      findings.push(...maskedStepFindings(step, file, jobName, stepCommands(step)));
    }
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
  return [...findings.map((finding) => `${file}: ${finding}`), ...parsedWorkflowFindings(workflow, file)];
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
  if (workflow.concurrency?.group !== 'release' || workflow.concurrency?.['cancel-in-progress'] !== false) {
    findings.push(`${file}: release concurrency must serialize the group "release"`);
  }
  return findings;
}

function resolveFindings(workflow, file) {
  const findings = [];
  const job = resolveBlock(workflow);
  if (!job) return [`${file}: job "resolve" is missing`];
  if (job.environment != null) findings.push(`${file}: job "resolve" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "resolve" must not read secrets`);

  const condition = typeof job.if === 'string' ? job.if.replace(/\s+/g, ' ').trim() : '';
  if (!condition.includes("github.event_name == 'workflow_dispatch'")) {
    findings.push(`${file}: job "resolve" must handle a manual dispatch`);
  }
  if (!condition.includes("github.event.workflow_run.event == 'push'")) {
    findings.push(`${file}: job "resolve" must only run for a push Checks run, never a pull request`);
  }
  if (!condition.includes("github.event.workflow_run.conclusion == 'success'")) {
    findings.push(`${file}: job "resolve" must only run after a successful Checks run`);
  }
  if (!/workflow_run\.event == 'push'\s*&&\s*github\.event\.workflow_run\.conclusion == 'success'/.test(condition)) {
    findings.push(`${file}: job "resolve" must require the push event and the success conclusion together`);
  }

  const outputs = isMap(job.outputs) ? job.outputs : {};
  for (const name of ['publish', 'tag', 'sha', 'version', 'ref']) {
    if (!(name in outputs)) findings.push(`${file}: job "resolve" must output ${name}`);
  }

  const steps = stepsOf(job);
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) {
    findings.push(`${file}: job "resolve" must check out main`);
  } else {
    if (checkout.with?.ref !== 'main') findings.push(`${file}: job "resolve" must check out main`);
    if (checkout.with?.['fetch-depth'] !== 0) findings.push(`${file}: job "resolve" must fetch the full history`);
    if (checkout.with?.['fetch-tags'] !== true) findings.push(`${file}: job "resolve" must fetch tags`);
  }

  const logic = steps.flatMap(stepCommands).join('\n');
  const required = [
    [/git tag --points-at/, 'derive the tag from the resolved commit with git tag --points-at'],
    [/out "ref=/, 'report the ref the build checks out'],
    [/git merge-base --is-ancestor/, 'verify the commit is an ancestor of origin/main'],
    [/package\.json/, 'verify the tag version against package.json'],
    [/gh release view/, 'detect an existing release'],
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
  const findings = [];
  const job = workflow?.jobs?.[name];
  if (!isMap(job)) return [`${file}: job "${name}" is missing`];
  for (const command of required) {
    const holders = stepsOf(job).filter((step) => stepCommands(step).includes(command));
    if (holders.length !== 1) {
      findings.push(`${file}: job "${name}" must run exactly one step containing "${command}"`);
      continue;
    }
    findings.push(...maskedStepFindings(holders[0], file, name, stepCommands(holders[0])));
  }
  return findings;
}

function buildFindings(workflow, file) {
  const required = [
    'npm ci',
    'node scripts/find-chrome.mjs',
    'npm run verify:all',
    'node scripts/release-notes.mjs --tag "$TAG" --commit "$SHA" --out dist/notes.md',
    'npm run build:android',
    'node scripts/check-apk.mjs --apk "dist/drypoint-${VERSION}-unsigned.apk" --aapt2 "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2" --apksigner "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner"',
    'git diff --exit-code',
    'test -z "$(git status --porcelain)"',
  ];
  const findings = jobGateFindings(workflow, file, 'build', required);
  const job = workflow?.jobs?.build;
  if (!isMap(job)) return findings;
  if (job.environment != null) findings.push(`${file}: job "build" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "build" must not read secrets`);
  const condition = typeof job.if === 'string' ? job.if : '';
  if (!condition.includes("needs.resolve.outputs.publish == 'true'") || !condition.includes('workflow_dispatch')) {
    findings.push(`${file}: job "build" must run only for a resolved release or a manual dry run`);
  }
  const steps = stepsOf(job);
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) findings.push(`${file}: job "build" must check out main`);
  else {
    // The build's own checkout is a fixed ref. A dynamic ref here is the
    // CodeQL cache-poisoning pattern: the resolved tag/SHA must be data for
    // git, materialized below, not an actions/checkout target.
    if (String(checkout.with?.ref ?? '') !== 'main') {
      findings.push(`${file}: job "build" must check out main, never a dynamic ref or a movable name`);
    }
    if (checkout.with?.['fetch-depth'] !== 0) findings.push(`${file}: job "build" checkout must fetch the full history`);
    if (checkout.with?.['fetch-tags'] !== true) findings.push(`${file}: job "build" checkout must fetch the tags`);
  }
  const materialize = steps.find((step) => step.env?.REF === '${{ needs.resolve.outputs.ref }}');
  if (!materialize) {
    findings.push(`${file}: job "build" must materialize needs.resolve.outputs.ref`);
  } else {
    const run = String(materialize.run ?? '');
    if (!/git worktree add --detach/.test(run)) {
      findings.push(`${file}: job "build" must materialize the resolved ref as a detached worktree`);
    }
    if (!run.includes('RELEASE_TREE') || !run.includes('GITHUB_ENV')) {
      findings.push(`${file}: job "build" must export RELEASE_TREE to later steps`);
    }
  }
  for (const command of required) {
    const holder = steps.find((step) => stepCommands(step).includes(command));
    if (holder && holder['working-directory'] !== '${{ env.RELEASE_TREE }}') {
      findings.push(`${file}: job "build" must run "${command}" in the resolved worktree`);
    }
  }
  if (!steps.some((step) => stepCommands(step).some((command) => command.startsWith('node scripts/check-apk.mjs')))) {
    findings.push(`${file}: job "build" must check the built APK`);
  }
  if (!steps.some((step) => step.env?.ANDROID_ALLOW_TEST_KEY === 'true')) {
    findings.push(`${file}: job "build" must build with ANDROID_ALLOW_TEST_KEY=true and no release secret`);
  }
  if (!steps.some((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))) {
    findings.push(`${file}: job "build" must upload the unsigned artifact`);
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
    [/--v1-signing-enabled"?\s+false/, 'disable the v1 signature'],
    [/--v2-signing-enabled"?\s+true/, 'enable the v2 signature'],
    [/--v3-signing-enabled"?\s+true/, 'enable the v3 signature'],
    [/apksigner"?\s+verify/, 'verify the signature'],
    [/zipalign"?\s+-c\s+-v\s+4/, 'assert four-byte alignment'],
    [/aapt2"?\s+dump\s+badging/, 'assert package and version'],
    [/aapt2"?\s+dump\s+xmltree/, 'assert the binary manifest'],
    [/gh attestation download/, 'download the provenance bundle'],
  ]) {
    if (!pattern.test(joined)) findings.push(`${file}: job "sign" must ${message}`);
  }
  if (!stepsOf(job).some((step) => step.uses === 'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8')) {
    findings.push(`${file}: job "sign" must use the pinned attest action`);
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
  if (!needsOf(job).includes('resolve') || !needsOf(job).includes('sign')) {
    findings.push(`${file}: job "publish" must need resolve and sign`);
  }
  const condition = typeof job.if === 'string' ? job.if : '';
  if (!condition.includes("needs.resolve.outputs.publish == 'true'")) {
    findings.push(`${file}: job "publish" must be gated on the resolved publish flag`);
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
    const text = await readFile(join(directory, name), 'utf8');
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
