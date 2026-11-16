/**
 * The notices every published artifact must carry.
 *
 * The site (`_site`) and the APK (`assets/www`) are two distributions of the
 * same project, so the legal files are declared once here and both builders
 * read this list. A second hand-written copy in either builder is exactly the
 * drift this module exists to prevent.
 *
 * These files are repository files, not app-surface files: they are never
 * precached, never digested into `assets/precache.js` and never served as part
 * of the offline shell. They ride beside the app so a recipient of the APK or
 * the site can read the licence and the third-party notices.
 */

import { resolveSurfacePath } from '../precache.mjs';

/** The files, in the order they are staged. */
export const DISTRIBUTION_FILES = Object.freeze(['LICENSE', 'THIRD_PARTY_NOTICES.md']);

/**
 * Whether a repository-relative path is one of the distribution notices.
 *
 * @param {string} canonical
 * @returns {boolean}
 */
export function isDistributionFile(canonical) {
  return DISTRIBUTION_FILES.includes(canonical);
}

/**
 * Resolve one notice to its real file, through the repository's one symlink
 * rule: the lexical path and the real path must both be under the repository
 * and both be a declared notice.
 *
 * @param {string} file repository-relative notice path
 * @param {{root?: string}} [options]
 * @returns {Promise<{canonical: string, real: string}>}
 */
export function resolveDistributionFile(file, { root } = {}) {
  if (!isDistributionFile(file)) throw new Error(`not a distribution notice: ${file}`);
  return resolveSurfacePath(file, {
    root,
    allowed: (canonical) => isDistributionFile(canonical),
  });
}
