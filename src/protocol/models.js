/**
 * Single owner of the printer-model table.
 *
 * The vendor catalogue ids are grouped by the model that answers them. Only
 * the D110M V4 print task exists in this app, so every supported path names
 * that one task; `support` says whether the path has been verified on real
 * hardware, is experimental, or must be blocked before a frame is sent.
 *
 * Keep the `D110` tokens: they are NIIMBOT model names, not this product's
 * name.
 */

/** The print sequences this app can speak. One task exists; it is not a version guess. */
export const PRINT_TASKS = Object.freeze({
  d110mv4: Object.freeze({ id: 'd110mv4', name: 'D110M V4' }),
});

/**
 * Every vendor id the app can name, its real name and whether this app may
 * print to it. This is not the whole vendor catalogue: an id outside the table
 * is `Unknown` and blocked, never guessed from a neighbouring name.
 */
export const MODELS = Object.freeze(
  [
    { code: 0x0900, name: 'D110', support: 'unsupported' },
    { code: 0x0910, name: 'D110_M', support: 'confirmed' },
    { code: 0x0210, name: 'D11_H', support: 'experimental' },
    { code: 0x0200, name: 'D11', support: 'unsupported' },
    { code: 0x0202, name: 'D11S', support: 'unsupported' },
    { code: 0x0213, name: 'D11_Pro', support: 'unsupported' },
    // Vendor-catalogue 12 mm siblings. B18/B18S/H1 have no established print
    // task here; N1's firmware refused the D110M V4 13-byte
    // SetPageSize/PageEnd (0xDB 06) and printed with the b1 task; H1S uses its
    // own task (2-byte PrintStart, 9-byte SetPageSize, PageStart). D101 is
    // reported D110M V4-compatible but its 24 mm head is outside this app's
    // 12 mm scope, so it is a scope refusal, not a protocol failure. None may
    // print until a capture in this repository says otherwise.
    { code: 0x0e00, name: 'B18', support: 'unsupported' },
    { code: 0x0e01, name: 'B18S', support: 'unsupported' },
    { code: 0x0e02, name: 'N1', support: 'unsupported' },
    { code: 0x0f00, name: 'H1', support: 'unsupported' },
    { code: 0x1100, name: 'H1S', support: 'unsupported' },
    { code: 0x0a00, name: 'D101', support: 'unsupported' },
    { code: 0x1000, name: 'B1', support: 'unsupported' },
    { code: 0x1001, name: 'B1 Pro', support: 'unsupported' },
    { code: 0x1002, name: 'B1 SE', support: 'unsupported' },
    { code: 0x1b00, name: 'B2 Pro', support: 'unsupported' },
    { code: 0x1b01, name: 'B2', support: 'unsupported' },
    { code: 0x0300, name: 'B21', support: 'unsupported' },
    { code: 0x0309, name: 'B21S', support: 'unsupported' },
    { code: 0x0311, name: 'B21 Pro', support: 'unsupported' },
    // Vendor ambiguity: this id is reported both as a D110 and as a Hi-D110.
    { code: 0x0901, name: 'D110 / Hi-D110', support: 'unsupported' },
  ].map((entry) => Object.freeze({ ...entry, task: 'd110mv4' }))
);

const BY_CODE = new Map(MODELS.map((entry) => [entry.code, entry]));

/**
 * Resolve one reported id. An absent, non-integer or unknown id is `unknown`,
 * never a made-up model name: the gate and the UI must be able to say so.
 */
export function modelFor(code) {
  const known = Number.isInteger(code) ? BY_CODE.get(code) : undefined;
  if (known) return known;
  return Object.freeze({ code: Number.isInteger(code) ? code : null, name: 'Unknown', support: 'unknown', task: null });
}

/** The support state as the operator reads it. */
export function supportLabel(support) {
  switch (support) {
    case 'confirmed':
      return 'tested';
    case 'experimental':
      return 'experimental';
    case 'unsupported':
      return 'not supported';
    default:
      return 'unknown';
  }
}

/** The behaviour name of a print task; never a protocol-build guess. */
export function taskName(task) {
  return PRINT_TASKS[task]?.name ?? null;
}
