/** Shared formatting and small pure helpers. No DOM, no state. */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** One decimal place. Shared by the inspector fields and the stage footer. */
export function round1(value) {
  return Math.round(value * 10) / 10;
}

export function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** Colon-separated Bluetooth/MAC address, built on the one hex formatter. */
export function formatMac(bytes) {
  return toHex(bytes).replaceAll(' ', ':');
}

/** Await one timer tick. Shared by write pacing and job polling. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fromHex(hex) {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((byte) => parseInt(byte, 16))
  );
}

export function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function deepClone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

/** Stable-ish unique id for document elements and jobs. */
export function createId(prefix = 'id') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
