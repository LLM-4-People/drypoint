/**
 * The shared PNG decoder for the icon assertions and the generated-icon check.
 *
 * The implementation lives in `scripts/lib/png.mjs` because the build's
 * `--check` must run without a test harness. This module is the test-side import
 * so a suite never keeps a second decoder.
 */
export { decodePng, encodePng, flattenOnto, pixelAt } from '../../scripts/lib/png.mjs';
