/**
 * Entry point of the GDAL worker threads (worker-pool.ts). One worker runs
 * one task at a time: a GDAL call on its own WebAssembly GDAL instance
 * (gdal-wasm.ts, loaded on the worker's first task).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { loadGdalWasm, GdalError, type GdalSource, type GdalWasm } from './gdal-wasm.js';

/** Export every layer of one S-57 cell to `<outDir>/<LAYER>[__<cell>].geojson`. */
export interface S57CellTask {
  op: 's57-cell';
  cell: string;
  outDir: string;
  /** Name outputs `<LAYER>__<cell>.geojson` rather than `<LAYER>.geojson`. */
  multiFile: boolean;
  skipLayers: string[];
}

/** A GDAL utility run with `args`, `source` → `dst`. */
export interface GdalUtilityTask {
  source: GdalSource;
  dst: string;
  args: string[];
}

export interface GdalTranslateTask extends GdalUtilityTask {
  op: 'gdal-translate';
}

export interface GdalRasterizeTask extends GdalUtilityTask {
  op: 'gdal-rasterize';
}

/** `ogr2ogr` with `args`, `source` → `dst`. */
export interface GdalVectorTranslateTask extends GdalUtilityTask {
  op: 'gdal-vector-translate';
}

export type ConversionTask =
  S57CellTask | GdalTranslateTask | GdalRasterizeTask | GdalVectorTranslateTask;

export type TaskResult =
  | {
      op: 's57-cell';
      files: number;
      /** False when a layer, or the cell itself, could not be read. */
      complete: boolean;
      /** GDAL's messages for the cell's failures. */
      errors: string[];
    }
  | { op: 'gdal-translate'; log: string[] }
  | { op: 'gdal-rasterize'; log: string[] }
  | { op: 'gdal-vector-translate'; log: string[] };

export interface WorkerRequest {
  id: number;
  task: ConversionTask;
}

export type WorkerReply =
  | { id: number; type: 'done'; result: TaskResult }
  | { id: number; type: 'error'; message: string; log: string[] };

let gdal: Promise<GdalWasm> | null = null;
const getGdal = (): Promise<GdalWasm> => (gdal ??= loadGdalWasm());

// The S-57 driver reads the sounding layer's multipoints as one feature per
// sounding, with the depth as an attribute, only when asked at open time.
const SOUNDG_OPEN_OPTIONS = ['SPLIT_MULTIPOINT=YES', 'ADD_SOUNDG_DEPTH=YES'];

function exportS57Cell(g: GdalWasm, task: S57CellTask): TaskResult {
  // A failure copies the log rather than draining it: start clean, so no
  // earlier task's messages are reported as this cell's.
  g.drainLog();
  const name = path.basename(task.cell, path.extname(task.cell));
  const errors: string[] = [];
  const fail = (err: unknown): void => {
    // Anything but a GDAL error (a WebAssembly trap or abort) leaves the
    // instance unusable: fail the task, so the worker reloads GDAL.
    if (!(err instanceof GdalError)) {
      throw err;
    }
    errors.push(...err.gdalLog);
    errors.push(`${name}: ${err.message}`);
  };
  let layers: string[];
  try {
    layers = g.layerNames({ path: task.cell });
  } catch (err) {
    fail(err);
    return { op: 's57-cell', files: 0, complete: false, errors };
  }
  g.drainLog();
  const skip = new Set(task.skipLayers);
  let files = 0;
  let complete = true;
  for (const layer of layers) {
    if (skip.has(layer)) {
      continue;
    }
    // `<LAYER>__<cell>`: see EXPORT_NAME_SEPARATOR in s57-band.ts.
    const outName = task.multiFile ? `${layer}__${name}` : layer;
    const dst = path.join(task.outDir, `${outName}.geojson`);
    // The GeoJSON driver refuses to overwrite.
    fs.rmSync(dst, { force: true });
    try {
      g.vectorTranslate(
        dst,
        {
          path: task.cell,
          openOptions: layer === 'SOUNDG' ? SOUNDG_OPEN_OPTIONS : undefined
        },
        ['-f', 'GeoJSON', layer]
      );
      files++;
    } catch (err) {
      complete = false;
      fs.rmSync(dst, { force: true });
      fail(err);
    }
    g.drainLog();
  }
  return { op: 's57-cell', files, complete, errors };
}

async function runTask(task: ConversionTask): Promise<TaskResult> {
  switch (task.op) {
    case 's57-cell':
      return exportS57Cell(await getGdal(), task);
    case 'gdal-translate':
    case 'gdal-rasterize':
    case 'gdal-vector-translate': {
      const g = await getGdal();
      g.drainLog();
      fs.rmSync(task.dst, { force: true });
      switch (task.op) {
        case 'gdal-translate':
          g.translate(task.dst, task.source, task.args);
          return { op: task.op, log: g.drainLog() };
        case 'gdal-rasterize':
          g.rasterize(task.dst, task.source, task.args);
          return { op: task.op, log: g.drainLog() };
        case 'gdal-vector-translate':
          g.vectorTranslate(task.dst, task.source, task.args);
          return { op: task.op, log: g.drainLog() };
      }
    }
  }
}

parentPort?.on('message', ({ id, task }: WorkerRequest) => {
  runTask(task).then(
    (result) => {
      const reply: WorkerReply = { id, type: 'done', result };
      parentPort?.postMessage(reply);
    },
    (err: unknown) => {
      if (!(err instanceof GdalError)) {
        // A trap or an Emscripten abort may have left the GDAL instance
        // broken; the next GDAL task loads a fresh one.
        gdal = null;
      }
      const reply: WorkerReply = {
        id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        log: err instanceof GdalError ? err.gdalLog : []
      };
      parentPort?.postMessage(reply);
    }
  );
});
