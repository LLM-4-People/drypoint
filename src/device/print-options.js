/**
 * Resolves the settings that go into a print job. One owner for clamping and
 * for mapping UI values onto protocol values.
 */

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/format.js';
import { clampToRange } from './capabilities.js';

/** PrintStart[7]: 0 = quality, 1 = normal (the official app sends 1). */
export const JOB_SPEED = Object.freeze({ quality: 0, normal: 1 });

export function resolvePrintOptions({ settings, capabilities, copies }) {
  const requestedDensity = Number(settings['print.density']);
  const density = Math.round(
    clampToRange(
      Number.isFinite(requestedDensity) ? requestedDensity : CONFIG.print.density.default,
      capabilities?.densityRange,
      CONFIG.print.density.default
    )
  );
  const supportedTypes = capabilities?.labelTypes?.length ? capabilities.labelTypes : null;
  const requestedType = Number(settings['print.labelType']) || CONFIG.print.defaultLabelType;
  const labelType = supportedTypes && !supportedTypes.includes(requestedType) ? supportedTypes[0] : requestedType;
  const speed = JOB_SPEED[settings['print.speed']] ?? JOB_SPEED.normal;
  const count = clamp(Math.round(Number(copies) || 1), CONFIG.print.copies.min, CONFIG.print.copies.max);

  return { density, labelType, speed, copies: count };
}

export function resolveRenderOptions(settings) {
  const { min, max, default: fallback } = CONFIG.print.threshold;
  const percent = Number(settings['print.threshold']);
  const clamped = Number.isFinite(percent) ? Math.min(max, Math.max(min, percent)) : fallback;
  return {
    dither: settings['print.dither'],
    threshold: Math.round((clamped / 100) * 255),
  };
}
