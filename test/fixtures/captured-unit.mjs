/**
 * Identities for the protocol fixtures.
 *
 * The reference unit's real serial number is not published: a device serial is
 * an identifier, and this repository is public. The tests below use these
 * clearly synthetic values instead, so a reader can tell fixture data from a
 * captured frame at a glance. `test/privacy.test.mjs` proves the real serial
 * appears nowhere in the tree.
 *
 * The roll barcode is a product EAN on retail label stock, not a device
 * identity, so the captured value is real and stays.
 */

/** Synthetic serial for the reference unit. Ten ASCII characters, like the real reply. */
export const FIXTURE_SERIAL = 'TEST000001';

/** Synthetic RFID tag serial. Sixteen ASCII characters, like the real reply. */
export const FIXTURE_ROLL_SERIAL = 'TESTROLL00000001';

/**
 * Synthetic Bluetooth address for the reference unit's diagnostic reply.
 * Locally administered, so it cannot name a real vendor device.
 */
export const FIXTURE_BLUETOOTH_ADDRESS = '02:00:00:00:00:01';
export const FIXTURE_BLUETOOTH_BYTES = Object.freeze([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

/** Retail roll EAN: a product code, not an identity. */
export const ROLL_BARCODE = '6977031214406';

/** The roll tag the fixtures decode: 192 labels, 75 used. */
export const ROLL_TOTAL = 192;
export const ROLL_USED = 75;

/** ASCII bytes of a serial, as a `GetInfo` reply carries them. */
export function serialBytes(serial = FIXTURE_SERIAL) {
  return [...serial].map((character) => character.charCodeAt(0));
}

/**
 * Build a `0x1B` roll-tag payload: eight header bytes, then the length-prefixed
 * barcode and tag serial, then total, used and label type.
 *
 * @param {{barcode?: string, serial?: string, total?: number, used?: number, type?: number}} [options]
 * @returns {Uint8Array}
 */
export function rollTagBytes({
  barcode = ROLL_BARCODE,
  serial = FIXTURE_ROLL_SERIAL,
  total = ROLL_TOTAL,
  used = ROLL_USED,
  type = 1,
} = {}) {
  const ascii = (value) => [...value].map((character) => character.charCodeAt(0));
  const bytes = [0x88, 0x1d, 0xd2, 0xf9, 0xe2, 0x8c, 0x00, 0x00];
  bytes.push(barcode.length, ...ascii(barcode));
  bytes.push(serial.length, ...ascii(serial));
  bytes.push((total >> 8) & 0xff, total & 0xff, (used >> 8) & 0xff, used & 0xff, type);
  return Uint8Array.from(bytes);
}
