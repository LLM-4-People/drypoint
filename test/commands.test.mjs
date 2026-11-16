import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommand, commandTimeout, replyOpcode, INFO_KEYS, COMMANDS, OP, OP_ROLE, UNSUPPORTED_OPS } from '../src/protocol/commands.js';
import { CONFIG } from '../src/core/config.js';
import { toHex } from '../src/core/format.js';

test('print job frames match the captured official-app session', () => {
  assert.equal(toHex(buildCommand('printStart', { pages: 1, speed: 1 })), '55 55 01 09 00 01 00 00 00 00 00 01 00 08 aa aa');
  assert.equal(toHex(buildCommand('printStart', { pages: 2, speed: 1 })), '55 55 01 09 00 02 00 00 00 00 00 01 00 0b aa aa');
  assert.equal(toHex(buildCommand('printStart', { pages: 1, speed: 0 })), '55 55 01 09 00 01 00 00 00 00 00 00 00 09 aa aa');
  assert.equal(
    toHex(buildCommand('pageSize', { rows: 320, cols: 96, copies: 1 })),
    '55 55 13 0d 01 40 00 60 00 01 00 00 00 00 00 00 00 3e aa aa'
  );
  assert.equal(toHex(buildCommand('pageSize', { rows: 400, cols: 96, copies: 2 })), '55 55 13 0d 01 90 00 60 00 02 00 00 00 00 00 00 00 ed aa aa');
});

test('settings and maintenance frames', () => {
  assert.equal(toHex(buildCommand('setDensity', { value: 3 })), '55 55 21 01 03 23 aa aa');
  assert.equal(toHex(buildCommand('setLabelType', { value: 1 })), '55 55 23 01 01 23 aa aa');
  assert.equal(toHex(buildCommand('setAutoShutdown', { value: 3 })), '55 55 27 01 03 25 aa aa');
  assert.equal(toHex(buildCommand('calibrate', { value: 1 })), '55 55 8e 01 01 8e aa aa');
  assert.equal(toHex(buildCommand('soundSettings', { action: 2, item: 1, value: 0x00 })), '55 55 58 03 02 01 00 58 aa aa');
  assert.equal(toHex(buildCommand('cancelPrint')), '55 55 da 01 01 da aa aa');
  assert.equal(toHex(buildCommand('printerFree')), '55 55 c3 01 01 c3 aa aa');
});

test('connect frame carries the 0x03 prefix', () => {
  assert.equal(toHex(buildCommand('connect')), '03 55 55 c1 01 01 c1 aa aa');
});

test('rtc frame encodes the supplied date', () => {
  const date = new Date(2026, 10, 14, 13, 30, 5);
  assert.equal(toHex(buildCommand('setRtc', { date })), '55 55 07 08 01 07 ea 0b 0e 0d 1e 05 f0 aa aa');
});

test('reply opcodes follow the firmware rule', () => {
  assert.equal(replyOpcode('getInfo', { key: INFO_KEYS.modelId }), 0x48);
  assert.equal(replyOpcode('getInfo', { key: INFO_KEYS.serial }), 0x4b);
  assert.equal(replyOpcode('getInfo', { key: INFO_KEYS.battery }), 0x4a);
  assert.equal(replyOpcode('heartbeatInfo'), 0xde);
  assert.equal(replyOpcode('heartbeatAdvanced'), 0xd9);
  assert.equal(replyOpcode('capabilities'), 0xbf);
  assert.equal(replyOpcode('rfid'), 0x1b);
  assert.equal(replyOpcode('printStatus'), 0xb3);
});

test('every registered command builds without throwing', () => {
  const params = {
    value: 1,
    key: 0x08,
    rows: 320,
    cols: 96,
    copies: 1,
    pages: 1,
    speed: 1,
    item: 1,
    action: 2,
    date: new Date(),
  };
  for (const name of Object.keys(COMMANDS)) {
    assert.doesNotThrow(() => buildCommand(name, params), name);
    assert.doesNotThrow(() => replyOpcode(name, params), name);
  }
});

test('required parameters are validated before a frame or opcode is built', () => {
  assert.throws(() => buildCommand('getInfo', {}), /requires a valid "key"/);
  assert.throws(() => replyOpcode('getInfo', {}), /requires a valid "key"/);
  assert.throws(() => buildCommand('setDensity', { value: Number.NaN }), /requires a valid "value"/);
  assert.throws(() => buildCommand('setDensity', {}), /requires a valid "value"/);
  assert.throws(() => buildCommand('pageSize', { cols: 96 }), /requires a valid "rows"/);
  assert.throws(() => buildCommand('pageSize', { rows: 320 }), /requires a valid "cols"/);
  assert.throws(() => buildCommand('pageSize', { rows: 320, cols: 96, copies: 70000 }), /requires a valid "copies"/);
  assert.throws(() => buildCommand('pageSize', { rows: 320, cols: 96, copies: -1 }), /requires a valid "copies"/);
  assert.throws(() => buildCommand('soundSettings', {}), /requires a valid "item"/);
  assert.throws(() => buildCommand('soundSettings', { item: 1 }), /requires a valid "value"/);
  assert.throws(() => buildCommand('soundSettings', { item: 1, value: 256 }), /requires a valid "value"/);
  assert.throws(() => buildCommand('printStart', { pages: 1, speed: 7 }), /requires a valid "speed"/);
  assert.throws(() => buildCommand('printStart', { pages: 1, speed: 1, pageColor: 300 }), /requires a valid "pageColor"/);
  assert.throws(() => buildCommand('calibrate', {}), /requires a valid "value"/);
  assert.throws(() => buildCommand('calibrate', { value: -1 }), /requires a valid "value"/);
});

test('an omitted optional field still encodes its default', () => {
  assert.equal(toHex(buildCommand('pageSize', { rows: 320, cols: 96 })), toHex(buildCommand('pageSize', { rows: 320, cols: 96, copies: 1 })));
  assert.equal(
    toHex(buildCommand('printStart', { pages: 1, speed: 1 })),
    toHex(buildCommand('printStart', { pages: 1, speed: 1, pageColor: 0x00 }))
  );
});

test('the command registry is the only owner of command timeouts', () => {
  assert.equal(commandTimeout('printStatus'), CONFIG.protocol.timeouts.status);
  assert.equal(commandTimeout('heartbeatAdvanced'), CONFIG.protocol.timeouts.identity);
  assert.equal(commandTimeout('setDensity'), CONFIG.protocol.timeouts.control);
  assert.equal(commandTimeout('calibrate'), 20000);
  assert.equal(commandTimeout('testPage'), 20000);
});

test('no command claims the ambiguous 0xD3 reply', () => {
  // 0xD3 is both the documented Disconnect reply and the unsolicited row
  // counter, so a matching exchange could be satisfied by a status frame.
  assert.equal(COMMANDS.disconnect, undefined, 'the unused command is not registered');
  assert.equal(OP.DISCONNECT, 0xd2, 'the opcode stays documented');
  assert.equal(OP_ROLE.DISCONNECT, 'unused', 'and classified as never sent');
  for (const [name, command] of Object.entries(COMMANDS)) {
    const reply = typeof command.reply === 'function' ? command.reply({ key: 0x08 }) : command.reply;
    assert.notEqual(reply, 0xd3, `${name} must not expect 0xD3`);
  }
  assert.equal(UNSUPPORTED_OPS.ROW_COUNTER.code, 0xd3);
  assert.match(UNSUPPORTED_OPS.ROW_COUNTER.reason, /0xD3/);
});
