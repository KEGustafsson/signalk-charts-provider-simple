import fs from 'fs';
import path from 'path';
import unzipper from 'unzipper';
import { getCpuBudget } from './concurrency.js';
import { MAX_CONVERSION_LOG_LINES } from './conversion-log.js';
import { setConversionResult } from './conversion-progress.js';
import { setMbtilesType } from './mbtiles-metadata.js';
import { addRasterOverviews } from './raster-pyramid.js';
import { extractTarArchive } from './tar-extract.js';
import { TaskFailedError, forEachConcurrent, withWorkerPool } from './worker-pool.js';
import type {
  ConversionProgress,
  ConversionProgressMap,
  RncConversionResult,
  StatusCallback,
  DebugFunction
} from '../types.js';

const conversionProgress: ConversionProgressMap = {};
const MAX_LOG_LINES = MAX_CONVERSION_LOG_LINES;

let debug: DebugFunction = () => {};

export function initRncConverter(debugFn: DebugFunction): void {
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

function setConvertProgress(chartNumber: string, status: string, message: string): void {
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

// Overview zooms below a chart's native zoom: what gdaladdo's 2, 4, 8 and 16
// factors gave.
const OVERVIEW_LEVELS = 4;

// macOS archives carry AppleDouble `._<name>` companions beside each file;
// they share the extension but are not charts.
const isChartFile = (file: string, extensions: readonly string[]): boolean =>
  extensions.includes(path.extname(file).toLowerCase()) && !path.basename(file).startsWith('._');

/**
 * Convert BSB/KAP charts to raster MBTiles in `chartsDir`, one per chart, on
 * the conversion's worker threads: GDAL (WebAssembly) tiles each chart at its
 * native zoom, then overview zooms are built below it. A chart that fails is
 * logged and skipped. Returns the file names written.
 */
async function convertKapFiles(
  kapFiles: readonly string[],
  chartsDir: string,
  chartNumber: string
): Promise<string[]> {
  const converted: (string | null)[] = kapFiles.map(() => null);
  let started = 0;
  await withWorkerPool(getCpuBudget().workersPerJob, undefined, async (pool) => {
    await forEachConcurrent(kapFiles, pool.size, async (kap, index) => {
      started++;
      const friendly = path.basename(kap);
      const outputName = `${path.basename(kap, path.extname(kap))}.mbtiles`;
      const outputPath = path.join(chartsDir, outputName);
      appendLog(chartNumber, `PROGRESS: Converting ${friendly} (${started}/${kapFiles.length})`);
      setConvertProgress(
        chartNumber,
        'converting',
        `Converting ${friendly} (${started}/${kapFiles.length})...`
      );
      try {
        const result = await pool.run({
          op: 'gdal-translate',
          source: { path: kap },
          dst: outputPath,
          args: ['-of', 'MBTiles', '-co', 'TILE_FORMAT=PNG']
        });
        for (const line of result.log) {
          appendLog(chartNumber, line);
        }
      } catch (err) {
        if (!(err instanceof TaskFailedError)) {
          throw err;
        }
        for (const line of err.log) {
          appendLog(chartNumber, line);
        }
        appendLog(chartNumber, `ERROR: gdal_translate failed for ${friendly}: ${err.message}`);
        fs.rmSync(outputPath, { force: true });
        return;
      }

      try {
        await addRasterOverviews(outputPath, OVERVIEW_LEVELS, pool);
        appendLog(chartNumber, `Overviews added for ${outputName}`);
      } catch (err) {
        if (!(err instanceof TaskFailedError)) {
          throw err;
        }
        appendLog(chartNumber, `Warning: adding overviews failed for ${friendly}`);
      }

      const tagResult = await setMbtilesType(outputPath, 'tilelayer', {
        onMessage: (msg) => {
          appendLog(chartNumber, msg);
        }
      });
      if (!tagResult.ok) {
        appendLog(chartNumber, `Warning: failed to set tilelayer metadata for ${friendly}`);
      }

      if (fs.existsSync(outputPath)) {
        converted[index] = outputName;
      }
    });
  });
  return converted.filter((f): f is string => f !== null);
}

export async function processRncZip(
  zipPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<RncConversionResult> {
  const statusFn = onStatus ?? (() => {});

  const tmpDir = path.join(path.dirname(zipPath), `rnc_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting RNC conversion...',
      log: []
    };
  }

  try {
    statusFn('extracting', 'Extracting BSB chart files from ZIP...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting BSB files...');
    let extracted: string[];
    try {
      extracted = await extractZip(zipPath, tmpDir);
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

    const kapFiles = extracted.filter((f) => isChartFile(f, ['.kap', '.bsb']));

    if (kapFiles.length === 0) {
      throw new Error('No .kap or .bsb files found in ZIP archive');
    }

    debug(`Found ${kapFiles.length} BSB chart file(s) to convert`);
    appendLog(chartNumber, `Found ${kapFiles.length} BSB chart file(s)`);

    statusFn('converting', `Converting ${kapFiles.length} BSB chart(s) to MBTiles...`);
    setConvertProgress(chartNumber, 'converting', `Converting ${kapFiles.length} chart(s)...`);
    const mbtilesFiles = await convertKapFiles(kapFiles, chartsDir, chartNumber);

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts converted');
    }

    const doneMsg = `Converted ${mbtilesFiles.length} chart(s) to MBTiles`;
    statusFn('completed', doneMsg);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }

    return { mbtilesFiles };
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
      debug(`Warning: failed to clean up temp dir ${tmpDir}`);
    }
  }
}

export async function processPilotTar(
  tarPath: string,
  chartsDir: string,
  chartNumber: string,
  onStatus: StatusCallback | null
): Promise<RncConversionResult> {
  const statusFn = onStatus ?? (() => {});

  const tmpDir = path.join(path.dirname(tarPath), `pilot_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  if (chartNumber) {
    conversionProgress[chartNumber] = {
      status: 'starting',
      message: 'Starting Pilot Chart conversion...',
      log: []
    };
  }

  try {
    statusFn('extracting', 'Extracting pilot chart archive...');
    setConvertProgress(chartNumber, 'extracting', 'Extracting archive...');
    const extracted = await extractTarArchive(tarPath, tmpDir);

    const kapFiles = extracted.filter((f) => isChartFile(f, ['.kap'])).sort();

    if (kapFiles.length === 0) {
      throw new Error('No .kap files found in archive');
    }

    debug(`Found ${kapFiles.length} .kap files`);
    appendLog(chartNumber, `Found ${kapFiles.length} .kap chart file(s)`);

    statusFn('converting', `Converting ${kapFiles.length} chart(s)...`);
    setConvertProgress(chartNumber, 'converting', `Converting ${kapFiles.length} chart(s)...`);
    const mbtilesFiles = await convertKapFiles(kapFiles, chartsDir, chartNumber);

    if (mbtilesFiles.length === 0) {
      throw new Error('No charts converted');
    }

    const doneMsg = `Converted ${mbtilesFiles.length} chart(s)`;
    statusFn('completed', doneMsg);

    if (chartNumber) {
      setConversionCompleted(chartNumber, doneMsg);
    }

    return { mbtilesFiles };
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
