/**
 * The startup sweep of the work folders downloads and conversions make in
 * the plugin's data dir, for the ones a crash or server restart left behind.
 *
 * `start()` runs again on every config save while downloads and conversions
 * the previous start began keep running in their work folders. Nothing runs
 * before the process's first start, so only then can every matching folder be
 * a leftover: the sweep runs once per data dir per process. A folder whose
 * own cleanup failed during a run is removed at the next server start.
 */

import fs from 'fs';
import path from 'path';

const TEMP_DIR_PATTERN =
  /^((s57-download-|rnc-download-|pilot-download-|shp-download-|gshhg-|convert-upload-|custom-catalog-)\d+|convert-local-\w+)$/;

const sweptDataDirs = new Set<string>();

/**
 * Remove the work folders in `dataDir` on the first call for it in this
 * process; later calls remove nothing. Returns the names removed. A folder
 * that cannot be removed is left for the next server start.
 */
export function sweepLeftoverTempDirs(dataDir: string): string[] {
  const key = path.resolve(dataDir);
  if (sweptDataDirs.has(key)) {
    return [];
  }
  sweptDataDirs.add(key);
  const removed: string[] = [];
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isDirectory() && TEMP_DIR_PATTERN.test(entry.name)) {
      try {
        fs.rmSync(path.join(dataDir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Locked or vanished: the next server start tries again.
      }
    }
  }
  return removed;
}
