import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS, OP, OP_ROLE, UNSUPPORTED_OPS } from '../src/protocol/commands.js';

const supported = Object.keys(OP);
const unsupported = Object.keys(UNSUPPORTED_OPS);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Every src module except the registry itself, concatenated. */
const callersSource = walk(join(root, 'src'))
  .filter((file) => file.endsWith('.js') && !file.endsWith(join('protocol', 'commands.js')))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

/** A command is "named by a caller" when a src module passes it to a protocol entry point. */
const hasCaller = (name) => {
  const pattern = new RegExp(`(?:tryRequest|tryQuery|request|query|send|buildCommand|commandTimeout|diagnostic|probe)\\([^;]{0,120}?['"\`]${name}['"\`]`);
  return pattern.test(callersSource);
};

test('every known opcode is classified exactly once', () => {
  assert.deepEqual(Object.keys(OP_ROLE).sort(), [...supported, ...unsupported].sort());

  for (const [name, role] of Object.entries(OP_ROLE)) {
    assert.ok(['request', 'unused', 'inbound', 'unsupported'].includes(role), `${name} has a known role`);
    if (role === 'unsupported') assert.ok(unsupported.includes(name), `${name} is declared unsupported`);
    else assert.ok(supported.includes(name), `${name} has a live opcode`);
  }
});

test('opcode numbers are unique across requests, inbound and unsupported entries', () => {
  const codes = [
    ...Object.entries(OP).map(([name, code]) => [name, code]),
    ...Object.entries(UNSUPPORTED_OPS).map(([name, definition]) => [name, definition.code]),
  ];
  const seen = new Map();
  for (const [name, code] of codes) {
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 0xff, `${name} is one byte`);
    assert.ok(!seen.has(code), `${name} reuses 0x${code.toString(16)} already owned by ${seen.get(code)}`);
    seen.set(code, name);
  }
});

test('every command builds from a classified request or unused opcode', () => {
  const allowed = new Map(
    Object.entries(OP)
      .filter(([name]) => OP_ROLE[name] === 'request' || OP_ROLE[name] === 'unused')
      .map(([name, code]) => [code, name])
  );
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.ok(allowed.has(command.op), `${name} sends 0x${command.op.toString(16)}, which is not a request opcode`);
  }
});

test('OP_ROLE matches which commands a caller actually names', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    const opcodeName = Object.keys(OP).find((key) => OP[key] === command.op);
    const role = OP_ROLE[opcodeName];
    if (role === 'request') assert.ok(hasCaller(name), `${name} is classified as sent but no src module names it`);
    if (role === 'unused') assert.ok(!hasCaller(name), `${name} is classified as unused but a src module names it`);
  }
});

test('unsupported opcodes carry a reason instead of pretending to work', () => {
  for (const [name, definition] of Object.entries(UNSUPPORTED_OPS)) {
    assert.ok(typeof definition.reason === 'string' && definition.reason.length > 10, `${name} explains the gap`);
    assert.ok(!(name in OP), `${name} is not also a live opcode`);
  }
});
