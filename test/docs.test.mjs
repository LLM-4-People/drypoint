/**
 * The documentation gate: links, anchors and images resolve, and the public
 * support matrix cannot drift from the one model table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDocs, headingSlugs, headingText, markdownLinks, resolveTarget, stripFences } from '../scripts/check-docs.mjs';
import { CONFIG } from '../src/core/config.js';
import { MODELS } from '../src/protocol/models.js';
import { readProjectFile as read } from './helpers/project-files.mjs';

/** The data rows of the first table after one heading. */
function tableRows(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.ok(start >= 0, `${heading} exists`);
  const section = markdown.slice(start + heading.length);
  const end = section.indexOf('\n## ');
  const body = end < 0 ? section : section.slice(0, end);
  return body
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function plain(cell) {
  return cell.replaceAll('**', '').trim();
}

async function tempTree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, files: Object.keys(files) };
}

test('the published Markdown and issue templates have no broken or unrenderable link', async () => {
  const { findings, files, templates, links } = await checkDocs();
  assert.deepEqual(findings, [], 'no broken link, anchor or image');
  assert.ok(files >= 13, `the gate read the documentation (${files} files)`);
  assert.ok(templates >= 3, `the gate read the issue templates (${templates} templates)`);
  assert.ok(links >= 40, `the gate checked the links (${links})`);
});

test('fenced code is not document structure', () => {
  const markdown = ['# Real', '```md', '# Not a heading', '[not a link](nope.md)', '```', 'tail'].join('\n');
  assert.equal(stripFences(markdown).includes('# Not a heading'), false);
  assert.deepEqual(markdownLinks(markdown), []);
  assert.deepEqual([...headingSlugs(markdown)], ['real']);
});

test('heading slugs follow GitHub, including duplicates and inline code', () => {
  const slugs = headingSlugs(['## `0xDE` heartbeat info', '## Same', '## Same', '## Trailing ##', '### Em — dash (test)'].join('\n'));
  assert.deepEqual(
    [...slugs],
    ['0xde-heartbeat-info', 'same', 'same-1', 'trailing', 'em--dash-test'],
    'punctuation is removed, spaces become hyphens and repeats are numbered'
  );
});

test('a heading with HTML is refused instead of silently half-stripped', () => {
  assert.equal(headingText('Plain `code` heading'), 'Plain `code` heading');
  // A scrub would turn this into "alert(1)" and slug it as if it were text.
  assert.throws(() => headingText('<script>alert(1)</script>'), /may not contain HTML/);
  assert.throws(() => headingText('An <em>emphasis</em> heading'), /may not contain HTML/);
  assert.throws(() => headingSlugs('## <b>Bold</b>'), /may not contain HTML/);
});

test('a broken relative link, image and anchor are reported', async (t) => {
  const { root, files } = await tempTree(t, {
    'README.md': [
      '# Index',
      '[missing](docs/missing.md)',
      '![missing image](assets/none.png)',
      '[bad anchor](docs/page.md#not-there)',
      '[good anchor](docs/page.md#the-section)',
      '[self anchor](#index)',
      '',
    ].join('\n'),
    'docs/page.md': ['# Page', '', '## The section', ''].join('\n'),
  });
  const { findings } = await checkDocs({ root, files });
  const messages = findings.map((finding) => `${finding.line}:${finding.message}`);
  assert.deepEqual(messages, [
    '2:link target does not exist: docs/missing.md',
    '3:image target does not exist: assets/none.png',
    '4:missing anchor #not-there in docs/page.md',
  ]);
});

test('an absolute blob/main link is rejected even when it resolves today', async (t) => {
  const { root, files } = await tempTree(t, {
    'README.md': ['[protocol](https://github.com/LLM-4-People/drypoint/blob/main/docs/PROTOCOL.md)', ''].join('\n'),
  });
  const { findings } = await checkDocs({ root, files });
  assert.deepEqual(findings.map((finding) => finding.message), [
    'absolute blob link breaks on a rename: https://github.com/LLM-4-People/drypoint/blob/main/docs/PROTOCOL.md',
  ]);
});

test('a relative link in an issue template is reported', async (t) => {
  const { root, files } = await tempTree(t, {
    '.github/ISSUE_TEMPLATE/bug_report.yml': [
      'name: Bug report',
      'body:',
      '  - type: markdown',
      '    attributes:',
      '      value: |',
      '        See [printers](docs/PRINTERS.md#how-to-propose-a-new-model).',
      '',
    ].join('\n'),
    'docs/PRINTERS.md': ['# Printers', '', '## How to propose a new model', ''].join('\n'),
  });
  const { findings, templates } = await checkDocs({ root, files });
  assert.equal(templates, 1);
  assert.deepEqual(findings.map((finding) => finding.message), [
    'relative link in an issue template does not resolve on the issue page: docs/PRINTERS.md#how-to-propose-a-new-model',
  ]);
});

test('an issue-template blob link is checked against the real tree', async (t) => {
  const blob = 'https://github.com/LLM-4-People/drypoint/blob/main';
  const { root, files } = await tempTree(t, {
    'package.json': JSON.stringify({ repository: { url: 'https://github.com/LLM-4-People/drypoint.git' } }),
    '.github/ISSUE_TEMPLATE/feature_request.yml': [
      'body:',
      '  - type: markdown',
      '    attributes:',
      '      value: |',
      `        [printers](${blob}/docs/PRINTERS.md#how-to-propose-a-new-model)`,
      `        [gone](${blob}/docs/GONE.md)`,
      `        [anchor](${blob}/docs/PRINTERS.md#missing)`,
      `        [escapes](${blob}/../other/README.md)`,
      '',
    ].join('\n'),
    'docs/PRINTERS.md': ['# Printers', '', '## How to propose a new model', ''].join('\n'),
  });
  const { findings } = await checkDocs({ root, files });
  assert.deepEqual(findings.map((finding) => finding.message), [
    'issue-template link target does not exist: https://github.com/LLM-4-People/drypoint/blob/main/docs/GONE.md',
    'missing anchor #missing in docs/PRINTERS.md',
    'issue-template link escapes the repository: https://github.com/LLM-4-People/drypoint/blob/main/../other/README.md',
  ]);
});

test('a link that escapes the repository is reported', async (t) => {
  const { root, files } = await tempTree(t, { 'docs/README.md': '[up](../../etc/passwd)\n' });
  const { findings } = await checkDocs({ root, files });
  assert.deepEqual(findings.map((finding) => finding.message), ['link escapes the repository: ../../etc/passwd']);
});

test('a link target is resolved relative to the file that contains it', () => {
  assert.deepEqual(resolveTarget('docs/README.md', '../README.md#privacy'), { file: 'README.md', anchor: 'privacy' });
  assert.deepEqual(resolveTarget('README.md', 'docs/PROTOCOL.md?plain=1#frames'), { file: 'docs/PROTOCOL.md', anchor: 'frames' });
  assert.deepEqual(resolveTarget('README.md', '#top'), { file: 'README.md', anchor: 'top' });
});

test('the support matrix lists exactly the models the code knows', () => {
  const page = read('docs/PRINTERS.md');
  const rows = page
    .split('\n')
    .filter((line) => /^\| [^|]+ \| `0x[0-9a-f]{4}` \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

  const documented = rows.map(([name, id, status]) => ({
    name: name.replaceAll('**', ''),
    code: Number.parseInt(id.replaceAll('`', ''), 16),
    status,
  }));
  assert.equal(documented.length, MODELS.length, 'one row per model');
  assert.equal(new Set(documented.map((entry) => entry.code)).size, documented.length, 'no duplicate id');

  const statusOf = { confirmed: 'Tested', experimental: 'Experimental', unsupported: 'Not supported' };
  for (const model of MODELS) {
    const row = documented.find((entry) => entry.code === model.code);
    assert.ok(row, `0x${model.code.toString(16)} is documented`);
    assert.equal(row.name, model.name, `0x${model.code.toString(16)} name`);
    assert.equal(row.status, statusOf[model.support], `0x${model.code.toString(16)} status`);
  }

  assert.match(page, /No model other than the D110_M has been tested/);
  assert.match(page, /4 dots on every side/, 'the measured padding is stated');
  assert.match(page, /0\.51 mm/, 'the padding is stated in millimetres');
});

test('the README support matrix and the SUPPORT scope match the model table', () => {
  const readme = read('README.md');
  const rows = tableRows(readme, '## Support matrix');
  const status = new Map(rows.map(([model, state]) => [plain(model), state]));

  for (const model of MODELS.filter((entry) => entry.support === 'confirmed')) {
    assert.equal(status.get(model.name), 'Tested', `${model.name} is documented as tested`);
  }
  for (const model of MODELS.filter((entry) => entry.support === 'experimental')) {
    assert.equal(status.get(model.name), 'Experimental', `${model.name} is documented as experimental`);
  }
  assert.equal(status.get('Every other id the app recognises'), 'Not supported');
  assert.equal(status.get('Any model the printer reports outside the table'), 'Unknown');

  // The count is a fact from models.js, not a hand-maintained number.
  const count = `names ${MODELS.length} ids`;
  assert.ok(readme.includes(count), `README states "${count}"`);
  assert.ok(read('SUPPORT.md').includes(count), `SUPPORT states "${count}"`);
  assert.ok(read('docs/PRINTERS.md').includes(count), `PRINTERS states "${count}"`);
});

test('the README Web Serial range is the BCD range, not an extra version', () => {
  // BCD: chrome_android version_added 138, version_removed 148, partial RFCOMM,
  // then full from 148. The partial window is therefore 138–147, not 138–148.
  const readme = read('README.md');
  assert.match(readme, /148\+ \(138–147 partial RFCOMM\)/);
  assert.doesNotMatch(readme, /138–148/);
});

test('the ANDROID.md CSP quote is the one policy in index.html', () => {
  const html = read('index.html');
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(policy, 'index.html owns one CSP meta element');
  const quoted = read('docs/ANDROID.md').match(/Content-Security-Policy meta element —\n`([^`]+)`/)?.[1];
  assert.ok(quoted, 'ANDROID.md quotes the policy');
  assert.equal(quoted.replace(/\s+/g, ' ').trim(), policy, 'the quote is the whole policy, not a four-directive subset');
});

test('ANDROID.md states the call and picker timeouts the transport uses', () => {
  const doc = read('docs/ANDROID.md');
  const call = Math.round(CONFIG.transport.androidCallTimeoutMs / 1000);
  const picker = Math.round(CONFIG.transport.androidPickerTimeoutMs / 1000);
  assert.ok(call < picker, 'the picker is deliberately longer than a bridge call');
  assert.match(doc, new RegExp(`androidCallTimeoutMs\` \\(${call} s\\)`));
  assert.match(doc, new RegExp(`androidPickerTimeoutMs\` \\(${picker} s\\)`));
  assert.doesNotMatch(doc, /every call has `CONFIG\.transport\.androidCallTimeoutMs`/);
});

test('ANDROID.md lists both distribution notices beside the precache files', () => {
  const doc = read('docs/ANDROID.md');
  assert.match(doc, /bundles that list\s+plus the two distribution notices/);
  assert.match(doc, /`LICENSE` and `THIRD_PARTY_NOTICES\.md`/);
  assert.doesNotMatch(doc, /The APK bundles exactly\s+that list/);
});

test('the documentation index links every page in docs/', () => {
  const index = read('docs/README.md');
  for (const page of ['ARCHITECTURE.md', 'ANDROID.md', 'PRINTERS.md', 'PROTOCOL.md']) {
    assert.ok(index.includes(`(${page})`), `docs/README.md links ${page}`);
  }
});
