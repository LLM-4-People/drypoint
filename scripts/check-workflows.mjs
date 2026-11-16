#!/usr/bin/env node
/**
 * Workflow policy gate.
 *
 * A GitHub Actions workflow is executable supply chain, and a tag reference is
 * mutable. This gate enforces the repository's rules mechanically:
 *
 *   - every `uses:` names a commit only (40 hex characters, no tag or branch),
 *   - only the actions on the pinned allowlist may be used at all,
 *   - every workflow declares a top-level `permissions:` and `concurrency:`,
 *   - every job declares `timeout-minutes:`,
 *   - a checkout never persists credentials,
 *   - `pull_request_target` is banned outright,
 *   - the release workflow runs on version tags only.
 *
 * GitHub is the syntax authority; `actionlint.yml` runs the pinned actionlint
 * on the same files. This script checks the policy YAML cannot express.
 *
 * Usage:
 *   node scripts/check-workflows.mjs          # exit 1 on any finding
 *   node scripts/check-workflows.mjs --list   # also print the scanned count
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WORKFLOW_DIR = '.github/workflows';
export const RELEASE_FILE = 'release.yml';

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
  'actions/github-script': '3a2844b7e9c422d3c10d287c895573f7108da1b3',
  'raven-actions/actionlint': '3d39aea434753780c3b3d4a1a31c854b4dbf49d7',
});

const SHA = /^[0-9a-f]{40}$/;

/** The `uses:` values in one workflow, with their 1-based line numbers. */
export function usesReferences(text) {
  const references = [];
  for (const [index, line] of String(text).split('\n').entries()) {
    const match = /^\s*(?:-\s*)?uses:\s*(\S+?)(?:\s+#.*)?\s*$/.exec(line);
    if (match) references.push({ line: index + 1, value: match[1] });
  }
  return references;
}

/**
 * The step that contains one line: from the nearest preceding list item to the
 * line before the next one at the same or a lower indentation.
 *
 * @param {string[]} lines
 * @param {number} from zero-based line index inside the step
 * @returns {string[]}
 */
export function stepAt(lines, from) {
  let start = from;
  while (start >= 0 && !/^\s*-\s+\S/.test(lines[start])) start--;
  if (start < 0) return lines.slice(from, from + 1);
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = from + 1;
  while (end < lines.length) {
    if (!lines[end].trim()) {
      end++;
      continue;
    }
    if (lines[end].length - lines[end].trimStart().length <= indent) break;
    end++;
  }
  return lines.slice(start, end);
}

/** The top-level key block of one workflow (`on:`, `permissions:`, `jobs:` …). */
export function topLevelBlock(text, key) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join('\n');
}

/** The job names under `jobs:`, with the block each one owns. */
export function jobsOf(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (!match) continue;
    let end = index + 1;
    while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
    jobs.push({ name: match[1], block: lines.slice(index, end).join('\n') });
    index = end - 1;
  }
  return jobs;
}

/**
 * Check one workflow's text against the policy.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {string[]} one message per finding
 */
export function checkWorkflow(text, { file = 'workflow' } = {}) {
  const findings = [];
  const source = String(text);
  const lines = source.split('\n');

  for (const reference of usesReferences(source)) {
    const at = reference.value.lastIndexOf('@');
    const action = at < 0 ? reference.value : reference.value.slice(0, at);
    const ref = at < 0 ? '' : reference.value.slice(at + 1);
    if (!SHA.test(ref)) {
      findings.push(`${file}: line ${reference.line}: ${reference.value} is not pinned to a 40-character commit`);
      continue;
    }
    const repo = action.split('/').slice(0, 2).join('/');
    if (!Object.hasOwn(PINNED_ACTIONS, repo)) {
      findings.push(`${file}: line ${reference.line}: ${repo} is not on the pinned action allowlist`);
    } else if (PINNED_ACTIONS[repo] !== ref) {
      findings.push(`${file}: line ${reference.line}: ${repo} must be pinned to ${PINNED_ACTIONS[repo]}`);
    }
  }

  if (!/^permissions:/m.test(source)) findings.push(`${file}: no top-level permissions block`);
  if (/^permissions:\s*(?:write-all|read-all)\s*$/m.test(source)) {
    findings.push(`${file}: permissions are declared per scope, never write-all/read-all`);
  }
  if (!/^concurrency:/m.test(source)) findings.push(`${file}: no top-level concurrency block`);
  if (/pull_request_target/.test(source)) findings.push(`${file}: pull_request_target is banned`);

  const jobs = jobsOf(source);
  if (!jobs.length) findings.push(`${file}: no jobs`);
  for (const job of jobs) {
    if (!/^\s{4}timeout-minutes:\s*\d+\s*$/m.test(job.block)) {
      findings.push(`${file}: job "${job.name}" has no timeout-minutes`);
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:-\s*)?uses:\s*actions\/checkout@/.test(line)) continue;
    if (!stepAt(lines, index).join('\n').includes('persist-credentials: false')) {
      findings.push(`${file}: line ${index + 1}: checkout must set persist-credentials: false`);
    }
  }

  return findings;
}

/** Check the release workflow: version tags only, and the tag is verified. */
export function checkReleaseWorkflow(text, { file = RELEASE_FILE } = {}) {
  const findings = [];
  const triggers = topLevelBlock(text, 'on');
  if (!triggers) return [`${file}: no on: block`];
  if (!/^\s+tags:/m.test(triggers)) findings.push(`${file}: the release must trigger on tags`);
  for (const forbidden of ['branches:', 'pull_request:', 'pull_request_target:', 'workflow_dispatch:', 'schedule:']) {
    if (triggers.includes(forbidden)) findings.push(`${file}: the release must not trigger on ${forbidden.replace(':', '')}`);
  }
  if (!/--verify-tag/.test(text)) findings.push(`${file}: the release must pass --verify-tag`);
  return findings;
}

/**
 * Check every workflow in the tree.
 *
 * @param {{root?: string}} [options]
 * @returns {Promise<{findings: string[], files: string[]}>}
 */
export async function checkWorkflows({ root = ROOT } = {}) {
  const directory = join(root, WORKFLOW_DIR);
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort();
  const findings = [];
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');
    findings.push(...checkWorkflow(text, { file: name }));
    if (name === RELEASE_FILE) findings.push(...checkReleaseWorkflow(text, { file: name }));
  }
  if (!names.length) findings.push(`${WORKFLOW_DIR}: no workflows found`);
  return { findings, files: names };
}

async function main(argv) {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--list');
  if (unknown.length) {
    console.error(`workflows: unknown option ${unknown.join(', ')}`);
    console.error('usage: node scripts/check-workflows.mjs [--list]');
    return 2;
  }
  const { findings, files } = await checkWorkflows();
  if (flags.includes('--list')) console.log(`workflows: ${files.length} files checked`);
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
