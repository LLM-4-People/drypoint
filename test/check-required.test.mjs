/**
 * The aggregate check is a tested script, not an inline expression.
 *
 * A skipped required check is reported as success by GitHub, so the script
 * treats failure, skipped, cancelled and missing alike. The command line is
 * driven with fake maps; the workflow tests prove the required job calls this
 * script with `toJSON(needs)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { readNeeds, requiredFindings } from '../scripts/check-required.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const SCRIPT = join(projectRoot, 'scripts', 'check-required.mjs');

function run(env, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('every leg succeeded is the only pass', () => {
  assert.deepEqual(requiredFindings({ web: { result: 'success' }, browser: { result: 'success' } }), []);
});

test('failure, skipped, cancelled and a missing result all fail the aggregate', () => {
  const cases = [
    [{ web: { result: 'failure' } }, ['web=failure']],
    [{ web: { result: 'skipped' } }, ['web=skipped']],
    [{ web: { result: 'cancelled' } }, ['web=cancelled']],
    [{ web: {} }, ['web=missing']],
    [{ web: { result: 'failure' }, browser: { result: 'success' }, android: { result: 'skipped' } }, ['web=failure', 'android=skipped']],
  ];
  for (const [needs, expected] of cases) assert.deepEqual(requiredFindings(needs), expected);
});

test('an empty, missing or malformed map is a usage error, never a pass', () => {
  for (const value of [null, undefined, [], 'success', 1]) {
    assert.throws(() => requiredFindings(value), /NEEDS must be the JSON object/);
  }
  assert.throws(() => requiredFindings({}), /needs map is empty/);
});

test('NEEDS comes from the environment or --needs', () => {
  assert.deepEqual(readNeeds({ needs: '{"web":{"result":"success"}}', env: {} }), { web: { result: 'success' } });
  assert.deepEqual(readNeeds({ env: { NEEDS: '{"web":{"result":"success"}}' } }), { web: { result: 'success' } });
  assert.throws(() => readNeeds({ env: {} }), /NEEDS is not set/);
  assert.throws(() => readNeeds({ env: { NEEDS: 'not-json' } }), /not valid JSON/);
  assert.throws(() => requiredFindings(readNeeds({ needs: '[]', env: {} })), /JSON object/);
});

test('the command line exits nonzero and prints the failing legs', () => {
  const pass = run({ NEEDS: '{"web":{"result":"success"},"browser":{"result":"success"}}' });
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /web, browser all succeeded/);

  const failure = run({ NEEDS: '{"web":{"result":"failure"},"browser":{"result":"skipped"}}' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /web=failure/);
  assert.match(failure.stderr, /browser=skipped/);

  const missing = run({ NEEDS: '' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /NEEDS is not set/);

  const argument = run({}, ['--needs', '{"android":{"result":"cancelled"}}']);
  assert.equal(argument.status, 1);
  assert.match(argument.stderr, /android=cancelled/);

  const unknown = run({}, ['--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);
});
