/**
 * Single source of truth for every constant, default and limit in the app.
 * Nothing else may hard-code these values; consumers import CONFIG.
 */

import { BRAND } from './brand.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The user threshold is a percentage; the renderer wants a 0–255 luminance cut.
 * One owner for both representations: `thresholdDefault` is derived from it.
 */
const THRESHOLD = Object.freeze({ min: 5, max: 95, step: 5, default: 55 });

export const CONFIG = deepFreeze({
  app: {
    id: BRAND.slug,
    name: BRAND.name,
    version: '1.0.0',
    storagePrefix: BRAND.storagePrefix,
    documentVersion: 4,
  },

  geometry: {
    /** Fallback pitch used until the printer reports its real dpi. */
    dotsPerMm: 8,
    /** Fallback resolution shown before discovery (8 dots/mm ≈ 203 dpi). */
    dpi: 203,
    widthPx: 96,
    /**
     * A real D110-family head is 96–576 dots. A reported 0 or 65535 is a
     * malformed/hostile reply: it must not become geometry or a raster width,
     * and with no usable report the print gate treats the head as a guess.
     */
    maxHeadWidthPx: 1024,
    minLengthMm: 20,
    maxLengthMm: 200,
    defaultLengthMm: 40,
    paddingPx: 4,
    lineHeight: 1.16,
    autoFontMaxPx: 44,
    autoFontMinPx: 7,
    minFontPx: 8,
    maxFontPx: 72,
    gridMm: 1,
    snapTolerancePx: 5,
    handleSizePx: 18,
    /** Screen travel before a touch drag is a gesture, not the start of a scroll. */
    touchDragStartPx: 8,
    /**
     * Hit radius for a resize handle on a coarse pointer. The handle is still
     * drawn at handleSizePx; a finger simply gets a larger target around it.
     */
    touchHandleRadiusPx: 22,
    minElementPx: 6,
    /** New text boxes occupy this share of the label height, leaving room to align. */
    textBoxHeightRatio: 0.7,
    /**
     * Share of a text box that auto-size keeps free so vertical alignment has
     * real travel. Without it a multi-line block fills the box to within a
     * pixel and Top/Middle/Bottom all paint at the same place.
     */
    alignmentSlackRatio: 0.12,
    /** Grid lines are only drawn when they are at least this far apart on screen. */
    gridMinScreenPx: 6,
    /** Below this caption height a barcode's human-readable text is unreadable. */
    minHriPx: 8,
    /**
     * Code 128 bar height: 6.35 mm (0.25 in) at the printer's 8 dots/mm, and
     * never below 15% of the symbol length (checked separately in the layout
     * pass). 6.35 mm × 8 = 50.8 dots, rounded up to 51.
     */
    minBarcodeHeightPx: 51,
  },

  print: {
    density: { min: 1, max: 5, default: 3 },
    speed: { min: 1, max: 5, default: 1 },
    copies: { min: 1, max: 99, default: 1 },
    defaultLabelType: 1,
    /** Label-type ids the protocol family defines, with their display names. */
    labelTypes: Object.freeze({
      1: 'Gap labels',
      2: 'Black mark',
      3: 'Continuous',
      5: 'Transparent',
    }),
    /** The user-facing threshold is a percentage of full ink. */
    threshold: THRESHOLD,
    /** Internal 0–255 luminance cut derived from the default percentage. */
    thresholdDefault: Math.round((THRESHOLD.default / 100) * 255),
    /**
     * Fixed 0–255 luminance cut for the final 1-bit raster pass. The user
     * threshold only drives image dithering, so small antialiased text is not
     * lost when the user picks a low image threshold.
     */
    rasterCut: 128,
    /** Alpha cut for glyph masks: opaque text becomes solid ink, colour emoji become silhouettes. */
    alphaCut: 128,
  },

  protocol: {
    frameHead: 0x55,
    frameTail: 0xaa,
    timeouts: {
      control: 4000,
      status: 3000,
      completion: 60000,
      identity: 3000,
      /** Whole-discovery deadline: a silent printer must not lock the manager. */
      discovery: 12000,
      /**
       * A link write that never settles leaves the stream state unknown, so it
       * is bounded like any request instead of pinning the caller forever.
       */
      write: 4000,
    },
    pollIntervalMs: 90,
    maxRowRepeat: 200,
    maxEmptyRepeat: 255,
    /**
     * How many requests that left the wire unanswered (timeout or abort after
     * their write was issued) may still answer with a late 0x00. Bounded so a
     * firmware that never answers cannot grow the ledger without limit.
     */
    maxUnansweredReplies: 8,
    /** The length byte is one byte wide, so a payload cannot exceed this. */
    maxPayloadBytes: 255,
  },

  device: {
    battery: {
      /** At or below this charge the manager refuses to start a job. */
      criticalPercent: 15,
    },
    maxRollProfiles: 64,
    /** Labels for the auto power-off steps (GetInfo 0x07 / TLV 0x11). */
    autoShutdownLabels: { 1: 'Shortest', 2: 'Short', 3: 'Long', 4: 'Longest' },
    /**
     * The print gate's operator-facing reasons. One owner: the manager, the
     * print flow and the README quote these, never a second copy of the text.
     */
    printGate: {
      unsupported: 'This app prints 12 mm labels on the NIIMBOT D110 family; no frame was sent.',
      unknownModel: 'Unknown model: the printer did not report a model this app knows; no frame was sent and printing is disabled.',
      guessedGeometry: 'The printer did not report its head width, so the label size is a guess; no frame was sent and printing is disabled.',
      experimental: 'This model is experimental: the D110M V4 sequence is verified on the D110_M, not on this printer.',
    },
  },

  transport: {
    sppService: '00001101-0000-1000-8000-00805f9b34fb',
    bleService: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    bleCharacteristic: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    bleNamePrefixes: ['D110', 'NIIMBOT', 'B1', 'B21'],
    bleWritePacingMs: 12,
    /**
     * A transport open() that never settles (a GATT connect that stalls, a port
     * the OS holds) must not pin the manager: the attempt is bounded and its
     * half-open instance is disposed.
     */
    openTimeoutMs: 15000,
    /** A native bridge call (scan, connect) that never answers must not hang. */
    androidCallTimeoutMs: 15000,
    /**
     * The interactive picker includes an 8 s scan and then waits for a human:
     * the short call timeout would reject while the dialog is still open.
     */
    androidPickerTimeoutMs: 120000,
    /** A transport close() that never settles must not wedge every later attempt. */
    closeTimeoutMs: 3000,
    serialBaudRate: 9600,
    serialBufferSize: 8192,
  },

  ui: {
    toastMs: 3800,
    statusHoldMs: 4500,
    debounceMs: 120,
    previewMinScale: 0.2,
    compactBreakpointPx: 900,
    wheelZoomStep: 0.0015,
    /** Canvas zoom limits; one owner for the buttons, wheel and fit action. */
    zoom: Object.freeze({ min: 0.5, max: 6, step: 0.2, fitMin: 0.8, fitMax: 4, default: 2 }),
  },

  log: {
    level: 'info',
    bufferSize: 1000,
    maxBytesShown: 64,
    console: true,
    /** Detail keys whose values are replaced before anything is logged. */
    redactKeys: [
      'password',
      'passphrase',
      'secret',
      'token',
      'authorization',
      'apiKey',
      'accessToken',
      'privateKey',
      'credential',
      'cookie',
    ],
  },

  history: {
    maxEntries: 80,
  },

  /**
   * One input-boundary policy. These are the caps every trust boundary (stored
   * label, import, inspector) applies to a document; they are not physical
   * printer limits and never change what a valid label can contain.
   */
  bounds: {
    maxElements: 200,
    maxTextChars: 2000,
    maxValueChars: 2000,
    maxNameChars: 120,
    /** An image data URL longer than this is dropped, never truncated. */
    maxSrcChars: 4_000_000,
    maxNotices: 50,
    maxNoticeChars: 300,
    /** Layout warnings collected before one "… and N more" line. */
    maxWarnings: 20,
    /** Element names are truncated to this many characters in a warning. */
    warningNameChars: 40,
  },

  image: {
    /** Decoded bitmaps retained before the least recently used source is evicted. */
    cacheLimit: 16,
  },

  diagnostics: {
    /** Entries exported by the diagnostics report and shown in the log viewer. */
    maxEntriesInReport: 2000,
  },

  offline: {
    /**
     * A network-first navigation waits at most this long before the cached
     * shell answers. A phone whose network drops the SYN (a sleeping host)
     * would otherwise keep the navigation pending for many seconds.
     */
    navigationTimeoutMs: 3000,
  },
});

/** Storage key helper so every persisted key shares one prefix. */
export function storageKey(name) {
  return `${CONFIG.app.storagePrefix}.${name}`;
}
