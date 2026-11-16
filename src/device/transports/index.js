/** Transport registry: one owner for "which transport do we use here". */

import { SerialTransport } from './serial.js';
import { BleTransport } from './ble.js';
import { AndroidTransport } from './android.js';

/**
 * Ordered candidates for a preference. The Android shell has no Web Bluetooth,
 * so its native bridge is preferred wherever it exists; desktop auto keeps
 * serial ahead of BLE.
 *
 * A saved web identity moves its matching transport to the front, so an
 * automatic connect tries the printer the operator actually used before any
 * other granted device.
 */
export function transportCandidates(preference = 'auto', preferred = null) {
  let candidates;
  if (preference === 'serial') candidates = [SerialTransport];
  else if (preference === 'ble') candidates = [AndroidTransport, BleTransport];
  else {
    candidates = AndroidTransport.available()
      ? [AndroidTransport, BleTransport, SerialTransport]
      : SerialTransport.available()
        ? [SerialTransport, BleTransport]
        : [BleTransport, SerialTransport];
  }
  if (preferred?.kind === 'ble' && candidates.includes(BleTransport)) {
    return [BleTransport, ...candidates.filter((transport) => transport !== BleTransport)];
  }
  if (preferred?.kind === 'serial' && candidates.includes(SerialTransport)) {
    return [SerialTransport, ...candidates.filter((transport) => transport !== SerialTransport)];
  }
  return candidates;
}
