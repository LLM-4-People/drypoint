/**
 * Reply decoders. Every field name here comes from the protocol documentation;
 * nothing is guessed at runtime, and unknown payloads stay explicit.
 */

import { CONFIG } from '../core/config.js';
import { modelFor } from './models.js';
import { formatMac } from '../core/format.js';
import { INFO_KEYS } from './commands.js';

const text = (bytes) => new TextDecoder().decode(bytes).replace(/\0+$/, '');

function u16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

/** Battery level steps (0-4) to a percentage, clamped to 0-100. One owner. */
export function batteryPercent(level) {
  if (!Number.isFinite(level)) return null;
  return Math.min(100, Math.max(0, level * 25));
}

/**
 * Decode a payload against a byte-offset field map. Fields whose bytes are not
 * present decode as null; an unknown layout uses an empty map so callers get
 * named raw data instead of invented offsets.
 */
function decodeFields(data, fields) {
  const out = {};
  for (const [name, { offset, size = 1 }] of Object.entries(fields)) {
    if (offset < 0 || offset + size > data.length) {
      out[name] = null;
      continue;
    }
    let value = 0;
    for (let i = 0; i < size; i++) value = (value << 8) | data[offset + i];
    out[name] = value;
  }
  return out;
}

/** Version fields use major + fraction/100 (e.g. 04 17 -> 4.23). */
export function decodeVersion(bytes) {
  if (!bytes || bytes.length < 2) return null;
  return bytes[0] + bytes[1] / 100;
}

/**
 * Model id from a GetInfo 0x08 reply. An empty reply reports no identity at
 * all: `u16([])` would fabricate `0x0000` and the header would show a model
 * the printer never named. The one-byte form is the documented high-byte
 * reply and stays exactly as it is.
 */
export function decodeModelId(data) {
  if (data.length === 0) return { deviceType: null, model: null };
  const id = data.length === 1 ? data[0] << 8 : u16(data, 0);
  const model = modelFor(id);
  return { deviceType: id, model: model.name, modelSupport: model.support, task: model.task };
}

/** `0xDE` byte 6 names a resolution class, not a free-form dpi. */
const DPI_CLASSES = Object.freeze({ 2: 203, 3: 300 });

/** The dpi behind a heartbeat class byte, or null when the class is unknown. */
function dpiForClass(value) {
  return DPI_CLASSES[value] ?? null;
}

export function decodeInfo(key, data) {
  switch (key) {
    case INFO_KEYS.density:
      return { density: data[0] };
    case INFO_KEYS.speed:
      return { speed: data[0] };
    case INFO_KEYS.labelType:
      return { labelType: data[0], labelTypeName: CONFIG.print.labelTypes[data[0]] ?? `Type ${data[0]}` };
    case INFO_KEYS.headWidth:
      // A 16-bit value needs both bytes: a truncated reply is absent, not a
      // shifted guess (one byte 0x60 would otherwise read as 24576 px).
      return { headWidthPx: data.length >= 2 ? u16(data, 0) : null };
    case INFO_KEYS.autoShutdown:
      return { autoShutdown: data[0] };
    case INFO_KEYS.modelId:
      return decodeModelId(data);
    case INFO_KEYS.softwareVersion:
      return { softwareVersion: decodeVersion(data) };
    case INFO_KEYS.hardwareVersion:
      return { hardwareVersion: decodeVersion(data) };
    case INFO_KEYS.battery:
      return { batteryLevel: data[0], batteryPercent: batteryPercent(data[0]) };
    case INFO_KEYS.serial:
      return { serial: data.length >= 8 ? text(data) : [...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    case INFO_KEYS.bluetoothAddress:
      return { bluetoothAddress: formatMac(data.subarray(0, 6)) };
    case INFO_KEYS.printMode:
      return { printMode: data[0] };
    case INFO_KEYS.area:
      // No verified layout for the print-area reply: expose named raw bytes.
      return { area: { length: data.length, raw: [...data] } };
    default:
      return { [`info_${key.toString(16)}`]: [...data] };
  }
}

/** 0xDE: hardware/software version, head geometry and RFID capability. */
export function decodeHeartbeatInfo(data) {
  if (data.length < 10) return { raw: [...data] };
  return {
    hardwareVersion: decodeVersion(data.subarray(0, 2)),
    softwareVersion: decodeVersion(data.subarray(2, 4)),
    headWidthPx: u16(data, 4),
    dpiClass: data[6],
    dpi: dpiForClass(data[6]),
    headAlignment: data[7],
    rfidRead: data[8] === 1,
    rfidWrite: data[9] === 1,
  };
}

/**
 * 0xD9: battery voltage, charge level and sensor flags. A payload shorter than
 * the documented 9 bytes carries no usable sample, so it decodes as `null`
 * instead of an object whose sensor flags would read as "lid open".
 */
export function decodeHeartbeatAdvanced(data) {
  if (data.length < 9) return null;
  return {
    voltageMv: u16(data, 0),
    batteryLevel: data[2],
    batteryPercent: batteryPercent(data[2]),
    temperatureRaw: data[3],
    lidClosed: data[4] === 0,
    paperPresent: data[5] === 0,
    rfidOk: data[6] === 1,
  };
}

/** 0xB5: printer status data, including the protocol version. */
export function decodeStatusData(data) {
  if (data.length < 13) return { raw: [...data] };
  return {
    packetIntervalMs: data[9],
    supportsColor: data[10] === 1,
    protocolVersion: data[11] * 100 + data[12],
  };
}

const CAPABILITY_FIELDS = Object.freeze({
  0x01: 'language',
  0x02: 'printMode',
  0x03: 'uhfRfid',
  0x04: 'dpi',
  0x05: 'rfidSupport',
  0x06: 'batteryRange',
  0x07: 'densityRange',
  0x08: 'speedRange',
  0x09: 'labelTypeMask',
  0x0a: 'headWidthPx',
  0x0b: 'maxPrintHeightPx',
  0x0c: 'labelHeightAndGap',
  0x0d: 'headPosition',
  0x0e: 'volumeSupport',
  0x0f: 'hostStyle',
  0x10: 'printProtocol',
  0x11: 'autoShutdownRange',
  0x12: 'cutterSupport',
  0x13: 'cutterDepthRange',
  0x14: 'printControl',
  0x15: 'pauseTimeSupport',
  0x16: 'paperDetection',
  0x17: 'realTimeClock',
  0x18: 'keyFunctions',
  0x19: 'unknown19',
  0x1a: 'printColor',
  0x1b: 'unknown1b',
  0x1c: 'tubeCalibration',
  0x1d: 'unknown1d',
  0x1e: 'unknown1e',
  0x1f: 'tubeSupport',
  0x20: 'grayBuffer',
});

/**
 * 0xBF: TLV capability list. The app builds its whole feature surface from
 * this reply instead of a model table.
 */
export function decodeCapabilities(data) {
  const fields = {};
  let offset = 0;
  while (offset + 2 <= data.length) {
    const id = data[offset];
    const length = data[offset + 1];
    const value = data.subarray(offset + 2, offset + 2 + length);
    if (value.length < length) break;
    fields[CAPABILITY_FIELDS[id] ?? `unknown${id.toString(16)}`] = [...value];
    offset += 2 + length;
  }

  // A range TLV carries exactly two bytes in (max, min) order. A shorter value
  // or an inverted pair is malformed and decodes as absent, so no caller can
  // clamp against a backwards range.
  const pair = (name) => {
    const value = fields[name];
    if (!value || value.length < 2) return null;
    const [max, min] = value;
    return max >= min ? { max, min } : null;
  };
  /**
   * A boolean TLV carries at least one byte. A zero-length value is malformed,
   * not "false": reporting an unsupported feature the printer never answered is
   * exactly the bug this three-state model exists to prevent.
   */
  const flag = (name) => {
    const value = fields[name];
    return value && value.length >= 1 ? value[0] === 1 : null;
  };
  /** A 16-bit TLV needs both bytes; a truncated value is absent, not a guess. */
  const word = (name) => {
    const value = fields[name];
    return value && value.length >= 2 ? u16(value, 0) : null;
  };
  const mask = fields.labelTypeMask ?? [];
  // The mask is a 32-bit big-endian bitmap where bit 0 (LSB) is label type 1.
  const maskValue = mask.reduce((accumulator, byte) => (accumulator << 8) | byte, 0);
  const labelTypes = [];
  for (let type = 1; type <= 32; type++) {
    if (maskValue & (1 << (type - 1))) labelTypes.push(type);
  }

  return {
    raw: fields,
    dpi: word('dpi'),
    densityRange: pair('densityRange'),
    speedRange: pair('speedRange'),
    batteryRange: pair('batteryRange'),
    autoShutdownRange: pair('autoShutdownRange'),
    labelTypes,
    headWidthPx: word('headWidthPx'),
    maxPrintHeightPx: word('maxPrintHeightPx'),
    // Absent TLVs stay null so the merge can fall through to another source
    // (rfidRead from the heartbeat) instead of treating "unreported" as false.
    hasCutter: flag('cutterSupport'),
    hasRtc: flag('realTimeClock'),
    hasVolume: flag('volumeSupport'),
    rfidRead: flag('rfidSupport'),
    supportsGray: flag('grayBuffer'),
    supportsColor: flag('printColor'),
  };
}

/** 0xB3: print status. Completion is the page counter, never the progress. */
export function decodePrintStatus(data) {
  return {
    pagesPrinted: data.length >= 2 ? u16(data, 0) : 0,
    renderProgress: data[2] ?? 0,
    feedProgress: data[3] ?? 0,
    busy: data[7] === 1,
  };
}

/** 0x1B: roll tag. */
export function decodeRfid(data) {
  if (data.length <= 1) return null;
  let offset = 8;
  if (data.length < offset + 1) return null;
  const barcodeLength = data[offset++];
  const barcode = text(data.subarray(offset, offset + barcodeLength));
  offset += barcodeLength;
  const serialLength = data[offset++] ?? 0;
  const serial = text(data.subarray(offset, offset + serialLength));
  offset += serialLength;
  const total = data.length >= offset + 4 ? u16(data, offset) : null;
  const used = data.length >= offset + 4 ? u16(data, offset + 2) : null;
  const type = data[offset + 4] ?? null;
  return {
    barcode,
    serial,
    total,
    used,
    remaining: total !== null && used !== null ? Math.max(0, total - used) : null,
    type,
    typeName: CONFIG.print.labelTypes[type] ?? (type ? `Type ${type}` : null),
  };
}

/**
 * Field maps for replies whose layout is not in the verified protocol notes.
 * They are intentionally empty: adding a field here is the single place that
 * documents a real offset, and until then the decoder returns the raw bytes.
 */
const PAPER_INFO_FIELDS = Object.freeze({});
const PRINT_HISTORY_FIELDS = Object.freeze({});

/** 0x69: paper info (protocol 4+). Layout unverified; raw bytes are the contract. */
export function decodePaperInfo(data) {
  return {
    opcode: 0x69,
    length: data.length,
    fields: decodeFields(data, PAPER_INFO_FIELDS),
    raw: [...data],
    unverified: true,
  };
}

/** 0x62: print history. Layout unverified; raw bytes are the contract. */
export function decodePrintHistory(data) {
  return {
    opcode: 0x62,
    length: data.length,
    fields: decodeFields(data, PRINT_HISTORY_FIELDS),
    raw: [...data],
    unverified: true,
  };
}

export const REPLY_PARSERS = Object.freeze({
  0xde: decodeHeartbeatInfo,
  0xd9: decodeHeartbeatAdvanced,
  0xb5: decodeStatusData,
  0xbf: decodeCapabilities,
  0xb3: decodePrintStatus,
  0x1b: decodeRfid,
  0x69: decodePaperInfo,
  0x62: decodePrintHistory,
});
