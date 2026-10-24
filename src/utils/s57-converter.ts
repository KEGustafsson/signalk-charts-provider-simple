import fs from 'fs';
import https from 'https';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import unzipper from 'unzipper';
import type {
  ConversionProgress,
  ConversionProgressMap,
  DebugFunction,
  S57BucketProgress,
  S57ConversionOptions,
  S57ConversionResult,
  StatusCallback
} from '../types.js';
import { sanitizeChartFilename } from './catalog-title.js';
import { getCpuBudget } from './concurrency.js';
import { MAX_CONVERSION_LOG_LINES } from './conversion-log.js';
import { setConversionResult } from './conversion-progress.js';
import { patchS57Mbtiles, setMbtilesDisplayName } from './mbtiles-metadata.js';
import { addRasterOverviews } from './raster-pyramid.js';
import { BAND_MAX_ZOOM, BAND_MIN_ZOOM, detectEncBand, exportFileParts } from './s57-band.js';
import { extractTarArchive } from './tar-extract.js';
import { buildVectorMbtiles, type TileSource } from './vector-tiler.js';
import {
  PoolAbortedError,
  TaskFailedError,
  forEachConcurrent,
  withWorkerPool,
  type WorkerPool
} from './worker-pool.js';

// Message thrown when an in-progress conversion is cancelled — at a stage
// boundary (isAborted) or mid-stage, when the abort signal terminates the
// conversion's worker threads. Callers (the Custom Catalogs flow) detect
// cancellation via their own flag, so this is just a recognizable stop signal.
export const CONVERSION_ABORTED_MESSAGE = 'Conversion cancelled';

// A cancelled pool rejects its tasks with PoolAbortedError; surface that as
// the one cancellation message callers know.
function asCancellation(err: unknown): unknown {
  return err instanceof PoolAbortedError ? new Error(CONVERSION_ABORTED_MESSAGE) : err;
}

const conversionProgress: ConversionProgressMap = {};
const MAX_LOG_LINES = MAX_CONVERSION_LOG_LINES;

let debug: DebugFunction = () => {};

export function initS57Converter(debugFn: DebugFunction): void {
  debug = debugFn || (() => {});
}

export function getConversionProgress(chartNumber: string): ConversionProgress | null {
  return conversionProgress[chartNumber] ?? null;
}

export function getAllConversionProgress(): ConversionProgressMap {
  return { ...conversionProgress };
}

export function setConversionFailed(chartNumber: string, message: string): void {
  setConversionResult(conversionProgress, chartNumber, 'failed', message);
}

/** Forget a conversion's progress and log, once its caller has kept what it needs. */
export function clearConversionProgress(chartNumber: string): void {
  delete conversionProgress[chartNumber];
}

export function setConversionCompleted(chartNumber: string, message: string): void {
  setConversionResult(conversionProgress, chartNumber, 'completed', message);
}

async function extractZip(zipPath: string, targetDir: string): Promise<string[]> {
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: targetDir }))
    .promise();

  const allFiles: string[] = [];
  const scan = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        allFiles.push(fullPath);
      }
    }
  };
  scan(targetDir);
  return allFiles;
}

function findEncFiles(dir: string): string[] {
  const files: string[] = [];
  const scan = (d: string): void => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith('.000') && !entry.name.startsWith('._')) {
        files.push(fullPath);
      }
    }
  };
  scan(dir);
  return files;
}

function appendLog(chartNumber: string, text: string): void {
  if (!chartNumber || !text) {
    return;
  }
  if (!conversionProgress[chartNumber]) {
    conversionProgress[chartNumber] = { status: 'converting', message: '', log: [] };
  }
  const log = conversionProgress[chartNumber].log;
  const lines = text.split(/\r|\n/).filter((l) => l.trim());
  log.push(...lines);
  if (log.length > MAX_LOG_LINES) {
    log.splice(0, log.length - MAX_LOG_LINES);
  }
}

function setProgress(chartNumber: string, status: string, message: string): void {
  if (!chartNumber) {
    return;
  }
  if (!conversionProgress[chartNumber]) {
    conversionProgress[chartNumber] = { status, message, log: [] };
  } else {
    conversionProgress[chartNumber].status = status;
    conversionProgress[chartNumber].message = message;
  }
}

/**
 * The `name` metadata row the tiler writes into the output MBTiles, so the
 * file is born with a sensible name even when the post-conversion metadata
 * patch (best-effort, never throws) fails; the patch only ever refines it to
 * the cleaned catalog title.
 *
 * Mirrors the fallback the patcher uses (`S-57 <chartNumber>`) so an
 * un-patched file matches a patched one's `name` when no displayName exists.
 */
function wantedMbtilesName(chartNumber: string, displayName: string | undefined): string {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : `S-57 ${chartNumber || 'ENC'}`;
}

/**
 * Decide the on-disk `.mbtiles` filename for a freshly converted chart.
 *
 * Catalogs (NL_IENC, etc.) hand us sequential chart numbers like "1",
 * "2", "3" — meaningless when the user later sees `1.mbtiles` in their
 * chart directory.  When the catalog also supplied a human-friendly
 * `displayName` (cleanCatalogTitle output, e.g. "Waddenzee met Diepte
 * 2026 - Week 18"), use that as the filename basis instead.
 *
 * Falls back to `<chartNumber>.mbtiles` when no displayName is provided
 * (manual upload path) or sanitizes to nothing.  Suffixes a numeric
 * counter on collisions so re-running a conversion against the same
 * catalog entry doesn't overwrite an existing chart silently.
 */
export function chooseOutputFilename(opts: {
  chartsDir: string;
  displayName: string | undefined;
  chartNumber: string;
  fileExists?: (path: string) => boolean;
}): string {
  const exists = opts.fileExists ?? fs.existsSync;
  // Sanitize both inputs up-front: the chartNumber feeds both the base
  // (when displayName is absent) and the collision suffix.  A malformed
  // catalog with a chartNumber like "../../evil" would otherwise turn
  // the candidate into a path-traversal escape and write the .mbtiles
  // somewhere outside chartsDir.  Catalog values are typically integers
  // and pass sanitization unchanged, so this is a safety net rather
  // than a behaviour change.
  const sanitized = opts.displayName ? sanitizeChartFilename(opts.displayName) : '';
  const safeChartNumber = sanitizeChartFilename(opts.chartNumber);
  const base = sanitized || safeChartNumber || 'enc-chart';

  const candidate = `${base}.mbtiles`;
  if (!exists(path.join(opts.chartsDir, candidate))) {
    return candidate;
  }

  // Collision: try chartNumber-suffixed first (informative), then a counter.
  // Catalog flow re-runs against the same chartNumber are the common case,
  // so users immediately see "this is from chart entry 1, take 2" via
  // the suffix instead of getting `Waddenzee_met_Diepte_2026-Week_18-2.mbtiles`.
  if (sanitized && safeChartNumber && safeChartNumber !== sanitized) {
    const numbered = `${base}-${safeChartNumber}.mbtiles`;
    if (!exists(path.join(opts.chartsDir, numbered))) {
      return numbered;
    }
  }
  for (let i = 2; i < 1000; i += 1) {
    const counted = `${base}-${i}.mbtiles`;
    if (!exists(path.join(opts.chartsDir, counted))) {
      return counted;
    }
  }
  // Pathological: 1000 collisions.  Fall through to a timestamped name
  // so we never silently overwrite.
  return `${base}-${Date.now()}.mbtiles`;
}

/**
 * Prefix of the empty file the export writes for each cell it exported
 * without an error, when asked to (`perCell`).
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
const SKIP_LAYERS = ['DSID', 'C_AGGR', 'C_ASSO', 'Generic'];

/**
 * Export every layer of every cell to `<LAYER>__<cell>.geojson` in
 * `geojsonDir` (`<LAYER>.geojson` for a lone cell, unless `perCell`), one
 * cell per worker at a time. One unreadable layer or cell is logged, not
 * fatal: a 60-cell bundle still converts when one cell is damaged.
 *
 * With `perCell` (the chart-set cache, which keeps output per cell), every
 * output is named after its cell and each cell exported without an error
 * gets an empty `${COMPLETE_MARKER_PREFIX}<cell>` file, so a partial export
 * is never kept as complete.
 */
async function exportAllLayersToGeoJSON(
  encFiles: readonly string[],
  geojsonDir: string,
  chartNumber: string,
  pool: WorkerPool,
  onPercent?: (pct: number) => void,
  perCell = false
): Promise<void> {
  const multiFile = perCell || encFiles.length > 1;
  const errorLog = path.join(geojsonDir, EXPORT_ERROR_FILE_BASENAME);
  fs.writeFileSync(errorLog, '');
  let done = 0;
  await forEachConcurrent(encFiles, pool.size, async (cell) => {
    const name = path.basename(cell, path.extname(cell));
    let result;
    try {
      result = await pool.run({
        op: 's57-cell',
        cell,
        outDir: geojsonDir,
        multiFile,
        skipLayers: SKIP_LAYERS
      });
    } catch (err) {
      if (!(err instanceof TaskFailedError)) {
        throw err;
      }
      // The worker died on this cell (a GDAL abort); the pool replaced it.
      result = { files: 0, complete: false, errors: [...err.log, `${name}: ${err.message}`] };
    }
    done++;
    appendLog(chartNumber, `PROGRESS: Processing ${name} (${done}/${encFiles.length})`);
    setProgress(chartNumber, 'converting', `Exporting ${name}...`);
    onPercent?.((done / encFiles.length) * 100);
    if (result.errors.length > 0) {
      fs.appendFileSync(errorLog, result.errors.join('\n') + '\n');
    }
    if (perCell && result.complete) {
      fs.writeFileSync(path.join(geojsonDir, `${COMPLETE_MARKER_PREFIX}${name}`), '');
    }
  });

  // Per-cell failures don't fail the export, so finishing doesn't mean any
  // output landed. If nothing usable came out, surface a sample of what GDAL
  // reported, so the user sees the actual error instead of just the
  // downstream "No valid GeoJSON layers" message.
  surfaceExportErrorsIfEmpty(geojsonDir, chartNumber);
}

function surfaceExportErrorsIfEmpty(geojsonDir: string, chartNumber: string): void {
  let hasUsableOutput = false;
  try {
    for (const f of fs.readdirSync(geojsonDir)) {
      if (!f.endsWith('.geojson')) {
        continue;
      }
      if (fs.statSync(path.join(geojsonDir, f)).size > 100) {
        hasUsableOutput = true;
        break;
      }
    }
  } catch {
    return;
  }
  if (hasUsableOutput) {
    return;
  }

  const errorFile = path.join(geojsonDir, EXPORT_ERROR_FILE_BASENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(errorFile, 'utf8');
  } catch {
    appendLog(
      chartNumber,
      'GDAL export produced no usable layers and no per-file errors were captured. ' +
        'Check that the chart files are readable by the Signal K server.'
    );
    return;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    appendLog(
      chartNumber,
      'GDAL export produced no usable layers and the captured error log was empty.'
    );
    return;
  }
  appendLog(
    chartNumber,
    `GDAL export ran but produced no usable GeoJSON layers. First ${Math.min(EXPORT_ERROR_SAMPLE_LINES, lines.length)} of ${lines.length} captured GDAL error line(s):`
  );
  for (const line of lines.slice(0, EXPORT_ERROR_SAMPLE_LINES)) {
    appendLog(chartNumber, `  ${line}`);
  }
  if (lines.length > EXPORT_ERROR_SAMPLE_LINES) {
    appendLog(
      chartNumber,
      `  ... ${lines.length - EXPORT_ERROR_SAMPLE_LINES} more error line(s) suppressed.`
    );
  }
}

/**
 * Size of a GeoJSON export file's content: an empty FeatureCollection is
 * ~100 bytes. A gzip file records its uncompressed size (modulo 2^32) in its
 * last four bytes, which is enough to tell.
 */
function geojsonContentSize(file: string): number {
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

/** A band's zoom range within the user's: the band's native scales, clamped. */
export function bandZoomRange(
  band: number | null,
  userMinzoom: number,
  userMaxzoom: number
): { minzoom: number; maxzoom: number } {
  if (band === null) {
    return { minzoom: userMinzoom, maxzoom: userMaxzoom };
  }
  return {
    minzoom: Math.max(userMinzoom, BAND_MIN_ZOOM[band] ?? userMinzoom),
    maxzoom: Math.min(userMaxzoom, BAND_MAX_ZOOM[band] ?? userMaxzoom)
  };
}

/**
 * Turn a directory of GDAL exports (`<LAYER>__<cell>.geojson[.gz]`, or
 * `<LAYER>.geojson` for a lone cell) into tiler sources: one per layer and
 * IHO band, shown at that band's zooms within the user's range. A band-5
 * harbour cell's features thus never crowd the overview zooms, and a band-2
 * cell's coarse coastline never draws over a harbour plan, in one pass over
 * the whole bundle. Cells whose names don't follow the IHO convention (IENC,
 * hand-named) use the user's range. Empty exports are skipped.
 */
export function planTileSources(
  geojsonDir: string,
  userMinzoom: number,
  userMaxzoom: number
): TileSource[] {
  const sources = new Map<string, TileSource>();
  for (const file of fs.readdirSync(geojsonDir).sort()) {
    if (!file.endsWith('.geojson') && !file.endsWith('.geojson.gz')) {
      continue;
    }
    const fullPath = path.join(geojsonDir, file);
    if (geojsonContentSize(fullPath) <= 100) {
      continue;
    }
    const { layer, cell } = exportFileParts(file);
    const band = cell !== null ? detectEncBand(cell) : null;
    const { minzoom, maxzoom } = bandZoomRange(band, userMinzoom, userMaxzoom);
    if (minzoom > maxzoom) {
      continue;
    }
    const key = `${layer}/${String(minzoom)}/${String(maxzoom)}`;
    const source = sources.get(key) ?? { layer, minzoom, maxzoom, files: [] };
    source.files.push(fullPath);
    sources.set(key, source);
  }
  return [...sources.values()];
}

export const _testInternals = {
  surfaceExportErrorsIfEmpty,
  wantedMbtilesName,
  SKIP_LAYERS
};

/**
 * Run GDAL on every cell under `encDir`, writing one `<LAYER>__<cell>.geojson`
 * per layer and cell into `geojsonDir`, without making tiles. The chart-set
 * cache keeps this output per cell, so an update runs GDAL only on the cells
 * that changed. Progress and errors go to `chartNumber`'s conversion log.
 */
export async function exportS57CellsToGeoJSON(
  encDir: string,
  geojsonDir: string,
  chartNumber: string,
  signal?: AbortSignal
): Promise<void> {
  const encFiles = findEncFiles(encDir);
  if (encFiles.length === 0) {
    throw new Error('No S-57 ENC files (.000) found in the chart data');
  }
  fs.mkdirSync(geojsonDir, { recursive: true });
  // A fresh log, so it holds only what this export reports.
  conversionProgress[chartNumber] = { status: 'converting', message: '', log: [] };
  appendLog(chartNumber, `Exporting ${encFiles.length} changed cell(s) to GeoJSON...`);
  try {
    await withWorkerPool(getCpuBudget().workersPerJob, signal, (pool) =>
      exportAllLayersToGeoJSON(encFiles, geojsonDir, chartNumber, pool, undefined, true)
    );
  } catch (err) {
    throw asCancellation(err);
  }
}

/**
 * Convert a directory tree of already-extracted S-57 ENC cells (`.000`
 * files, possibly nested) into a single vector MBTiles. This is the reusable
 * core of the conversion pipeline: `processS57Zip` extracts one ZIP and
 * delegates here, and the Custom Catalogs flow extracts many ENC archives
 * into one combined tree and converts it in a single pass so the output is
 * one `.mbtiles` per chart set.
 *
 * Two stages, both on the conversion's worker threads: GDAL (WebAssembly)
 * exports each cell's layers to GeoJSON, then the vector tiler builds the
 * MBTiles with each IHO band at its own zooms (see planTileSources).
 *
 * `encDir` is treated as read-only input. All conversion scratch is created
 * under `scratchParent` (defaulting to the parent of `encDir`) and removed on
 * the way out, so the caller's input tree is never mutated.
 */
export async function processS57Directory(
  encDir: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null,
  options: S57ConversionOptions = {},
  scratchParent?: string
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(scratchParent ?? path.dirname(encDir), `s57out_${Date.now()}`);
  const geojsonDir = path.join(tmpDir, 'geojson');
  fs.mkdirSync(geojsonDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting conversion...',
      log: []
    };
  }

  const emit = (stage: S57BucketProgress['stage'], bucketPercent: number): void => {
    options.onProgress?.({
      stage,
      bucketIndex: 1,
      bucketCount: 1,
      bucketLabel: 'Charts',
      bucketPercent
    });
  };
  // Cooperative cancel between stages; the abort signal stops a stage
  // mid-way by terminating its workers.
  const abortIfRequested = (): void => {
    if (options.isAborted?.() || options.signal?.aborted) {
      throw new Error(CONVERSION_ABORTED_MESSAGE);
    }
  };

  try {
    const encFiles = findEncFiles(encDir);
    if (encFiles.length === 0) {
      throw new Error('No S-57 ENC files (.000) found in the chart data');
    }
    debug(`Found ${encFiles.length} ENC files`);
    appendLog(chartNumber, `Found ${encFiles.length} ENC files`);

    const userMinzoom = options.minzoom ?? 9;
    const userMaxzoom = options.maxzoom ?? 16;
    const outputName = chooseOutputFilename({
      chartsDir,
      displayName: options.displayName,
      chartNumber
    });
    const outputPath = path.join(chartsDir, outputName);
    const workers = getCpuBudget().workersPerJob;

    await withWorkerPool(workers, options.signal, async (pool) => {
      statusFn('converting', 'Converting S-57 layers to GeoJSON...');
      emit('export', options.geojsonFor ? -1 : 0);
      if (options.geojsonFor) {
        appendLog(chartNumber, `Using the kept GeoJSON of ${encFiles.length} cell(s)`);
        await options.geojsonFor(encFiles, geojsonDir);
      } else {
        setProgress(chartNumber, 'converting', `Exporting ${encFiles.length} ENC files...`);
        appendLog(
          chartNumber,
          `Exporting ${encFiles.length} ENC file(s) with GDAL (WebAssembly), ${workers} worker(s)`
        );
        await exportAllLayersToGeoJSON(encFiles, geojsonDir, chartNumber, pool, (pct) => {
          emit('export', pct);
        });
      }
      abortIfRequested();

      const sources = planTileSources(geojsonDir, userMinzoom, userMaxzoom);
      if (sources.length === 0) {
        throw new Error('No valid GeoJSON layers to process');
      }
      logBandPlan(chartNumber, sources, userMinzoom, userMaxzoom);

      statusFn('converting', 'Generating vector tiles...');
      setProgress(chartNumber, 'converting', 'Generating vector tiles...');
      emit('tiles', 0);
      const result = await buildVectorMbtiles({
        sources,
        output: outputPath,
        scratchDir: path.join(tmpDir, 'tiles'),
        pool,
        name: wantedMbtilesName(chartNumber, options.displayName),
        description: options.displayDescription,
        signal: options.signal,
        log: (msg) => {
          appendLog(chartNumber, msg);
        },
        onPercent: (pct) => {
          if (chartNumber && conversionProgress[chartNumber]) {
            conversionProgress[chartNumber].message = `Generating tiles: ${pct}%`;
          }
          emit('tiles', pct);
        }
      });
      appendLog(
        chartNumber,
        `Wrote ${result.tiles} tiles (z${result.minzoom}-z${result.maxzoom}) from ${result.features} features`
      );
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Tiling completed but output file not found');
    }

    // Set `type=S-57` so Signal K + chart consumers identify the file
    // correctly. The patcher logs to BOTH the conversion log (visible in the
    // UI) and server stdout, so a failure (sqlite locks, …) is never silent.
    const patchResult = await patchS57Mbtiles(outputPath, chartNumber, {
      onMessage: (msg) => {
        debug(msg);
        appendLog(chartNumber, msg);
      }
    });
    if (!patchResult.ok) {
      const banner = `[charts-provider] WARNING: ${patchResult.message} (${outputName})`;
      console.warn(banner);
    }

    // Optional second patch: when the caller (catalog flow) supplied a
    // human-friendly label, overwrite the `name` row that
    // patchS57Mbtiles just wrote with the cleaned catalog title, and set
    // `description` to the full original title for provenance. Manual
    // uploads leave displayName undefined and keep the patcher's
    // `S-57 <chartNumber>` default. Trim before both the guard and the
    // value so a whitespace-only label falls through to the fallback
    // instead of overwriting it with blanks (mirrors wantedMbtilesName).
    const displayName = options.displayName?.trim();
    if (displayName) {
      const dnResult = await setMbtilesDisplayName(
        outputPath,
        displayName,
        options.displayDescription,
        {
          onMessage: (msg) => {
            debug(msg);
            appendLog(chartNumber, msg);
          }
        }
      );
      if (!dnResult.ok) {
        const banner = `[charts-provider] WARNING: ${dnResult.message} (${outputName})`;
        console.warn(banner);
      }
    }

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    const doneMsg = `Created ${outputName} (${size} MB)`;
    statusFn('completed', doneMsg);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }

    return { mbtilesFile: outputName };
  } catch (caught) {
    const err = asCancellation(caught);
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      debug(`Warning: failed to clean up ${tmpDir}`);
    }
  }
}

/**
 * Log which layers show from which zoom, per band, so users can see why
 * low-zoom features differ by band. Counts plus a sample of layer names —
 * full lists would be noisy (a state bundle has ~40 layers per band).
 */
function logBandPlan(
  chartNumber: string,
  sources: readonly TileSource[],
  userMinzoom: number,
  userMaxzoom: number
): void {
  const byRange = new Map<string, Set<string>>();
  for (const s of sources) {
    const key = `z${s.minzoom}-z${s.maxzoom}`;
    const layers = byRange.get(key) ?? new Set<string>();
    layers.add(s.layer);
    byRange.set(key, layers);
  }
  appendLog(
    chartNumber,
    `Zoom plan (user requested z${userMinzoom}-z${userMaxzoom}, clamped per IHO band):`
  );
  for (const [range, layers] of [...byRange.entries()].sort()) {
    const list = [...layers];
    const sample = list.slice(0, 6).join(', ');
    const more = list.length > 6 ? ', …' : '';
    appendLog(chartNumber, `  ${range}: ${list.length} layers (${sample}${more})`);
  }
}

/**
 * Extract a single S-57 ENC ZIP into a scratch tree and convert it to one
 * vector MBTiles. Thin wrapper over {@link processS57Directory}: it owns the
 * ZIP-specific extraction step (and its "not a valid ZIP archive" error
 * surface), then hands the extracted `enc/` tree to the shared pipeline.
 */
export async function processS57Zip(
  zipPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null,
  options: S57ConversionOptions = {}
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(path.dirname(zipPath), `s57_${Date.now()}`);
  const encDir = path.join(tmpDir, 'enc');
  fs.mkdirSync(encDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'extracting',
      message: 'Extracting ENC files...',
      log: []
    };
  }

  try {
    statusFn('extracting', 'Extracting ENC files...');
    setProgress(chartNumber, 'extracting', 'Extracting ENC files...');
    let extracted: string[];
    try {
      extracted = await extractZip(zipPath, encDir);
    } catch (zipErr) {
      throw new Error(
        `Downloaded file is not a valid ZIP archive (${zipErr instanceof Error ? zipErr.message : String(zipErr)}). The server may have returned an error page instead.`,
        { cause: zipErr }
      );
    }
    debug(`Extracted ${extracted.length} files from ZIP`);

    if (extracted.length === 0) {
      throw new Error('No files found in ZIP archive');
    }

    // Delegate to the shared pipeline. `tmpDir` is the scratch parent, so the
    // pipeline's scratch lands alongside `enc/` and is cleaned up together
    // with it by the finally below.
    return await processS57Directory(encDir, chartsDir, chartNumber, onStatus, options, tmpDir);
  } catch (err) {
    // processS57Directory already records its own failures; this also covers
    // the extraction phase (invalid/empty ZIP) before delegation. Idempotent
    // — both land on the same terminal 'failed' state.
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      debug(`Warning: failed to clean up ${tmpDir}`);
    }
  }
}

const GSHHG_URL = 'https://www.ngdc.noaa.gov/mgg/shorelines/data/gshhg/latest/gshhg-shp-2.3.7.zip';

// Overview zooms below a basemap's native zoom: what gdaladdo's 2…256
// factors gave.
const BASEMAP_OVERVIEW_LEVELS = 8;

/**
 * Burn a land-polygon shapefile into a world raster (sand on sea blue) and
 * tile it into a PNG MBTiles at `outputPath`, with overview zooms.
 */
async function rasterizeLandToMbtiles(opts: {
  shp: string;
  workDir: string;
  outputPath: string;
  width: number;
  chartNumber: string;
  pool: WorkerPool;
}): Promise<void> {
  const { chartNumber, pool } = opts;
  const worldTif = path.join(opts.workDir, 'world.tif');
  const logGdal = (lines: readonly string[]): void => {
    for (const line of lines) {
      appendLog(chartNumber, line);
    }
  };

  appendLog(chartNumber, 'Rasterizing shapefile...');
  const rasterized = await pool.run({
    op: 'gdal-rasterize',
    source: { path: opts.shp },
    dst: worldTif,
    args: [
      '-burn',
      '240',
      '-burn',
      '230',
      '-burn',
      '208',
      '-init',
      '168',
      '-init',
      '212',
      '-init',
      '230',
      '-a_srs',
      'EPSG:4326',
      '-te',
      '-180',
      '-85.05',
      '180',
      '85.05',
      '-ts',
      String(opts.width),
      String(Math.round(opts.width / 2)),
      '-ot',
      'Byte',
      '-of',
      'GTiff',
      '-co',
      'COMPRESS=LZW',
      // The high and full GSHHG resolutions are far past 4 GB uncompressed;
      // a classic TIFF could not hold them.
      '-co',
      'BIGTIFF=IF_SAFER'
    ]
  });
  logGdal(rasterized.log);

  setProgress(chartNumber, 'converting', 'Creating MBTiles...');
  appendLog(chartNumber, 'Creating MBTiles...');
  const translated = await pool.run({
    op: 'gdal-translate',
    source: { path: worldTif },
    dst: opts.outputPath,
    args: ['-of', 'MBTiles', '-co', 'TILE_FORMAT=PNG']
  });
  logGdal(translated.log);

  setProgress(chartNumber, 'converting', 'Adding zoom levels...');
  appendLog(chartNumber, 'Adding overview zoom levels...');
  const added = await addRasterOverviews(opts.outputPath, BASEMAP_OVERVIEW_LEVELS, pool);
  appendLog(chartNumber, `Added ${added} overview tiles`);
}

/** Overwrite metadata rows; best-effort. */
function setRasterMetadata(file: string, rows: Record<string, string>): void {
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('BEGIN');
      for (const [name, value] of Object.entries(rows)) {
        db.prepare('DELETE FROM metadata WHERE name = ?').run(name);
        db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)').run(name, value);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  } catch {
    debug(`Warning: failed to set metadata of ${path.basename(file)}`);
  }
}

const DOWNLOAD_STALL_MS = 60_000;

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = (target: string, redirects: number): void => {
      const req = https.get(target, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 5) {
          response.resume();
          // A bad Location, or one off https, throws here, inside the
          // response listener; fail the download rather than the process.
          try {
            request(new URL(location, target).toString(), redirects + 1);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`NOAA returned HTTP ${status}`));
          return;
        }
        const total = parseInt(response.headers['content-length'] ?? '0');
        let downloaded = 0;
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          onProgress(downloaded, total);
        });
        // pipeline settles on an error of either stream, so a dropped
        // connection fails the download instead of leaving it pending.
        pipeline(response, fs.createWriteStream(dest)).then(resolve, reject);
      });
      // A connection silent this long has stalled; fail it.
      req.setTimeout(DOWNLOAD_STALL_MS, () => {
        req.destroy(new Error('Download stalled'));
      });
      req.on('error', reject);
    };
    request(url, 0);
  });
}

export async function processGshhg(
  tmpDir: string,
  chartsDir: string,
  resolution: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const resLabels: Record<string, string> = {
    c: 'Crude',
    l: 'Low',
    i: 'Intermediate',
    h: 'High',
    f: 'Full'
  };

  if (!Object.prototype.hasOwnProperty.call(resLabels, resolution)) {
    throw new Error(`Invalid GSHHG resolution: ${resolution}`);
  }

  setProgress(chartNumber, 'converting', 'Downloading GSHHG shapefiles from NOAA...');
  appendLog(
    chartNumber,
    `Downloading GSHHG shapefiles (${resLabels[resolution] ?? resolution})...`
  );

  const zipPath = path.join(tmpDir, 'gshhg-shp.zip');
  await downloadFile(GSHHG_URL, zipPath, (downloaded, total) => {
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      const mb = (downloaded / (1024 * 1024)).toFixed(1);
      const totalMb = (total / (1024 * 1024)).toFixed(0);
      setProgress(
        chartNumber,
        'converting',
        `Downloading shapefiles: ${mb}/${totalMb} MB (${pct}%)`
      );
    }
  });

  appendLog(chartNumber, 'Download complete. Extracting shapefiles...');
  setProgress(chartNumber, 'converting', 'Extracting shapefiles...');

  const shpDir = path.join(tmpDir, 'shp');
  fs.mkdirSync(shpDir, { recursive: true });

  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: shpDir }))
    .promise();

  const rasterSizes: Record<string, number> = { c: 8192, l: 16384, i: 65536, h: 131072, f: 262144 };
  const rasterSize = rasterSizes[resolution] ?? 32768;

  appendLog(chartNumber, `Rasterizing land polygons (${rasterSize}px width)...`);
  setProgress(chartNumber, 'converting', 'Rasterizing land polygons...');

  const outputName = `gshhg-basemap-${resolution}.mbtiles`;
  const outputPath = path.join(chartsDir, outputName);

  await withWorkerPool(getCpuBudget().workersPerJob, undefined, (pool) =>
    rasterizeLandToMbtiles({
      shp: path.join(shpDir, 'GSHHS_shp', resolution, `GSHHS_${resolution}_L1.shp`),
      workDir: tmpDir,
      outputPath,
      width: rasterSize,
      chartNumber,
      pool
    })
  );

  setRasterMetadata(outputPath, {
    name: `GSHHG World Basemap (${resLabels[resolution] ?? resolution})`,
    description: `Global coastlines and lakes - GSHHG v2.3.7 ${(resLabels[resolution] ?? resolution).toLowerCase()} resolution`,
    type: 'tilelayer',
    format: 'png'
  });

  const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  const doneMsg = `GSHHG basemap installed (${size} MB)`;
  statusFn('completed', doneMsg);
  appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

  if (chartNumber) {
    setConversionCompleted(chartNumber, doneMsg);
  }

  return { mbtilesFile: outputName };
}

export async function processShpBasemap(
  tarPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<S57ConversionResult> {
  const statusFn = onStatus ?? (() => {});
  const tmpDir = path.join(path.dirname(tarPath), `shpbasemap_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting basemap conversion...',
      log: []
    };
  }

  try {
    setProgress(chartNumber, 'extracting', 'Extracting shapefiles...');
    appendLog(chartNumber, 'Extracting archive...');
    const extracted = await extractTarArchive(tarPath, tmpDir);

    const shapefiles = extracted
      .filter((f) => f.endsWith('.shp') && !path.basename(f).startsWith('._'))
      .sort();
    const landShp =
      shapefiles.find((f) => path.basename(f).includes('L1')) ??
      shapefiles.find((f) => path.basename(f).includes('land')) ??
      shapefiles[0];

    if (!landShp) {
      throw new Error('No .shp files found in archive');
    }

    debug(`Found shapefile: ${landShp}`);
    appendLog(chartNumber, `Found: ${path.basename(landShp)}`);

    const resMap: Record<string, { size: number; label: string }> = {
      basemap_c: { size: 8192, label: 'Crude' },
      basemap_l: { size: 16384, label: 'Low' },
      basemap_i: { size: 32768, label: 'Medium' },
      basemap_h: { size: 65536, label: 'High' },
      basemap_f: { size: 131072, label: 'Full' }
    };
    const res = resMap[chartNumber] ?? { size: 32768, label: 'Medium' };

    setProgress(chartNumber, 'converting', `Rasterizing (${res.label})...`);
    appendLog(chartNumber, `Rasterizing at ${res.size}px width...`);

    const outputName = `osm-basemap-${chartNumber.replace('basemap_', '')}.mbtiles`;
    const outputPath = path.join(chartsDir, outputName);

    await withWorkerPool(getCpuBudget().workersPerJob, undefined, (pool) =>
      rasterizeLandToMbtiles({
        shp: landShp,
        workDir: tmpDir,
        outputPath,
        width: res.size,
        chartNumber,
        pool
      })
    );

    setRasterMetadata(outputPath, {
      name: `OSM Basemap (${res.label})`,
      type: 'tilelayer',
      format: 'png'
    });

    const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    const doneMsg = `Basemap installed (${size} MB)`;
    statusFn('completed', doneMsg);
    appendLog(chartNumber, `Done: ${outputName} (${size} MB)`);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }
    return { mbtilesFile: outputName };
  } catch (err) {
    if (chartNumber) {
      setConversionFailed(
        chartNumber,
        (err instanceof Error ? err.message : String(err)) || 'Conversion failed'
      );
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
