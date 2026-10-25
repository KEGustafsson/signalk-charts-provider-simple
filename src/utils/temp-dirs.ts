/**
 * The work folders downloads and conversions make in the plugin's data dir,
 * and the startup sweep that removes the ones a crash or restart left behind.
 *
 * `start()` runs again on every config save while conversions the previous
 * start began keep running, so a folder still in use is registered here and
 * the sweep leaves it alone. The set lives at module level, which a plugin
 * restart keeps.
 */

import fs from 'fs';
import path from 'path';

const TEMP_DIR_PATTERN =
  /^((s57-download-|rnc-download-|pilot-download-|shp-download-|gshhg-|convert-upload-|custom-catalog-)\d+|convert-local-\w+)$/;

const activeWorkDirs = new Set<string>();

/** Mark `dir` as in use, so the sweep keeps it until {@link releaseWorkDir}. */
export function holdWorkDir(dir: string): void {
  activeWorkDirs.add(path.resolve(dir));
}

export function releaseWorkDir(dir: string): void {
  activeWorkDirs.delete(path.resolve(dir));
}

/**
 * Remove the work folders in `dataDir` that nothing holds. Returns the names
 * removed. A folder that cannot be removed is left for the next start.
 */
export function sweepLeftoverTempDirs(dataDir: string): string[] {
  const removed: string[] = [];
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    const fullPath = path.resolve(dataDir, entry.name);
    if (entry.isDirectory() && TEMP_DIR_PATTERN.test(entry.name) && !activeWorkDirs.has(fullPath)) {
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Locked or vanished: the next start tries again.
      }
    }
  }
  return removed;
}
