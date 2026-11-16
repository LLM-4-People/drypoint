/**
 * Repository health files are not decoration: each one states a policy the
 * project actually follows, and these tests keep the statement present and
 * free of a made-up contact detail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { projectRoot, readProjectFile as read } from './helpers/project-files.mjs';
import { BRAND } from '../src/core/brand.js';

const exists = (path) => {
  try {
    readFileSync(join(projectRoot, path));
    return true;
  } catch {
    return false;
  }
};

test('LICENSE is MIT with the project copyright', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License$/m);
  assert.match(license, /^Copyright \(c\) 2026 LLM-4-People$/m);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(license, /WITHOUT WARRANTY OF ANY KIND/);
});

test('THIRD_PARTY_NOTICES carries the real copyright lines and the trademark note', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(notices, /src\/vendor\/qrcode\.js/);
  assert.match(notices, /MIT/);
  assert.match(notices, /DENSO WAVE INCORPORATED/);
  assert.match(notices, /JsBarcode/);
  assert.match(notices, /test\/fixtures\/code128-patterns\.json/);
  assert.match(notices, /NIIMBOT/);
  assert.match(notices, /not affiliated/i);
});

test('.gitattributes normalises line endings and marks the binaries', () => {
  assert.equal(read('.gitattributes').trim(), ['* text=auto eol=lf', '*.png binary', '*.apk binary', '*.jks binary'].join('\n'));
});

test('.editorconfig sets the shared style', () => {
  const editorconfig = read('.editorconfig');
  assert.match(editorconfig, /^root = true$/m);
  assert.match(editorconfig, /^end_of_line = lf$/m);
  assert.match(editorconfig, /^charset = utf-8$/m);
  assert.match(editorconfig, /^insert_final_newline = true$/m);
  assert.match(editorconfig, /^indent_style = space$/m);
});

test('.node-version names a Node line the package supports', () => {
  const version = read('.node-version').trim();
  assert.match(version, /^24\.\d+\.\d+$/, 'an exact development version');
  assert.match(read('package.json'), /"node": ">=22"/);
  assert.ok(Number(version.split('.')[0]) >= 22, 'the pinned version satisfies engines');
  assert.match(read('.github/workflows/checks.yml'), /node-version-file: \.node-version/);
});

test('SECURITY states the boundary, the supported line and the private channel', () => {
  const security = read('SECURITY.md');
  assert.match(security, /Web Serial/);
  assert.match(security, /Web Bluetooth/);
  assert.match(security, /Android bridge/);
  assert.match(security, /no network request/i);
  assert.match(security, /no analytics, no\s+telemetry/i);
  assert.match(security, /security\/advisories\/new/, 'the reporting channel is the advisory form');
  assert.match(security, /Coordinated disclosure/);
  assert.match(security, /\| 1\.x \| Yes/);
  assert.match(security, /signing certificate/);
  assert.match(security, /Out of scope/);
  assert.doesNotMatch(security, /\[INSERT CONTACT METHOD\]/);
  assert.doesNotMatch(security, /mailto:/, 'no address that does not exist');
});

test('CONTRIBUTING gives the real commands, branch model and generated-file rule', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /npm test/);
  assert.match(contributing, /npm run verify/);
  assert.match(contributing, /npm run build:brand -- --check/);
  assert.match(contributing, /npm run check:precache/);
  assert.match(contributing, /npm run build:android/);
  assert.match(contributing, /Chromium/, 'the layout suites need a browser');
  assert.match(contributing, /javac/, 'the filename test needs a JDK');
  assert.match(contributing, /Branch from the current `main`/);
  assert.match(contributing, /pull request against `main`/);
  assert.match(contributing, /required/);
  assert.match(contributing, /never edit by hand/i);
  assert.match(contributing, /Never commit secrets/);
  assert.match(contributing, /docs\/PRINTERS\.md/);
  assert.match(contributing, /never a guess/i);
});

test('SUPPORT explains what to include and what is out of scope', () => {
  const support = read('SUPPORT.md');
  assert.match(support, /security\/advisories\/new/);
  assert.match(support, /Before you paste anything, remove:/);
  assert.match(support, /printer's serial number/i);
  assert.match(support, /Only the D110_M is tested/);
  assert.match(support, /60 days/);
  assert.match(support, /no support contract and no warranty/i);
});

test('CODE_OF_CONDUCT is Contributor Covenant 2.1 with a real contact', () => {
  const conduct = read('CODE_OF_CONDUCT.md');
  assert.match(conduct, /^# Contributor Covenant Code of Conduct$/m);
  assert.match(conduct, /version 2\.1/);
  assert.match(conduct, /security\/advisories\/new/);
  assert.doesNotMatch(conduct, /\[INSERT CONTACT METHOD\]/);
  assert.doesNotMatch(conduct, /^\+\+\+/m, 'the TOML front matter is not published');
  assert.doesNotMatch(conduct, /^\[[a-z0-9.]+\]:\s/m, 'the link-reference block is inlined, not kept');
  for (const heading of ['Our Pledge', 'Our Standards', 'Enforcement Responsibilities', 'Scope', 'Enforcement', 'Enforcement Guidelines', 'Attribution']) {
    assert.ok(conduct.includes(`## ${heading}`), `${heading} is present`);
  }
});

test('the issue forms are present and cannot be bypassed with a blank issue', () => {
  for (const name of ['bug_report.yml', 'feature_request.yml', 'question.yml', 'config.yml']) {
    assert.equal(exists(`.github/ISSUE_TEMPLATE/${name}`), true, `${name} exists`);
  }
  const config = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(config, /^blank_issues_enabled: false$/m);
  assert.match(config, /security\/advisories\/new/);

  for (const name of ['bug_report.yml', 'feature_request.yml', 'question.yml']) {
    const form = read(`.github/ISSUE_TEMPLATE/${name}`);
    assert.match(form, /^name: .+$/m, `${name} has a name`);
    assert.match(form, /^description: .+$/m, `${name} has a description`);
    assert.match(form, /^body:$/m, `${name} has a body`);
    assert.match(form, /^  - type: /m, `${name} has fields`);
    for (const [index, type] of [...form.matchAll(/^  - type: (\S+)$/gm)].map((match) => [match.index, match[1]])) {
      assert.ok(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'].includes(type), `${name} field at ${index} is a real type`);
    }
    if (name !== 'question.yml') assert.match(form, /^\s+required: true$/m, `${name} requires an answer`);
  }
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.match(bug, /serial number/i, 'the bug form asks for redaction');
  assert.match(bug, /docs\/PRINTERS\.md/, 'the bug form points at the support matrix');
});

test('the pull request template asks for the commands actually run', () => {
  const template = read('.github/pull_request_template.md');
  for (const heading of ['## Summary', '## Target branch', '## Verification', '## Breaking change', '## Docs and safety']) {
    assert.ok(template.includes(heading), `${heading} is present`);
  }
  assert.match(template, /npm run verify/);
  assert.match(template, /Do not tick a box for a\s+command you did not run/);
  assert.match(template, /generated file/i);
  assert.match(template, /`main`/);
});

test('CODEOWNERS names the one default owner', () => {
  const owners = read('.github/CODEOWNERS');
  assert.match(owners, /^\* @amberflag48$/m);
});

test('dependabot tracks Actions and the one dev-only npm dependency', () => {
  const config = parse(read('.github/dependabot.yml'));
  assert.equal(config.version, 2);
  const updates = config.updates;
  assert.deepEqual(
    updates.map((entry) => entry['package-ecosystem']).sort(),
    ['github-actions', 'npm'],
    'both ecosystems are declared'
  );
  for (const entry of updates) {
    assert.equal(entry.directory, '/');
    assert.equal(entry['target-branch'], 'main');
    assert.equal(entry.schedule.interval, 'weekly');
    assert.equal(entry['open-pull-requests-limit'], 3);
    assert.ok(entry.groups && Object.keys(entry.groups).length === 1, `${entry['package-ecosystem']} groups minor and patch`);
  }
  const npm = updates.find((entry) => entry['package-ecosystem'] === 'npm');
  assert.equal(npm['commit-message'].prefix, 'deps');
  const actions = updates.find((entry) => entry['package-ecosystem'] === 'github-actions');
  assert.equal(actions['commit-message'].prefix, 'ci');
  // The comment owner states the real distinction: no runtime dependency,
  // one tracked dev-only dependency.
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /no npm runtime dependency/i);
  assert.match(dependabot, /package-lock\.json/);
});

test('the README is the public front door', () => {
  const readme = read('README.md');
  assert.match(readme, /^# Drypoint$/m);
  assert.match(readme, /actions\/workflows\/checks\.yml\/badge\.svg/, 'the CI badge');
  // Compare parsed URLs, not a substring: `https://evil.test/?u=<homepage>`
  // contains the authored homepage and is not the live app.
  const homepage = new URL(BRAND.homepage);
  const candidates = [...readme.matchAll(/https?:[^\s<>)"`\]]+/g)].map((match) => match[0]);
  const live = candidates.some((candidate) => {
    const url = new URL(candidate);
    return url.origin === homepage.origin && url.pathname === homepage.pathname;
  });
  assert.equal(live, true, `the live app link is exactly ${homepage.href}`);
  assert.match(readme, /releases\/latest/, 'the APK download link');
  assert.match(readme, /\*\*D110_M\*\* \| Tested/);
  assert.match(readme, /\*\*D11_H\*\* \| Experimental/);
  assert.match(readme, /Every other id the app recognises \| Not supported/);
  assert.match(readme, /names 21 ids/, 'the README states the named-refusal scope, not every vendor model');
  assert.match(readme, /not affiliated with NIIMBOT/i);
  assert.match(readme, /## Privacy/);
  assert.match(readme, /No network/);
  assert.match(readme, /## Quick start/);
});
