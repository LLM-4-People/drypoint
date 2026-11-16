/**
 * Single owner of the label coordinate system. Documents are authored in
 * printer dots; the dot pitch and head width come from the device when it
 * reports them and fall back to CONFIG.geometry otherwise. Nothing else may
 * convert millimetres to dots or assume a head width.
 */

import { CONFIG } from './config.js';

const MM_PER_INCH = 25.4;

/**
 * A reported resolution this app can use, or null.
 *
 * One owner for the bound: a report of 65535 dpi would otherwise become
 * 2580 dots/mm and a 516k-row raster. The capability merge, the geometry owner
 * and every pitch conversion read this answer, so no path can keep a hostile
 * value in a second place.
 *
 * @returns {number|null}
 */
export function usableDpi(dpi) {
  return Number.isFinite(dpi) && dpi > 0 && dpi <= CONFIG.geometry.maxDpi ? dpi : null;
}

/**
 * Dot pitch. A reported resolution is the authority: a 300-dpi class is
 * 300/25.4 = 11.81 dots/mm, not the 12 dots/mm its 144-dot head over the tape
 * would suggest. Without a usable dpi the configured 8 dots/mm is the fallback.
 *
 * The configured maximum is enforced here, at the one conversion every geometry
 * path uses, not only in the capability merge: a direct setGeometry({dpi:
 * 65535}) would otherwise become 2580 dots/mm and a 516k-row raster.
 */
export function pitchFor({ dpi } = {}) {
  const usable = usableDpi(dpi);
  return usable ? usable / MM_PER_INCH : CONFIG.geometry.dotsPerMm;
}

function defaults() {
  const { dotsPerMm, widthPx, dpi, maxLengthMm } = CONFIG.geometry;
  return {
    dpi,
    dotsPerMm,
    widthPx,
    widthMm: widthPx / dotsPerMm,
    maxLengthMm,
    reported: false,
  };
}

/**
 * The usable maximum document length for a reported value.
 *
 * A reported maximum below the shortest label the app can author is not a tape
 * it can print on: null tells the caller to keep the prior/default instead of
 * building a document that validation must immediately stretch. The app's own
 * maximum is the other bound, so both consumers clamp identically.
 * @returns {number|null}
 */
export function maxLengthFor(reportedMm) {
  if (!Number.isFinite(reportedMm) || reportedMm < CONFIG.geometry.minLengthMm) return null;
  return Math.min(reportedMm, CONFIG.geometry.maxLengthMm);
}

/**
 * Resolve the coordinate system for a capability model.
 * @param {object|null} capabilities merged capabilities (see device/capabilities.js)
 */
function resolveGeometry(capabilities) {
  const base = defaults();
  if (!capabilities?.discovered) return base;
  const widthPx =
    Number.isFinite(capabilities.headWidthPx) &&
    capabilities.headWidthPx > 0 &&
    capabilities.headWidthPx <= CONFIG.geometry.maxHeadWidthPx
      ? capabilities.headWidthPx
      : base.widthPx;
  // The dpi is a reported fact or nothing. Copying the raw value kept 65535
  // dpi on screen and in a raster calculation whenever a caller set geometry
  // directly; the pitch owner already refuses it, so the display must agree.
  const dpi = usableDpi(capabilities.dpi);
  const dotsPerMm = pitchFor({ dpi });
  const maxLengthMm = maxLengthFor(capabilities.maxLengthMm) ?? base.maxLengthMm;
  return {
    dpi,
    dotsPerMm,
    widthPx,
    widthMm: widthPx / dotsPerMm,
    maxLengthMm,
    /**
     * True only when the merge says the head geometry itself came from the
     * printer. `headWidthPx` is never null (it falls back to the configured
     * width), so its finiteness cannot tell a reported value from a guess.
     */
    reported: capabilities.source?.geometry === 'reported',
  };
}

let active = defaults();

/** Apply the geometry of a freshly discovered printer. */
export function setGeometry(capabilities) {
  active = resolveGeometry(capabilities);
  return active;
}

/** Restore the configured fallback geometry (boot, tests, no device). */
export function resetGeometry() {
  active = defaults();
  return active;
}

export function geometry() {
  return active;
}

export function mmToPx(mm) {
  return Math.round(Number(mm) * active.dotsPerMm);
}

export function pxToMm(px) {
  return Number(px) / active.dotsPerMm;
}
