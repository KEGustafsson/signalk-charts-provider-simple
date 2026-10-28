import os from 'os';
import v8 from 'node:v8';

export type CpuBudgetPreset = 'single-core' | 'half' | 'all';

export interface ResolvedBudget {
  /** Max number of conversion jobs that can run at the same time. */
  maxConcurrentConversions: number;
  /**
   * Worker threads each WebAssembly conversion runs on (worker-pool.ts):
   * GDAL exports and tile shards, one per worker at a time.
   */
  workersPerJob: number;
  /** TIPPECANOE_MAX_THREADS (and the CPU cap) of each container tippecanoe job. */
  tippecanoeThreadsPerJob: number;
  /** Width of the xargs -P fan-out used for parallel ogr2ogr in the container GDAL export. */
  gdalExportParallelism: number;
}

const cpuCount = (): number => Math.max(1, os.cpus().length);

function resolveBudget(preset: CpuBudgetPreset, cpus: number): ResolvedBudget {
  const safe = Math.max(1, cpus);
  switch (preset) {
    case 'single-core':
      return {
        maxConcurrentConversions: 1,
        workersPerJob: 1,
        tippecanoeThreadsPerJob: 1,
        gdalExportParallelism: 1
      };
    case 'all':
      // One full-throttle job. Multi-bundle uploads queue serially; each
      // single bundle uses every core in every stage.
      return {
        maxConcurrentConversions: 1,
        workersPerJob: safe,
        tippecanoeThreadsPerJob: safe,
        gdalExportParallelism: safe
      };
    case 'half':
    default: {
      // One job at a time, using half the host's cores.  Most sailors run
      // a single conversion at a time; if someone fires off two in parallel
      // they're knowingly overprovisioning.  Pre-2.0 this preset was
      // "ceil(cpus/2) parallel jobs × 2 threads each", which was confusing
      // because a single conversion never saw more than 2 cores even on
      // a 6-core box, and the kernel scheduler still let those 2 threads
      // each take a full core anyway.  New definition matches user
      // intuition: "half" = "this conversion uses half the host."
      const perJob = Math.max(1, Math.floor(safe / 2));
      return {
        maxConcurrentConversions: 1,
        workersPerJob: perJob,
        tippecanoeThreadsPerJob: perJob,
        gdalExportParallelism: perJob
      };
    }
  }
}

let current: ResolvedBudget = resolveBudget('half', cpuCount());

/** Apply a budget preset. Called from the plugin's start() with the user's setting. */
export function setCpuBudget(preset: CpuBudgetPreset | undefined | null): void {
  current = resolveBudget(preset ?? 'half', cpuCount());
}

/** Read the currently applied budget. Each call returns the live values, so
 *  call sites pick up budget changes between conversions. */
export function getCpuBudget(): ResolvedBudget {
  return current;
}

/** For tests: pure function over a synthetic CPU count. */
export function _computeBudgetForTests(preset: CpuBudgetPreset, cpus: number): ResolvedBudget {
  return resolveBudget(preset, cpus);
}

/**
 * Memory one tile worker can take on a dense ENC set: Rotterdam's harbour
 * cells, the densest measured, tiled in 1.4 GB with a 768 MB heap.
 */
const TILE_WORKER_MEMORY_MB = 1536;
/** Below this a worker's heap holds too little to tile any band. */
const MIN_TILE_HEAP_MB = 256;

export interface TilePoolSize {
  workers: number;
  /** Old-generation limit of each worker. */
  heapMb: number;
  /** Whether the heap is below the server's own limit: memory is short. */
  reduced: boolean;
}

/**
 * How many tile workers fit in the memory that is free, at most the CPU
 * budget's `workersPerJob`, and the heap each may grow to. V8 grows a heap
 * up to its limit before it collects in earnest, so without a lower limit
 * the workers together can take more than the host has, and the kernel then
 * kills the whole server rather than one task. Half of each worker's share
 * goes to the heap, at most the server's own limit; the rest is GDAL's and
 * the tiles' buffers, which live outside it.
 */
export function tilePoolSize(
  workersPerJob: number,
  availableMb: number,
  defaultHeapMb: number
): TilePoolSize {
  const workers = Math.max(
    1,
    Math.min(workersPerJob, Math.floor(availableMb / TILE_WORKER_MEMORY_MB))
  );
  const heap = Math.max(MIN_TILE_HEAP_MB, Math.floor(availableMb / workers / 2));
  return { workers, heapMb: Math.min(heap, defaultHeapMb), reduced: heap < defaultHeapMb };
}

const MB = 1024 * 1024;

/** `tilePoolSize` for this host now, within the live CPU budget. */
export function getTilePoolSize(): TilePoolSize {
  return tilePoolSize(
    current.workersPerJob,
    process.availableMemory() / MB,
    Math.floor(v8.getHeapStatistics().heap_size_limit / MB)
  );
}
