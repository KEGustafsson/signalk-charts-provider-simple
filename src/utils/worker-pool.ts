/**
 * The worker threads WebAssembly GDAL runs on (conversion-worker.ts), never
 * the server's event loop. A job opens its own pool and closes it when done,
 * so the WASM heaps of its GDAL instances (which never shrink) are released
 * with it, and a cancel can stop work mid-task: aborting the pool's signal
 * terminates every worker, which stops a GDAL call at once rather than at the
 * next boundary. Workers start on demand, up to the pool's size.
 */

import { Worker } from 'node:worker_threads';
import type {
  ConversionTask,
  TaskResult,
  WorkerReply,
  WorkerRequest
} from './conversion-worker.js';

/** Thrown for every task still pending when the pool's signal aborts. */
export class PoolAbortedError extends Error {
  constructor() {
    super('Conversion cancelled');
    this.name = 'AbortError';
  }
}

/** A task failed inside its worker; `log` holds GDAL's messages, if any. */
export class TaskFailedError extends Error {
  constructor(
    message: string,
    readonly log: string[]
  ) {
    super(message);
    this.name = 'TaskFailedError';
  }
}

interface Pending {
  task: ConversionTask;
  transfer: ArrayBuffer[];
  resolve: (result: TaskResult) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  current: (Pending & { id: number }) | null;
}

export interface RunOptions {
  /** Buffers moved to the worker rather than copied. */
  transfer?: ArrayBuffer[];
}

export class WorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly queue: Pending[] = [];
  /** Workers being terminated, which close() waits for. */
  private readonly stopping: Promise<unknown>[] = [];
  private nextId = 0;
  private closed = false;
  private readonly onAbort = (): void => {
    this.terminate(new PoolAbortedError());
  };

  constructor(
    readonly size: number,
    private readonly signal?: AbortSignal
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  run<O extends ConversionTask['op']>(
    task: Extract<ConversionTask, { op: O }>,
    options: RunOptions = {}
  ): Promise<Extract<TaskResult, { op: O }>> {
    if (this.signal?.aborted) {
      return Promise.reject(new PoolAbortedError());
    }
    if (this.closed) {
      return Promise.reject(new Error('Worker pool is closed'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        transfer: options.transfer ?? [],
        resolve: resolve as (result: TaskResult) => void,
        reject
      });
      this.dispatch();
    });
  }

  /** Stop every worker. Pending tasks reject; idempotent. */
  async close(): Promise<void> {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.terminate(new Error('Worker pool is closed'));
    // Only once every worker has exited may the caller remove the
    // directories they were writing to.
    await Promise.allSettled(this.stopping);
  }

  private terminate(reason: Error): void {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      pending.reject(reason);
    }
    for (const entry of this.workers.splice(0)) {
      entry.current?.reject(reason);
      entry.current = null;
      this.stopping.push(entry.worker.terminate());
    }
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let entry = this.workers.find((w) => w.current === null);
      if (!entry) {
        if (this.workers.length >= Math.max(1, this.size)) {
          return;
        }
        entry = this.spawn();
      }
      const pending = this.queue.shift();
      if (!pending) {
        return;
      }
      const id = this.nextId++;
      entry.current = { ...pending, id };
      const request: WorkerRequest = { id, task: pending.task };
      entry.worker.postMessage(request, pending.transfer);
    }
  }

  private spawn(): PoolWorker {
    const worker = new Worker(new URL('./conversion-worker.js', import.meta.url));
    const entry: PoolWorker = { worker, current: null };
    this.workers.push(entry);
    worker.on('message', (reply: WorkerReply) => {
      const current = entry.current;
      if (current?.id !== reply.id) {
        return;
      }
      entry.current = null;
      if (reply.type === 'done') {
        current.resolve(reply.result);
      } else {
        current.reject(new TaskFailedError(reply.message, reply.log));
      }
      this.dispatch();
    });
    // A crashed worker (an aborted WASM instance, an out-of-memory heap)
    // fails its task only, as a TaskFailedError like any other failed task,
    // so callers skip the one cell; the next task gets a fresh
    // worker.
    const fail = (err: Error): void => {
      const index = this.workers.indexOf(entry);
      if (index < 0) {
        return;
      }
      this.workers.splice(index, 1);
      entry.current?.reject(new TaskFailedError(err.message, []));
      entry.current = null;
      if (!this.closed) {
        this.dispatch();
      }
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      fail(new Error(`Conversion worker exited with code ${String(code)}`));
    });
    return entry;
  }
}

/**
 * Run `body` with a pool of `size` workers, closing it however `body` ends.
 */
export async function withWorkerPool<T>(
  size: number,
  signal: AbortSignal | undefined,
  body: (pool: WorkerPool) => Promise<T>
): Promise<T> {
  const pool = new WorkerPool(size, signal);
  try {
    return await body(pool);
  } finally {
    await pool.close();
  }
}
