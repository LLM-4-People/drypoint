/**
 * R7-4: the native filename rule is verified by compiling and running the real
 * Java, not by finding a string. A validator that returned true with dead
 * checks used to pass every test while the doc promised otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProjectFile, projectRoot } from './helpers/project-files.mjs';

const PACKAGE = 'dev/llm4people/drypoint';
const SOURCE = join(projectRoot, 'android', 'app', 'src', 'main', 'java', PACKAGE);

function javacAvailable() {
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The cases the bridge must accept or refuse, in one table for both sides. */
const CASES = [
  ['report.json', true],
  ['drypoint-diagnostics.json', true],
  ['a b.json', true],
  ['', false],
  ['.', false],
  ['..', false],
  ['../report.json', false],
  ['sub/report.json', false],
  ['sub\\report.json', false],
  ['a\u0000b.json', false],
];

test('the compiled Java filename rule accepts exactly one plain segment', async (t) => {
  if (!javacAvailable()) {
    if (process.env.CI === 'true') {
      assert.fail('javac is required in CI: the native filename rule cannot be compiled');
    }
    t.skip('javac is not installed; the Java rule cannot be compiled here');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-java-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'src', PACKAGE);
  await mkdir(source, { recursive: true });
  await cp(join(SOURCE, 'SafeFileName.java'), join(source, 'SafeFileName.java'));

  // The probe is generated here so the table above is the single source of the
  // cases; no fixture can drift from the assertion.
  const literal = (value) =>
    `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\u0000', '\\0')}"`;
  const lines = [
    `package ${PACKAGE.replaceAll('/', '.')};`,
    'public final class SafeFileNameProbe {',
    '  public static void main(String[] args) {',
    '    String[] names = {',
    ...CASES.map(([name]) => `      ${literal(name)},`),
    '    };',
    '    for (String name : names) {',
    '      System.out.println((name.equals("") ? "<empty>" : name.replace("\\0", "<NUL>")) + "\\t" + SafeFileName.isSafe(name));',
    '    }',
    '  }',
    '}',
  ];
  await writeFile(join(source, 'SafeFileNameProbe.java'), lines.join('\n'));

  execFileSync(
    'javac',
    ['-encoding', 'UTF-8', '-d', join(directory, 'classes'), join(source, 'SafeFileName.java'), join(source, 'SafeFileNameProbe.java')],
    { stdio: 'pipe' }
  );
  const output = execFileSync('java', ['-cp', join(directory, 'classes'), `${PACKAGE.replaceAll('/', '.')}.SafeFileNameProbe`], {
    encoding: 'utf8',
  });
  const results = new Map(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const [name, allowed] = line.split('\t');
        return [name, allowed];
      })
  );

  for (const [name] of CASES) {
    const label = name === '' ? '<empty>' : name.replace('\u0000', '<NUL>');
    assert.equal(results.get(label), String(CASES.find(([value]) => value === name)[1]), `${label} is ${CASES.find(([value]) => value === name)[1] ? 'safe' : 'refused'}`);
  }
});

test('BleBridge delegates the filename rule and the docs name the real caller', () => {
  const bridge = readProjectFile(`android/app/src/main/java/${PACKAGE}/BleBridge.java`);
  assert.doesNotMatch(bridge, /private static boolean isSafeFileName/, 'the rule has one owner');
  assert.match(bridge, /SafeFileName\.isSafe\(name\)/);

  const doc = readProjectFile('docs/ANDROID.md');
  assert.match(doc, /`src\/core\/dom\.js` \(`downloadJson`\) is the only `saveFile` caller/);
  assert.match(doc, /Bluetooth connection failed \(status N\)/);
  assert.doesNotMatch(doc, /shows "Connect failed"/, 'the doc quotes a message the Java never emits');
});
