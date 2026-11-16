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
import { listProjectFiles, readProjectFile as read } from './helpers/project-files.mjs';

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

test('the APK is described as BLE-only without claiming Android cannot do SPP', () => {
  const doc = read('docs/ANDROID.md');
  assert.match(doc, /\*\*BLE-only\*\*, because a WebView gives the page no Web Serial/);
  assert.match(doc, /Chrome for Android 148\+ exposes Web Serial, including\s+RFCOMM serial ports/);
  assert.match(doc, /138–147 exposed it partially/);
  assert.doesNotMatch(doc, /Android's Web Serial cannot reach Bluetooth Classic SPP/);
});

test('the backup section states both importers and the 1.0.2 APK limitation', () => {
  const readme = read('README.md');
  assert.match(readme, /\*\*Export a label\.\*\* Open \*\*Document → Export label\*\*/);
  assert.match(readme, /\*\*Import a label\.\*\* Open \*\*Document → Import label\*\*/);
  assert.match(readme, /Import works\s+in the web app and in the Android APK from 1\.0\.3/);
  assert.match(readme, /The 1\.0\.2 APK's file picker is\s+filtered to images/);
  assert.match(readme, /cannot restore a label inside a downgraded\s+1\.0\.0 or 1\.0\.1 build/);
  assert.match(readme, /importer refuses a file whose image sources\s+exceed the authoring budget/);

  // The retired-key warning is above the install links, not only in Backup.
  const warning = readme.indexOf('Do not install v1.0.0 for new work');
  assert.ok(warning >= 0, 'the README carries the v1.0.0 warning');
  assert.ok(warning < readme.indexOf('**Live app:**'), 'the warning is above the install links');
  assert.match(readme, /the 1\.0\.0 APK had been downloaded/, 'the retirement claim is not "before any public install"');
  assert.doesNotMatch(readme, /retired before any public install/);
});

test('the file surface names every saveFile caller', () => {
  const saveFile = /label export, the diagnostics report(?:,| and)/;
  assert.match(read('README.md'), saveFile);
  assert.match(read('SECURITY.md'), /one `saveFile` method \(label export, diagnostics\s+report, or\s+the raw copy of an unreadable stored label\)/);
  assert.match(read('SECURITY.md'), /native save bridge \(label export, diagnostics report, and the raw copy of\s+an unreadable stored label\)/);
  assert.match(read('docs/ANDROID.md'), /the label export, the\s+diagnostics report and the raw\s+copy of an unreadable stored label/);
  assert.doesNotMatch(read('SECURITY.md'), /beyond the image picker and the diagnostics download/);
});

test('the backup claim does not promise a D2D copy is impossible', () => {
  const clause = /device-to-device\s+migration is controlled by the manufacturer and\s+cannot be disabled by the app on/;
  assert.match(read('docs/ANDROID.md'), clause);
  assert.match(read('android/AndroidManifest.template.xml'), clause);
  assert.doesNotMatch(read('docs/ANDROID.md'), /never copied into a cloud or\s+device-to-device backup/);
});

test('Edge is an API mirror, not a hardware-tested serial path', () => {
  const readme = read('README.md');
  assert.match(readme, /Edge exposes the\s+same Chromium APIs but was not hardware-tested/);
  assert.doesNotMatch(readme, /Chrome or Edge is the tested serial path/);
  assert.doesNotMatch(readme, /Web Serial is tested on desktop Chrome\/Edge/);
});

test('the transfer-memory limit is stated with the bound and the mitigation', () => {
  const readme = read('README.md');
  assert.match(readme, /about 65 MB\s+of JSON/);
  assert.match(readme, /export a smaller label or remove an image first/);
  assert.match(read('docs/ANDROID.md'), /about 65 MB of JSON/);
});

test('the release runbook covers every failed or partial outcome', () => {
  const doc = read('docs/ARCHITECTURE.md');
  const section = doc.slice(doc.indexOf('### Failed or partial releases'), doc.indexOf('Every workflow pins'));
  assert.ok(section.length > 0, 'the runbook exists');
  for (const phrase of [
    'Re-run the failed job',
    'Do not delete or recreate the tag',
    'asset is missing or wrong',
    'Immutable releases',
    'signature or an asset digest does not match',
    'Pages failed after a green',
    'Pages has no per-deploy rollback',
    'provenance workflow ref refs/heads/main',
    'git rev-list -n 1',
  ]) {
    assert.ok(section.includes(phrase), `the runbook states: ${phrase}`);
  }

  // The tag example is derived from package.json, never a past/future literal.
  assert.match(doc, /v<package\.json version>/);
  assert.match(doc, /git tag "v\$\{version\}"/);
  assert.match(doc, /must not already exist/);
  assert.doesNotMatch(doc, /git tag v1\.0\.\d/);

  const history = doc.slice(doc.indexOf('### Historical release bodies'));
  assert.match(history, /--tag v1\.0\.0 --historical --out/);
  assert.match(history, /gh api repos\/LLM-4-People\/drypoint\/releases\/tags\/v1\.0\.0/);
  assert.match(history, /never used by the release workflow/);
});

test('the issue templates point at the latest release, not a past version', () => {
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  const question = read('.github/ISSUE_TEMPLATE/question.yml');
  // A version-free placeholder cannot go stale: the description already sends
  // the reporter to the Releases page for the latest tag.
  assert.match(bug, /placeholder: The latest release tag, or a commit SHA/);
  assert.match(bug, /latest release tag from the Releases page/);
  assert.doesNotMatch(bug, /placeholder: 1\.0\.\d/);
  assert.doesNotMatch(question, /Web app 1\.0\.\d/);
  assert.match(question, /Web app <release tag>/);
});

test('SECURITY.md does not present 1.0.0 as a supported install', () => {
  const security = read('SECURITY.md');
  const table = security.slice(security.indexOf('## Supported versions'), security.indexOf('## Reporting a vulnerability'));
  assert.match(table, /\| 1\.0\.0 \| No — do not install it\./);
  assert.match(table, /retired before any known install \(the 1\.0\.0 APK had been downloaded\)/);
  assert.match(table, /uninstalling it deletes every label/);
  assert.doesNotMatch(table, /\| 1\.x \| Yes/);
});

test('the README and ARCHITECTURE storage-key tables are the storageKey() calls', () => {
  const keys = new Set();
  for (const file of listProjectFiles('src').filter((entry) => entry.endsWith('.js'))) {
    for (const match of read(file).matchAll(/storageKey\('([^']+)'\)/g)) {
      keys.add(`${CONFIG.app.storagePrefix}.${match[1]}`);
    }
  }
  const expected = [...keys].sort();
  assert.equal(expected.length, 4, 'document, settings, rolls and zoom are the whole set');

  const readmeRows = tableRows(read('README.md'), '## Storage keys');
  const readmeKeys = readmeRows.map(([key]) => key.replaceAll('`', '').trim()).sort();
  assert.deepEqual(readmeKeys, expected, 'the README table names exactly the storage keys');

  const architectureRows = tableRows(read('docs/ARCHITECTURE.md'), '## Storage keys');
  const architectureKeys = architectureRows.map(([key]) => key.replaceAll('`', '').trim()).sort();
  assert.deepEqual(architectureKeys, expected, 'the ARCHITECTURE table names exactly the storage keys');

  const documentRow = readmeRows.find(([key]) => key.includes(`${CONFIG.app.storagePrefix}.document`));
  assert.ok(documentRow[1].includes(`version: ${CONFIG.app.documentVersion}`), 'the document version is the code owner');
});

test('PROTOCOL.md links the one model table instead of copying it', () => {
  const protocol = read('docs/PROTOCOL.md');
  assert.ok(protocol.includes('[the printer support matrix](PRINTERS.md)'));
  assert.doesNotMatch(
    protocol,
    /^\|\s*[^|]+\|\s*`0x[0-9a-f]{4}`\s*\|/m,
    'a second model-id table is refused; link PRINTERS.md instead'
  );
  assert.doesNotMatch(protocol, /\| \*\*D110_M\*\* \| `0x0910`/);
});

test('the documented printer controls are the panel labels', () => {
  const panel = read('src/ui/print-panel.js');
  const labels = new Set([...panel.matchAll(/actionButton\('([^']+)'/g)].map((match) => match[1]));
  for (const label of [
    'Feed / align paper',
    'Self-test page',
    'Sync clock',
    'Read paper info',
    'Read history',
    'Read capabilities',
    'Read device info',
    'Reset settings',
    'Export report',
    'Open log',
  ]) {
    assert.ok(labels.has(label), `print-panel builds "${label}"`);
  }
  assert.match(read('docs/PRINTERS.md'), /\*\*Feed \/\s*align paper\*\*/);
  assert.match(read('SUPPORT.md'), /Export report/);
  assert.match(read('.github/ISSUE_TEMPLATE/bug_report.yml'), /Export report/);
  assert.doesNotMatch(read('docs/PRINTERS.md'), /Feed \/ Align one label/);
});

test('the 12 mm scope and the protocol-compatible refusals are stated', () => {
  const page = read('docs/PRINTERS.md');
  assert.match(page, /## Why 12 mm is a scope decision, not a protocol limit/);
  const rows = new Map(tableRows(page, '## Support matrix').map((cells) => [plain(cells[0]), cells]));
  for (const [model, width] of [['D101', '24 mm'], ['B21 Pro', '50 mm'], ['B2 Pro', '50 mm'], ['B1 Pro', '50 mm']]) {
    const row = rows.get(model);
    assert.ok(row, `${model} is in the table`);
    assert.ok(row.join(' ').includes(width), `${model} names its ${width} media`);
    assert.match(row[5], /scope/i, `${model}'s refusal is a scope decision`);
  }
  assert.match(page, /D11_Pro is a 12 mm model, but only one uncorroborated source/);
  assert.match(page, /stays unsupported pending a device capture/);
  assert.match(page, /M2_H/);
  assert.match(page, /The discovery prefix is a filter, not a support claim/);
  assert.doesNotMatch(page, /every protocol fact/);
  assert.doesNotMatch(read('README.md'), /every other known/i);
  assert.doesNotMatch(read('SUPPORT.md'), /every other known model/i);
});

test('the documentation index links every page in docs/', () => {
  const index = read('docs/README.md');
  for (const page of ['ARCHITECTURE.md', 'ANDROID.md', 'PRINTERS.md', 'PROTOCOL.md']) {
    assert.ok(index.includes(`(${page})`), `docs/README.md links ${page}`);
  }
});
