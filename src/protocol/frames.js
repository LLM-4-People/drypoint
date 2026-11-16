/**
 * NIIMBOT frame codec: `55 55 <cmd> <len> <data…> <crc> AA AA`,
 * crc = XOR(cmd, len, every data byte). Pure functions, no I/O.
 */

import { CONFIG } from '../core/config.js';
import { concatBytes } from '../core/format.js';

export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) crc ^= byte;
  return crc;
}

/**
 * Split a 16-bit payload value into its two big-endian bytes. Encoding only:
 * the reply decoder in `replies.js` reads at an offset instead.
 */
export function u16be(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

export function encodeFrame(cmd, data = []) {
  const bytes = Array.from(data);
  // The lowest choke point for every payload byte: Uint8Array.from would wrap
  // 300 to 0x2c and -1 to 0xff, silently changing the command on the wire.
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`Frame payload byte ${index} is ${value}; payload elements must be integers 0-255`);
    }
  }
  const payload = Uint8Array.from(bytes);
  if (payload.length > CONFIG.protocol.maxPayloadBytes) {
    throw new RangeError(`Frame payload is ${payload.length} bytes; the protocol limit is ${CONFIG.protocol.maxPayloadBytes}`);
  }
  const frame = new Uint8Array(payload.length + 7);
  frame[0] = CONFIG.protocol.frameHead;
  frame[1] = CONFIG.protocol.frameHead;
  frame[2] = cmd;
  frame[3] = payload.length;
  frame.set(payload, 4);
  frame[4 + payload.length] = crc8([cmd, payload.length, ...payload]);
  frame[5 + payload.length] = CONFIG.protocol.frameTail;
  frame[6 + payload.length] = CONFIG.protocol.frameTail;
  return frame;
}

/**
 * True when a complete, checksum-valid frame starts at `index`.
 *
 * The one validity predicate: the push loop and the resynchronisation scan
 * must agree, or a frame the scan trusts is dropped by the loop (or worse, a
 * corrupted frame is delivered because only one path checked the CRC).
 *
 * @param {Uint8Array} buffer
 * @param {number} index offset of the candidate frame head
 */
export function frameIsValid(buffer, index) {
  const { frameHead, frameTail } = CONFIG.protocol;
  if (!buffer || index < 0 || index + 7 > buffer.length) return false;
  if (buffer[index] !== frameHead || buffer[index + 1] !== frameHead) return false;
  const length = buffer[index + 3];
  if (index + length + 7 > buffer.length) return false;
  const cmd = buffer[index + 2];
  const data = buffer.subarray(index + 4, index + 4 + length);
  return (
    buffer[index + 4 + length] === crc8([cmd, length, ...data]) &&
    buffer[index + 5 + length] === frameTail &&
    buffer[index + 6 + length] === frameTail
  );
}

/**
 * Incremental parser. Transports deliver arbitrary fragments, so bytes are
 * buffered until a complete, checksum-valid frame is available. Bad frames are
 * skipped one byte at a time to resynchronise.
 */
export class FrameReader {
  #buffer = new Uint8Array(0);
  #dropped = 0;

  get dropped() {
    return this.#dropped;
  }

  reset() {
    this.#buffer = new Uint8Array(0);
    this.#dropped = 0;
  }

  #isHead(index) {
    return this.#buffer[index] === CONFIG.protocol.frameHead && this.#buffer[index + 1] === CONFIG.protocol.frameHead;
  }

  /** Index of the next frame head at or after `from`, or -1. */
  #findHead(from = 0) {
    for (let i = from; i + 1 < this.#buffer.length; i++) {
      if (this.#isHead(i)) return i;
    }
    return -1;
  }

  /** Index of the next complete, valid frame at or after `from`, or -1.
   * Used to escape a candidate whose length byte was corrupted.
   */
  #findCompleteFrame(from) {
    let index = this.#findHead(from);
    while (index >= 0) {
      if (frameIsValid(this.#buffer, index)) return index;
      index = this.#findHead(index + 1);
    }
    return -1;
  }

  /** @returns {Array<{cmd:number, data:Uint8Array}>} */
  push(chunk) {
    if (!chunk?.length) return [];
    this.#buffer = concatBytes(this.#buffer, chunk);
    const frames = [];
    const { frameHead } = CONFIG.protocol;

    for (;;) {
      const start = this.#findHead();
      if (start < 0) {
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 1));
        return frames;
      }
      if (start > 0) {
        this.#dropped += start;
        this.#buffer = this.#buffer.subarray(start);
      }
      if (this.#buffer.length < 7) return frames;

      const length = this.#buffer[3];
      const total = length + 7;
      if (this.#buffer.length < total) {
        // Incomplete candidate. A corrupted length byte must not stall the
        // stream: if a complete, valid frame already follows, skip to it.
        const next = this.#findCompleteFrame(1);
        if (next < 0) return frames;
        this.#dropped += next;
        this.#buffer = this.#buffer.subarray(next);
        continue;
      }

      const cmd = this.#buffer[2];
      const data = this.#buffer.slice(4, 4 + length);
      const valid = frameIsValid(this.#buffer, 0);

      if (!valid) {
        this.#dropped += 1;
        this.#buffer = this.#buffer.subarray(1);
        continue;
      }

      frames.push({ cmd, data });
      this.#buffer = this.#buffer.subarray(total);
    }
  }
}
