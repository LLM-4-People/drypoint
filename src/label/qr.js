/**
 * QR wrapper around the vendored generator (MIT, Kazuhiko Arase). One owner for
 * "value → module matrix", used by both the renderer and the editor preview.
 */

export const EC_LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);

/** A QR symbol needs a 4-module quiet zone on every side to scan reliably. */
export const QR_QUIET_MODULES = 4;

/** Below two dots per module the symbol is not readable on a 96-dot head. */
export const QR_MIN_MODULE_PX = 2;

/**
 * Version 40, EC M, byte-mode capacity. The vendored encoder builds the whole
 * payload before it discovers it cannot fit, so a 5 MB value used to cost
 * seconds of blocking and hundreds of megabytes before throwing. The bound is
 * checked from the UTF-8 byte length before the encoder is constructed.
 */
export const QR_MAX_BYTES = 2331;

/**
 * @param {string} value
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {{count:number, isDark:(row:number,col:number)=>boolean}}
 */
export function qrMatrix(value, ecLevel = 'M') {
  if (typeof qrcode !== 'function') throw new Error('QR generator is not loaded');
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text.trim()) throw new Error('QR content is empty');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > QR_MAX_BYTES) {
    throw new Error(`QR content is too long: ${bytes} bytes, the largest symbol holds ${QR_MAX_BYTES}`);
  }
  const level = EC_LEVELS.includes(ecLevel) ? ecLevel : 'M';
  // The vendored default encoder truncates each UTF-16 unit to one byte, which
  // corrupts accented text and emoji. UTF-8 is the one correct byte mapping.
  const utf8 = qrcode.stringToBytesFuncs?.['UTF-8'];
  if (utf8) qrcode.stringToBytes = utf8;
  const qr = qrcode(0, level);
  try {
    qr.addData(text);
    qr.make();
  } catch (error) {
    // The vendor throws plain strings; turn them into a real Error message.
    throw new Error(error?.message ?? String(error));
  }
  const count = qr.getModuleCount();
  return { count, isDark: (row, col) => qr.isDark(row, col) };
}

/**
 * Module geometry for a symbol drawn inside a square box, quiet zone included.
 * @returns {{modulePx:number, quietPx:number, drawnPx:number, fits:boolean}}
 */
export function qrLayout(sizePx, moduleCount) {
  if (!Number.isFinite(sizePx) || sizePx <= 0 || !Number.isFinite(moduleCount) || moduleCount <= 0) {
    return { modulePx: 0, quietPx: 0, drawnPx: 0, fits: false };
  }
  const modulePx = Math.floor(sizePx / (moduleCount + QR_QUIET_MODULES * 2));
  return {
    modulePx,
    quietPx: modulePx * QR_QUIET_MODULES,
    drawnPx: modulePx * moduleCount,
    fits: modulePx >= QR_MIN_MODULE_PX,
  };
}

/** Minimum module size that keeps a QR readable at the given pixel size. */
export function qrFits(value, ecLevel, sizePx) {
  const { count } = qrMatrix(value, ecLevel);
  return qrLayout(sizePx, count).fits;
}
