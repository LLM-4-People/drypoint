/**
 * Single source of truth for every constant, default and limit in the app.
 * Nothing else may hard-code these values; consumers import CONFIG.
 */

import { BRAND } from './brand.js';
import { APP_VERSION } from './version.js';

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

/**
 * One image-source cap, and the file size that can still fit inside it after
 * base64 expansion (4 chars per 3 bytes) plus the `data:<type>;base64,` prefix.
 * A file is refused at `file.size` before it is read, so an over-size pick
 * never becomes a 67 MB string or a full bitmap.
 */
const MAX_SRC_CHARS = 4_000_000;
const DATA_URL_PREFIX_CHARS = 128;
const MAX_IMAGE_FILE_BYTES = Math.floor(((MAX_SRC_CHARS - DATA_URL_PREFIX_CHARS) * 3) / 4);
/**
 * One decode-cache size. Together with `MAX_SRC_CHARS` it also sizes the
 * document's image-text budget, so storage and transfer share one derivation.
 */
const IMAGE_CACHE_LIMIT = 16;
/**
 * Room for the transfer envelope, element metadata and notices around the
 * image sources themselves. JSON escaping can expand one bounded text field up
 * to six characters per input character; 200 elements plus the notice list stay
 * inside 4 MiB, so the document's JSON cannot exceed the source budget plus this
 * overhead. The importer therefore never rejects the app's own export.
 */
const TRANSFER_OVERHEAD_BYTES = 4 * 1024 * 1024;
/**
 * The image text one label may carry. Serialised documents repeat an image
 * source once per element, so the distinct-source cache limit alone does not
 * bound the file: a label that reuses one large source still grows with every
 * copy.
 *
 * This is an authoring budget, not a normalise rule. `label/images.js`
 * (`sourceBudgetProblem`) enforces it where an image enters the label (editor
 * add/update/duplicate) and where the label crosses a file boundary (import,
 * export). Validation preserves an over-budget document intact: it runs on
 * every undo, geometry change and print, so rewriting there would silently
 * destroy a label that already exists.
 */
const MAX_SOURCE_CHARS = IMAGE_CACHE_LIMIT * MAX_SRC_CHARS;

export const CONFIG = deepFreeze({
  app: {
    id: BRAND.slug,
    name: BRAND.name,
    version: APP_VERSION,
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
    /**
     * A reported resolution above this is hostile or misparsed. It becomes
     * absent instead of a pitch: 65535 dpi would otherwise turn a 200 mm label
     * into a 516k-row raster and a huge canvas allocation.
     */
    maxDpi: 600,
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
      // Both facts make a label width real: the head width and the dots per mm
      // that turn millimetres into dots. The gate picks the message for the
      // fact the printer actually withheld; this one is the both-missing case.
      guessedGeometry: 'The printer did not report enough geometry to size the label (a head width and a usable resolution), so the label size is a guess; no frame was sent and printing is disabled.',
      missingHeadWidth: 'The printer did not report its head width, so the label size is a guess; no frame was sent and printing is disabled.',
      missingResolution: 'The printer did not report a usable resolution, so the label size is a guess; no frame was sent and printing is disabled.',
      experimental: 'This model is experimental: the D110M V4 sequence is verified on the D110_M, not on this printer.',
    },
  },

  transport: {
    sppService: '00001101-0000-1000-8000-00805f9b34fb',
    bleService: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    bleCharacteristic: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    /**
     * The discovery filter, not a support claim: a device whose name starts
     * with one of these is offered to the picker and then identified by its
     * reported id, which the model gate alone judges. B1 covers B18/B18S and
     * B2 covers B2/B21, so the catalogue names are not repeated as prefixes.
     */
    bleNamePrefixes: ['D110', 'D11', 'B1', 'B2', 'B21', 'N1', 'H1', 'D101', 'NIIMBOT'],
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
    zoom: Object.freeze({ min: 0.5, max: 6, step: 0.2, fitMax: 4, default: 2 }),
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
    /**
     * Retained snapshot budget. Snapshots hold whole documents, and an image
     * data URL can be most of a snapshot, so the entry count alone is not a
     * memory bound: 80 copies of one 3.8 MB image is ~290 MiB.
     */
    maxBytes: 32 * 1024 * 1024,
  },

  /**
   * One input-boundary policy. These are the caps every trust boundary (stored
   * label, import, inspector) applies to one document. They bound memory and
   * file size, not the printer: the full tape is still available to a label.
   */
  bounds: {
    maxElements: 200,
    maxTextChars: 2000,
    maxValueChars: 2000,
    maxNameChars: 120,
    /**
     * Element ids are internal and appear in DOM attributes, so they are capped
     * with the other strings. An unbounded accepted id used to make an accepted
     * import export a file the importer refuses.
     */
    maxIdChars: 120,
    /** An image data URL longer than this is dropped, never truncated. */
    maxSrcChars: MAX_SRC_CHARS,
    /** Total image-source text one document may carry; see MAX_SOURCE_CHARS. */
    maxSourceChars: MAX_SOURCE_CHARS,
    maxNotices: 50,
    maxNoticeChars: 300,
    /** Layout warnings collected before one "… and N more" line. */
    maxWarnings: 20,
    /** Element names are truncated to this many characters in a warning. */
    warningNameChars: 40,
  },

  image: {
    /** Decoded bitmaps retained before the least recently used source is evicted. */
    cacheLimit: IMAGE_CACHE_LIMIT,
    /** An image file larger than this cannot fit `bounds.maxSrcChars` as a data URL. */
    maxFileBytes: MAX_IMAGE_FILE_BYTES,
  },

  /**
   * Document transfer bounds derive from the same owners as storage: every
   * valid label carries at most `bounds.maxSourceChars` of image text, plus the
   * envelope and element metadata, so an exported label always imports.
   */
  document: {
    transfer: {
      maxBytes: MAX_SOURCE_CHARS + TRANSFER_OVERHEAD_BYTES,
    },
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
    /**
     * A first install can lose one request to a transient network failure.
     * Only a network-level failure (a rejected fetch or body read) is retried;
     * an HTTP non-200 or a validation problem fails the install immediately.
     */
    installRetries: 2,
    installRetryDelayMs: 250,
  },
});

/** Storage key helper so every persisted key shares one prefix. */
export function storageKey(name) {
  return `${CONFIG.app.storagePrefix}.${name}`;
}
