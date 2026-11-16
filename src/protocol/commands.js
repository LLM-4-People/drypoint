/**
 * Command registry. One entry per opcode; every request in the app is built
 * here so payload layouts never drift between callers.
 */

import { CONFIG } from '../core/config.js';
import { encodeFrame, u16be } from './frames.js';

export const OP = Object.freeze({
  PRINT_START: 0x01,
  SET_RTC: 0x07,
  GET_KEY_FUNCTION: 0x09,
  ANTI_FAKE: 0x0b,
  SET_PAGE_SIZE: 0x13,
  GET_RFID: 0x1a,
  SET_DENSITY: 0x21,
  SET_PRINT_SPEED: 0x22,
  SET_LABEL_TYPE: 0x23,
  SET_LANGUAGE: 0x26,
  SET_AUTO_SHUTDOWN: 0x27,
  PRINTER_RESET: 0x28,
  SET_PRINT_MODE: 0x2c,
  SET_VOLUME: 0x2e,
  GET_INFO: 0x40,
  PRINTING_HISTORY: 0x52,
  SOUND_SETTINGS: 0x58,
  GET_PAPER_INFO: 0x59,
  PRINT_TEST_PAGE: 0x5a,
  LABEL_CALIBRATION: 0x8e,
  PRINT_EMPTY_ROW: 0x84,
  PRINT_BITMAP_ROW: 0x85,
  PRINT_STATUS: 0xa3,
  PRINTER_STATUS_DATA: 0xa5,
  GET_CAPABILITIES: 0xaf,
  CONNECT: 0xc1,
  PRINTER_FREE: 0xc3,
  /**
   * Registered, buildable in principle, but never sent and deliberately not in
   * COMMANDS: its documented reply (0xD3) is also the unsolicited row counter,
   * so the exchange could be answered by a status frame. Closing the transport
   * frees the port instead.
   */
  DISCONNECT: 0xd2,
  CANCEL_PRINT: 0xda,
  HEARTBEAT: 0xdc,
  PAGE_END: 0xe3,
  PRINT_END: 0xf3,
  // inbound only
  ERROR: 0xdb,
  NOT_SUPPORTED: 0x00,
});

/**
 * Every opcode this codebase knows about is classified exactly once:
 *   request:    this app builds and sends it (a caller names the command)
 *   unused:     the command is registered and builds, but nothing sends it
 *   inbound:    the firmware sends it unsolicited or as a negative reply
 *   unsupported: known from the protocol family, not implemented on this unit
 */
export const OP_ROLE = Object.freeze({
  PRINT_START: 'request',
  SET_RTC: 'request',
  GET_KEY_FUNCTION: 'unused',
  ANTI_FAKE: 'unused',
  SET_PAGE_SIZE: 'request',
  GET_RFID: 'request',
  SET_DENSITY: 'request',
  SET_PRINT_SPEED: 'unused',
  SET_LABEL_TYPE: 'request',
  SET_LANGUAGE: 'unused',
  SET_AUTO_SHUTDOWN: 'request',
  PRINTER_RESET: 'request',
  SET_PRINT_MODE: 'unused',
  SET_VOLUME: 'unused',
  GET_INFO: 'request',
  PRINTING_HISTORY: 'request',
  SOUND_SETTINGS: 'request',
  GET_PAPER_INFO: 'request',
  PRINT_TEST_PAGE: 'request',
  LABEL_CALIBRATION: 'request',
  PRINT_EMPTY_ROW: 'request',
  PRINT_BITMAP_ROW: 'request',
  PRINT_STATUS: 'request',
  PRINTER_STATUS_DATA: 'request',
  GET_CAPABILITIES: 'request',
  CONNECT: 'request',
  PRINTER_FREE: 'unused',
  DISCONNECT: 'unused',
  CANCEL_PRINT: 'request',
  HEARTBEAT: 'request',
  PAGE_END: 'request',
  PRINT_END: 'request',
  ERROR: 'inbound',
  NOT_SUPPORTED: 'inbound',
  PAGE_START: 'unsupported',
  GET_RFID2: 'unsupported',
  SET_LABEL_MATERIAL: 'unsupported',
  PRINT_BITMAP_ROW_INDEXED: 'unsupported',
  PRINTER_CHECK_LINE: 'unsupported',
  ROW_COUNTER: 'unsupported',
});

/**
 * Opcodes present in the D110 protocol family that this app deliberately does
 * not send. Keeping them here (with a reason) documents the gap without
 * pretending the app supports them.
 */
export const UNSUPPORTED_OPS = Object.freeze({
  PAGE_START: { code: 0x03, reason: 'legacy V1 page flow; the D110M V4 job uses PrintStart + SetPageSize' },
  GET_RFID2: { code: 0x1c, reason: 'second RFID query; the roll tag answers 0x1A' },
  SET_LABEL_MATERIAL: { code: 0x2d, reason: 'material selection is not exposed by this unit' },
  PRINT_BITMAP_ROW_INDEXED: { code: 0x83, reason: 'indexed row variant; the job uses 0x85 and 0x84' },
  PRINTER_CHECK_LINE: { code: 0x86, reason: 'head check line; not used by the print flow' },
  ROW_COUNTER: { code: 0xd3, reason: 'unsolicited row counter; informational frames are ignored, and no command matches 0xD3 replies' },
});

export const INFO_KEYS = Object.freeze({
  density: 0x01,
  speed: 0x02,
  labelType: 0x03,
  headWidth: 0x04,
  accuracy: 0x05,
  language: 0x06,
  autoShutdown: 0x07,
  modelId: 0x08,
  softwareVersion: 0x09,
  battery: 0x0a,
  serial: 0x0b,
  hardwareVersion: 0x0c,
  bluetoothAddress: 0x0d,
  printMode: 0x0e,
  area: 0x0f,
});

export const HEARTBEAT = Object.freeze({ advanced1: 0x01, basic: 0x02, printerInfo: 0x03, advanced2: 0x04 });

/** Items addressed by SOUND_SETTINGS (0x58). */
export const SOUND_ITEMS = Object.freeze({ bluetooth: 0x01, power: 0x02 });

const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 0xff;
const isU16 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff;
/** A field whose default is encoded when it is omitted, but must be valid when given. */
const optional = (isValid) => (value) => value === undefined || isValid(value);

/**
 * @typedef {{op:number, data:(params:object)=>number[], reply:number|((params:object)=>number),
 *            timeout?:number, prefix?:number[], required?:Record<string,(value:unknown)=>boolean>}} CommandDef
 */

/** @type {Record<string, CommandDef>} */
export const COMMANDS = Object.freeze({
  connect: { op: OP.CONNECT, data: () => [0x01], reply: 0xc2, prefix: [0x03] },

  getInfo: { op: OP.GET_INFO, data: (p) => [p.key], reply: (p) => OP.GET_INFO + p.key, required: { key: isByte } },
  heartbeatInfo: { op: OP.HEARTBEAT, data: () => [HEARTBEAT.printerInfo], reply: 0xde },
  heartbeatAdvanced: {
    op: OP.HEARTBEAT,
    data: () => [HEARTBEAT.advanced2],
    reply: 0xd9,
    timeout: CONFIG.protocol.timeouts.identity,
  },
  capabilities: { op: OP.GET_CAPABILITIES, data: () => [0x01], reply: 0xbf },
  statusData: { op: OP.PRINTER_STATUS_DATA, data: () => [0x01], reply: 0xb5 },
  rfid: { op: OP.GET_RFID, data: () => [0x01], reply: 0x1b },
  paperInfo: { op: OP.GET_PAPER_INFO, data: () => [0x01], reply: 0x69 },
  keyFunctions: { op: OP.GET_KEY_FUNCTION, data: () => [0x02, 0x01], reply: 0x0a },
  printHistory: { op: OP.PRINTING_HISTORY, data: () => [0x01], reply: 0x62 },
  antiFake: { op: OP.ANTI_FAKE, data: () => [0x01], reply: 0x0c },

  setDensity: { op: OP.SET_DENSITY, data: (p) => [p.value], reply: 0x31, required: { value: isByte } },
  setSpeed: { op: OP.SET_PRINT_SPEED, data: (p) => [p.value], reply: 0x32, required: { value: isByte } },
  setLabelType: { op: OP.SET_LABEL_TYPE, data: (p) => [p.value], reply: 0x33, required: { value: isByte } },
  setAutoShutdown: { op: OP.SET_AUTO_SHUTDOWN, data: (p) => [p.value], reply: 0x37, required: { value: isByte } },
  setVolume: { op: OP.SET_VOLUME, data: (p) => [p.value], reply: 0x3e, required: { value: isByte } },
  soundSettings: {
    op: OP.SOUND_SETTINGS,
    data: (p) => [p.action ?? 0x02, p.item, p.value],
    reply: 0x68,
    required: { item: isByte, value: isByte },
  },
  setRtc: {
    op: OP.SET_RTC,
    data: (p) => {
      const date = p.date ?? new Date();
      return [0x01, (date.getFullYear() >> 8) & 0xff, date.getFullYear() & 0xff, date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    },
    reply: 0x08,
  },
  cancelPrint: { op: OP.CANCEL_PRINT, data: () => [0x01], reply: 0xd0 },
  setLanguage: { op: OP.SET_LANGUAGE, data: (p) => [p.value], reply: 0x36, required: { value: isByte } },
  setPrintMode: { op: OP.SET_PRINT_MODE, data: (p) => [p.value], reply: 0x3c, required: { value: isByte } },
  reset: { op: OP.PRINTER_RESET, data: () => [0x01], reply: 0x38 },
  calibrate: { op: OP.LABEL_CALIBRATION, data: (p) => [p.value], reply: 0x8f, timeout: 20000, required: { value: isByte } },
  testPage: { op: OP.PRINT_TEST_PAGE, data: () => [0x01], reply: 0x6a, timeout: 20000 },
  printerFree: { op: OP.PRINTER_FREE, data: () => [0x01], reply: 0xc4 },

  printStart: {
    op: OP.PRINT_START,
    data: (p) => [...u16be(p.pages), 0x00, 0x00, 0x00, 0x00, p.pageColor ?? 0x00, p.speed, 0x00],
    reply: 0x02,
    required: { pages: isU16, speed: (value) => value === 0 || value === 1, pageColor: optional(isByte) },
  },
  pageSize: {
    op: OP.SET_PAGE_SIZE,
    data: (p) => [...u16be(p.rows), ...u16be(p.cols), ...u16be(p.copies ?? 1), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    reply: 0x14,
    required: { rows: isU16, cols: isU16, copies: optional(isU16) },
  },
  printStatus: { op: OP.PRINT_STATUS, data: () => [0x01], reply: 0xb3, timeout: CONFIG.protocol.timeouts.status },
  pageEnd: { op: OP.PAGE_END, data: () => [0x01], reply: 0xe4 },
  printEnd: { op: OP.PRINT_END, data: () => [0x01], reply: 0xf4 },
});

function validateParams(name, command, params) {
  if (!command.required) return;
  for (const [key, isValid] of Object.entries(command.required)) {
    if (!isValid(params[key])) throw new RangeError(`${name} requires a valid "${key}" parameter`);
  }
}

function commandFor(name) {
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown command: ${name}`);
  return command;
}

/** Resolve the reply opcode for a command with given params. */
export function replyOpcode(name, params = {}) {
  const command = commandFor(name);
  validateParams(name, command, params);
  return typeof command.reply === 'function' ? command.reply(params) : command.reply;
}

/** Build the bytes for a command. */
export function buildCommand(name, params = {}) {
  const command = commandFor(name);
  validateParams(name, command, params);
  const frame = encodeFrame(command.op, command.data(params));
  if (!command.prefix) return frame;
  const prefixed = new Uint8Array(command.prefix.length + frame.length);
  prefixed.set(command.prefix, 0);
  prefixed.set(frame, command.prefix.length);
  return prefixed;
}

export function commandTimeout(name) {
  return COMMANDS[name]?.timeout ?? CONFIG.protocol.timeouts.control;
}
