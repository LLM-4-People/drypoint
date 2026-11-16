/**
 * Read-only helpers for tests that verify project files rather than runtime
 * modules. Paths are always POSIX-style and relative to the project root.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export function readProjectFile(path) {
  return readFileSync(join(projectRoot, path), 'utf8');
}

/** Every file under `directory`, recursively, sorted for stable assertions. */
export function listProjectFiles(directory) {
  const files = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbsolute, childRelative);
      else files.push(childRelative);
    }
  };
  walk(join(projectRoot, directory), directory);
  return files.sort();
}
