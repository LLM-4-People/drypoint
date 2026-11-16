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
  'actions/github-script': '3a2844b7e9c422d3c10d287c895573f7108da1b3',
});

const SHA = /^[0-9a-f]{40}$/;

/**
 * Remove a YAML trailing comment from one line.
 *
 * `permissions: write-all  # temporary` grants exactly as much as the bare
 * form, and `uses: actions/checkout@v7  # pinned later` is not a pin. A `#`
 * only starts a comment when it is at the start of the line or follows
 * whitespace and sits outside a quoted scalar.
 *
 * @param {string} line
 * @returns {string} the line without its comment, right-trimmed
 */
export function stripYamlComment(line) {
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

/** Every line with its trailing comment removed; the line count is unchanged. */
export function stripYamlComments(text) {
  return String(text)
    .split('\n')
    .map(stripYamlComment)
    .join('\n');
}

/** The `run:` key of one line, with its indentation and its block indicator. */
const RUN_KEY = /^(\s*)(?:-\s+)?run\s*:\s*([|>][+-]?\d*)?\s*(.*)$/;

/**
 * Split a workflow into what is syntax and what is a shell script.
 *
 * The body of a `run:` block is not workflow YAML: a line there that reads
 * `uses: actions/checkout@v1` is an echo, and a comment there is not a
 * command. Scanning the file as one blob both invented findings and let real
 * ones hide — a `# gh release create … --verify-tag` comment satisfied the tag
 * check, and a `run:` block mentioning `uses:` was reported as an unpinned
 * action.
 *
 * @param {string} text
 * @returns {{yaml: string, commands: string[]}}
 *   `yaml` has every run body blanked (line numbers preserved); `commands`
 *   holds the non-comment command lines, one per entry.
 */
export function splitRunBlocks(text) {
  const lines = String(text).split('\n');
  const yaml = [];
  const commands = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = RUN_KEY.exec(line);
    if (!match) {
      yaml.push(line);
      continue;
    }
    const [, indent, indicator, inline] = match;
    if (!indicator) {
      // `run: npm test` — one command on the key line.
      const command = stripYamlComment(inline);
      if (command && !command.startsWith('#')) commands.push(command);
      yaml.push(line.slice(0, line.length - inline.length));
      continue;
    }
    yaml.push(line.slice(0, line.length - inline.length));
    const width = indent.length + 1;
    for (let body = index + 1; body < lines.length; body++) {
      const bodyLine = lines[body];
      if (bodyLine.trim() && bodyLine.length - bodyLine.trimStart().length < width) break;
      const command = stripYamlComment(bodyLine);
      if (command.trim() && !command.trimStart().startsWith('#')) commands.push(command.trim());
      yaml.push('');
      index = body;
    }
  }
  return { yaml: yaml.join('\n'), commands };
}

/** The workflow with every `run:` body blanked: only YAML keys remain. */
export function withoutRunBlocks(text) {
  return splitRunBlocks(text).yaml;
}

/** The command lines of every `run:` block, comments excluded. */
export function commandLines(text) {
  return splitRunBlocks(text).commands;
}

/** The `uses:` values in one workflow, with their 1-based line numbers. */
export function usesReferences(text) {
  const references = [];
  for (const [index, line] of stripYamlComments(withoutRunBlocks(text)).split('\n').entries()) {
    // `uses :` is valid YAML and runs the same action; the spaces are not a
    // loophole around the pin check.
    const match = /^\s*(?:-\s*)?uses\s*:\s*(\S+)$/.exec(line);
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
  const lines = stripYamlComments(text).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join('\n');
}

/** The job names under `jobs:`, with the block each one owns. */
export function jobsOf(text) {
  const lines = stripYamlComments(text).split('\n');
  const start = lines.findIndex((line) => /^jobs\s*:\s*$/.test(line));
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
 * The job names one job declares in `needs:`.
 *
 * Both forms YAML allows are read: the flow list (`needs: [web, browser]`) and
 * the block list.
 *
 * @param {string} jobBlock
 * @returns {string[]}
 */
export function needsOf(jobBlock) {
  const lines = stripYamlComments(jobBlock).split('\n');
  for (const [index, line] of lines.entries()) {
    const flow = /^\s{4}needs\s*:\s*\[([^\]]*)\]\s*$/.exec(line);
    if (flow) {
      return flow[1]
        .split(',')
        .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    if (/^\s{4}needs\s*:\s*$/.test(line)) {
      const names = [];
      for (let next = index + 1; next < lines.length; next++) {
        const item = /^\s{6,}-\s*(\S+)\s*$/.exec(lines[next]);
        if (!item) break;
        names.push(item[1].replace(/^['"]|['"]$/g, ''));
      }
      return names;
    }
  }
  return [];
}

/**
 * Split one shell command into the simple commands joined by `&&`, `||`, `;`
 * or `|`. Quotes and backslash escapes are respected, so a separator inside a
 * quoted argument is not a command boundary.
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
    if (character === ';' || character === '|' || pair === '&&' || pair === '||') {
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
 * The logical shell commands in a workflow's run blocks.
 *
 * A backslash continuation joins the next physical line before the command is
 * examined. `run: |` bodies otherwise arrive one line at a time, which made
 * `--verify-tag` on a line of its own look present even when it was not part
 * of the `gh release create` invocation.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function shellCommands(text) {
  const commands = [];
  let pending = '';
  for (const line of commandLines(text)) {
    pending = pending ? `${pending} ${line.trim()}` : line.trim();
    if (pending.endsWith('\\')) {
      pending = pending.slice(0, -1).trimEnd();
      continue;
    }
    commands.push(...splitShellCommands(pending));
    pending = '';
  }
  if (pending) commands.push(...splitShellCommands(pending));
  return commands;
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
  const source = stripYamlComments(withoutRunBlocks(text));
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

  // A job-level `permissions:` overrides the workflow default, and quotes are
  // valid YAML around a scalar or a key. All three forms grant exactly the
  // same authority as the bare top-level token, so every declaration is
  // checked.
  const permissionKey = /^(\s*)(?:['"])?permissions(?:['"])?\s*:\s*(.*)$/;
  const declarations = lines
    .map((line, index) => ({ line, index, match: permissionKey.exec(line) }))
    .filter((entry) => entry.match);
  if (!declarations.some((entry) => entry.match[1] === '')) {
    findings.push(`${file}: no top-level permissions block`);
  }
  for (const { index, match } of declarations) {
    // The scalar may sit after the colon or on the next indented line
    // (`permissions:` newline `  "write-all"`); both are the same grant.
    let value = match[2].trim();
    if (!value) {
      for (let next = index + 1; next < lines.length; next++) {
        if (!lines[next].trim()) continue;
        const indent = lines[next].length - lines[next].trimStart().length;
        if (indent <= match[1].length) break;
        value = lines[next].trim();
        break;
      }
    }
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    if (value === 'write-all' || value === 'read-all') {
      findings.push(`${file}: line ${index + 1}: permissions are declared per scope, never write-all/read-all`);
    }
  }
  if (!/^concurrency\s*:/m.test(source)) findings.push(`${file}: no top-level concurrency block`);
  if (/pull_request_target/.test(source)) findings.push(`${file}: pull_request_target is banned`);

  const jobs = jobsOf(source);
  if (!jobs.length) findings.push(`${file}: no jobs`);
  for (const job of jobs) {
    if (!/^\s{4}timeout-minutes\s*:\s*\d+\s*$/m.test(job.block)) {
      findings.push(`${file}: job "${job.name}" has no timeout-minutes`);
    }
  }
  const aggregate = jobs.find((job) => job.name === AGGREGATE_JOB);
  if (aggregate) {
    const needed = needsOf(aggregate.block);
    for (const job of jobs) {
      if (job.name !== AGGREGATE_JOB && !needed.includes(job.name)) {
        findings.push(`${file}: job "${job.name}" is not listed in ${AGGREGATE_JOB}.needs`);
      }
    }
    // The aggregate is only maintenance-free when it reads the whole needs map:
    // an explicit map (or a needs.<job> read) has to be edited for every new
    // leg and can silently omit one.
    if (!/\$\{\{\s*toJSON\(\s*needs\s*\)\s*\}\}/.test(aggregate.block)) {
      findings.push(`${file}: job "${AGGREGATE_JOB}" must derive its result from toJSON(needs)`);
    } else {
      const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\{\{\s*toJSON\(\s*needs\s*\)\s*\}\}/.exec(
        aggregate.block
      );
      if (assignment) {
        const name = assignment[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reads = aggregate.block.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
        if (reads.length < 2) {
          findings.push(
            `${file}: job "${AGGREGATE_JOB}" assigns the toJSON(needs) result to "${assignment[1]}" but never reads it`
          );
        }
      }
    }
    if (/needs\.[A-Za-z0-9_-]+/.test(aggregate.block)) {
      findings.push(`${file}: job "${AGGREGATE_JOB}" hardcodes a leg name; use toJSON(needs)`);
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:-\s*)?uses\s*:\s*actions\/checkout@/.test(line)) continue;
    if (!stepAt(lines, index).join('\n').includes('persist-credentials: false')) {
      findings.push(`${file}: line ${index + 1}: checkout must set persist-credentials: false`);
    }
  }

  return findings;
}

/**
 * Check the release workflow: version tags only, and the tag is verified.
 *
 * `--verify-tag` must be on a command line. It used to be found anywhere in
 * the file, so a comment that mentioned it — or a `run:` script that only
 * echoed it — satisfied the gate while the real `gh release create` ran
 * without it.
 */
export function checkReleaseWorkflow(text, { file = RELEASE_FILE } = {}) {
  const findings = [];
  const triggers = topLevelBlock(text, 'on');
  if (!triggers) return [`${file}: no on: block`];
  if (!/^\s+tags\s*:/m.test(triggers)) findings.push(`${file}: the release must trigger on tags`);
  for (const forbidden of ['branches:', 'pull_request:', 'pull_request_target:', 'workflow_dispatch:', 'schedule:']) {
    if (triggers.includes(forbidden)) findings.push(`${file}: the release must not trigger on ${forbidden.replace(':', '')}`);
  }
  const publishes = shellCommands(text).filter((command) => /(?:^|\s)gh\s+release\s+create(?:\s|$)/.test(command));
  if (!publishes.length) {
    findings.push(`${file}: no gh release create command found`);
  } else if (!publishes.some((command) => /(?:^|\s)--verify-tag(?:\s|$)/.test(command))) {
    findings.push(`${file}: the release must pass --verify-tag on the gh release create command itself`);
  }
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
