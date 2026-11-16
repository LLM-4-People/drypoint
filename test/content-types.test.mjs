/**
 * P-F3: one content-type contract for the server, the worker, the browser
 * harness and the Pages smoke. These tests pin the shared data and the one
 * decision, and refuse a second hand-written map in the three consumers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  CONTENT_TYPES,
  contentTypeEssence,
  contentTypeFor,
  contentTypeProblem,
  workerContentTypesSource,
} from '../scripts/lib/content-types.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('every serving type is one of the types the worker accepts', () => {
  for (const [extension, entry] of Object.entries(CONTENT_TYPES)) {
    assert.match(extension, /^\.[a-z0-9]+$/, `${extension} is a lowercase extension`);
    assert.ok(entry.allowed.length > 0, `${extension} has an allowed list`);
    assert.ok(
      entry.allowed.includes(contentTypeEssence(entry.type)),
      `${extension} serves "${entry.type}" which its own allowed list must accept`
    );
  }
});

test('the extension lookup is case-insensitive and ignores a query or hash', () => {
  assert.equal(contentTypeFor('src/main.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('assets/APP.CSS'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('/sw.js?v=1'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('/404.html#top'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('LICENSE'), 'application/octet-stream');
  assert.equal(contentTypeEssence('Text/HTML; charset=UTF-8'), 'text/html');
  assert.equal(contentTypeEssence(null), '');
});

test('one decision refuses a missing or contradictory type and nothing else', () => {
  const cases = [
    ['/src/main.js', 'text/javascript; charset=utf-8', null, 'the serving type passes'],
    ['/src/main.js', 'application/javascript', null, 'a legal host variant passes'],
    ['/src/main.js', 'text/html; charset=utf-8', /contradicts the file extension/, 'a rewritten module is refused'],
    ['/src/main.js', null, /no content type/, 'a module without a type is refused'],
    ['/404.html', 'text/plain', /contradicts/, 'the fallback must be HTML'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8', null, 'the manifest passes'],
    ['/LICENSE', 'text/plain', null, 'an extension outside the contract is not judged'],
    ['/.nojekyll', '', null, 'a control marker is not judged'],
  ];
  for (const [file, type, expected, message] of cases) {
    const problem = contentTypeProblem(file, type);
    if (expected === null) assert.equal(problem, null, message);
    else assert.match(problem, expected, message);
  }
});

test('the stamped worker copy is the module, and it runs in a classic worker', () => {
  const source = workerContentTypesSource();
  assert.doesNotMatch(source, /\bexport\b|\bimport\b/, 'a classic worker cannot parse module syntax');
  const sandbox = vm.createContext({});
  vm.runInContext(`${source}\nthis.verdicts = [\n  contentTypeProblem('a.js', 'text/javascript; charset=utf-8'),\n  contentTypeProblem('a.js', 'text/html'),\n  contentTypeProblem('a.js', null),\n  contentTypeProblem('LICENSE', 'text/plain'),\n].join('|');\nthis.map = CONTENT_TYPES;`, sandbox, { filename: 'generated-content-types.js' });
  assert.equal(sandbox.verdicts, '|content type "text/html" contradicts the file extension|response has no content type|');
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.map)),
    JSON.parse(JSON.stringify(CONTENT_TYPES)),
    'the stamped map is the module map'
  );
});

test('the server, the worker test and the browser harness import the one owner', () => {
  // A second hand-written TYPES map is the drift this module exists to prevent.
  for (const file of ['scripts/serve.mjs', 'test/sw.test.mjs', 'test/helpers/browser-page.mjs']) {
    const source = read(file);
    assert.match(source, /from '.*lib\/content-types\.mjs'/, `${file} imports the owner`);
    assert.doesNotMatch(source, /const TYPES = \{/, `${file} has no private content-type map`);
  }
});
