/** Transport registry: one owner for "which transport do we use here". */

import { SerialTransport } from './serial.js';
import { BleTransport } from './ble.js';
import { AndroidTransport } from './android.js';

/**
 * Ordered candidates for a preference. The Android shell has no Web Bluetooth,
 * so its native bridge is preferred wherever it exists; desktop auto keeps
 * serial ahead of BLE.
 */
export function transportCandidates(preference = 'auto') {
  if (preference === 'serial') return [SerialTransport];
  if (preference === 'ble') return [AndroidTransport, BleTransport];
  return AndroidTransport.available()
    ? [AndroidTransport, BleTransport, SerialTransport]
    : SerialTransport.available()
      ? [SerialTransport, BleTransport]
      : [BleTransport, SerialTransport];
}
