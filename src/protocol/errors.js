/** Protocol error types and the printer's 0xDB error code table. */

export class PrinterError extends Error {
  /**
   * @param {string} message
   * @param {{code?:number, fatal?:boolean, unsupported?:boolean, timeout?:boolean,
   *          cancelled?:boolean, cause?:unknown}} [options]
   */
  constructor(message, { code = 0, fatal = false, unsupported = false, timeout = false, cancelled = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PrinterError';
    this.code = code;
    this.fatal = fatal;
    this.unsupported = unsupported;
    this.timeout = timeout;
    this.cancelled = cancelled;
  }
}

/**
 * Codes reported inside a 0xDB frame, from the protocol's PrinterErrorCode
 * enum. Unknown codes stay descriptive rather than being mapped to a guess.
 */
const ERROR_CODES = Object.freeze({
  0x01: 'Cover open',
  0x02: 'Out of paper',
  0x03: 'Low battery',
  0x04: 'Battery error',
  0x05: 'Cancelled by user',
  0x06: 'Data error',
  0x07: 'Overheating',
  0x08: 'Paper out',
  0x09: 'Printer busy',
  0x0a: 'Print head missing',
  0x0b: 'Temperature too low',
  0x0c: 'Print head loose',
  0x0d: 'No ribbon',
  0x0e: 'Wrong ribbon',
  0x0f: 'Ribbon already used',
  0x10: 'Wrong paper',
  0x11: 'Tape type rejected',
  0x12: 'Print mode rejected',
  0x13: 'Density rejected',
  0x14: 'RFID write failed',
  0x15: 'Margin rejected',
  0x16: 'Communication error',
  0x17: 'Disconnected',
  0x18: 'Canvas parameter error',
  0x19: 'Rotation parameter error',
  0x1a: 'Template parameter error',
  0x1b: 'Abnormal paper output',
  0x1c: 'Paper check required',
  0x1d: 'RFID tag not written',
  0x1e: 'Density not supported',
  0x1f: 'Print mode not supported',
  0x20: 'Label material error',
  0x21: 'Label material not supported',
  0x22: 'RFID writing not supported',
  0x32: 'Illegal page',
  0x33: 'Illegal ribbon page',
  0x34: 'Receive data timeout',
  0x35: 'Non-dedicated ribbon',
});

export function describeErrorCode(code) {
  return ERROR_CODES[code] ?? `Printer error 0x${code.toString(16).padStart(2, '0')}`;
}

/** The one "the operator asked for this" error: every layer reports it the same way. */
function cancelledError(message = 'Print cancelled') {
  return new PrinterError(message, { cancelled: true, fatal: true });
}

/**
 * The reason an aborted signal carries. A printer error aborts the operation
 * that owns the link, and that error — not a generic cancel — is what the
 * caller must see, so the one flow reports one cause. Any other reason keeps
 * the shared "cancelled" outcome.
 */
export function abortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof PrinterError ? reason : cancelledError();
}
