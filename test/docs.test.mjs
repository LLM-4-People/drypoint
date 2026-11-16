/**
 * The documentation gate: links, anchors and images resolve, and the public
 * support matrix cannot drift from the one model table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDocs, headingSlugs, markdownLinks, resolveTarget, stripFences } from '../scripts/check-docs.mjs';
import { MODELS } from '../src/protocol/models.js';
import { readProjectFile as read } from './helpers/project-files.mjs';

async function tempTree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'drypoint-docs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, files: Object.keys(files) };
}

test('every relative link in the published Markdown resolves', async () => {
  const { findings, files, links } = await checkDocs();
  assert.deepEqual(findings, [], 'no broken link, anchor or image');
  assert.ok(files >= 13, `the gate read the documentation (${files} files)`);
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

test('the documentation index links every page in docs/', () => {
  const index = read('docs/README.md');
  for (const page of ['ARCHITECTURE.md', 'ANDROID.md', 'PRINTERS.md', 'PROTOCOL.md']) {
    assert.ok(index.includes(`(${page})`), `docs/README.md links ${page}`);
  }
});

test('the README documents every script and every documented script exists', () => {
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  const documented = new Set([...readme.matchAll(/^npm (?:run )?([\w:.-]+)/gm)].map((match) => match[1]));
  assert.deepEqual([...documented].sort(), Object.keys(pkg.scripts).sort());
});
