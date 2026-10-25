/**
 * The files an S-57 GDAL export leaves beside its GeoJSON, shared by both
 * toolchains (conversion-backend.ts) and the chart-set cache.
 */

import fs from 'fs';
import path from 'path';

/**
 * Prefix of the empty file the export writes for each cell it exported
 * without an error, when asked to (per-cell exports for the chart-set cache).
 */
export const COMPLETE_MARKER_PREFIX = '.complete-';

// Per-cell GDAL errors are collected here, beside the GeoJSON. Without it, a
// "the export ran but produced nothing" outcome is indistinguishable from
// "every chart failed for the same reason". Surfaced into the user-visible
// conversion log when no usable output lands.
export const EXPORT_ERROR_FILE_BASENAME = '.export-errors.log';
const EXPORT_ERROR_SAMPLE_LINES = 10;

// S-57 records that are not chart features: the dataset header, the
// aggregation/association collections, and GDAL's catch-all layer.
export const SKIP_LAYERS = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];

/**
 * Size of a GeoJSON export file's content: an empty FeatureCollection is
 * ~100 bytes. A gzip file records its uncompressed size (modulo 2^32) in its
 * last four bytes, which is enough to tell.
 */
export function geojsonContentSize(file: string): number {
  if (!file.endsWith('.gz')) {
    return fs.statSync(file).size;
  }
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    if (size < 4) {
      return 0;
    }
    const tail = Buffer.alloc(4);
    fs.readSync(handle, tail, 0, 4, size - 4);
    return tail.readUInt32LE(0);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * The lines to log when an export produced no usable GeoJSON: a sample of
 * what GDAL reported, so the user sees the actual error instead of just the
 * downstream "No valid GeoJSON layers" message. Empty when usable output
 * landed. `noErrorsHint` is said when GDAL reported nothing either.
 */
export function exportErrorReport(geojsonDir: string, noErrorsHint: string): string[] {
  try {
    for (const f of fs.readdirSync(geojsonDir)) {
      if (f.endsWith('.geojson') && fs.statSync(path.join(geojsonDir, f)).size > 100) {
        return [];
      }
    }
  } catch {
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(geojsonDir, EXPORT_ERROR_FILE_BASENAME), 'utf8');
  } catch {
    return [
      `GDAL export produced no usable layers and no per-file errors were captured. ${noErrorsHint}`
    ];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return ['GDAL export produced no usable layers and the captured error log was empty.'];
  }
  const report = [
    `GDAL export ran but produced no usable GeoJSON layers. First ${Math.min(EXPORT_ERROR_SAMPLE_LINES, lines.length)} of ${lines.length} captured GDAL error line(s):`,
    ...lines.slice(0, EXPORT_ERROR_SAMPLE_LINES).map((line) => `  ${line}`)
  ];
  if (lines.length > EXPORT_ERROR_SAMPLE_LINES) {
    report.push(`  ... ${lines.length - EXPORT_ERROR_SAMPLE_LINES} more error line(s) suppressed.`);
  }
  return report;
}

// An S-57 update file: the cell's name with a three-digit extension past 000.
const UPDATE_EXTENSION = /^\.\d{3}$/;

/**
 * The files GDAL reads for a cell: its `.000` and the update files beside it
 * (`.001`, `.002`, …), which the S-57 driver applies when it opens the cell.
 */
export function cellFiles(cell: string): string[] {
  const dir = path.dirname(cell);
  const stem = path.basename(cell, path.extname(cell));
  const files = [cell];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const ext = path.extname(name);
    if (
      path.basename(name, ext) === stem &&
      UPDATE_EXTENSION.test(ext) &&
      ext !== '.000' &&
      fs.statSync(path.join(dir, name)).isFile()
    ) {
      files.push(path.join(dir, name));
    }
  }
  return files;
}
