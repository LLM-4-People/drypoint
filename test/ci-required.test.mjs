/**
 * D5: a missing tool must fail in CI, not skip.
 *
 * The skip paths are honest on a developer machine without a JDK or Chromium,
 * but a skip in CI would hide the very regression the test exists to catch.
 * These tests spawn the real suites with `CI=true` and a deliberately absent
 * toolchain, and require a failure (never "skipped 1").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectRoot } from './helpers/project-files.mjs';

/** Run one test file with an environment that cannot satisfy its skip path. */
function runIsolated(file, environment) {
  // A test child inherits NODE_TEST_CONTEXT; the spawned runner must be a clean
  // top-level runner, not a hidden child of the outer one.
  const env = { ...process.env, ...environment };
  delete env.NODE_TEST_CONTEXT;
  try {
    const stdout = execFileSync(process.execPath, ['--test', file], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000,
      env,
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('safe-filename fails in CI when javac is unavailable', async (t) => {
  const bin = await mkdtemp(join(tmpdir(), 'drypoint-nobin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  // PATH finds no javac (the helper calls it by bare name), while Node itself
  // runs from an absolute path.
  const result = runIsolated('test/safe-filename.test.mjs', { CI: 'true', PATH: bin });
  assert.notEqual(result.status, 0, 'a CI run without javac must fail');
  assert.match(result.output, /javac is required in CI/);
  assert.doesNotMatch(result.output, /skipped 1/);
});

test('measured layout tests fail in CI when Chromium is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-nochromium-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = join(directory, 'chromium-required.test.mjs');
  const helper = new URL('./helpers/browser-page.mjs', import.meta.url).href;
  await writeFile(
    probe,
    `import test from 'node:test';\nimport { withPage } from '${helper}';\n\ntest('probe', async (t) => {\n  await withPage(t, () => {});\n});\n`
  );

  const result = runIsolated(probe, { CI: 'true', D110_CHROME: join(directory, 'missing-chrome') });
  assert.notEqual(result.status, 0, 'a CI run without Chromium must fail');
  assert.match(result.output, /Chromium is required in CI/);
  assert.doesNotMatch(result.output, /skipped 1/);
});

test('the browser harness reads the port Chromium chose instead of probing one', () => {
  // Regression: a probe on port 0 returns an ephemeral port, the probe closes,
  // and a parallel test can claim that port before Chromium binds it. Chromium
  // records its own allocation in DevToolsActivePort when asked for port 0.
  const source = readFileSync(new URL('./helpers/browser-page.mjs', import.meta.url), 'utf8');
  assert.match(source, /--remote-debugging-port=0/, 'the OS assigns the debugging port');
  assert.match(source, /DevToolsActivePort/, 'the harness reads the port Chromium recorded');
  assert.doesNotMatch(source, /freePort|createNetServer/, 'no check-then-bind probe remains');
});
