import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forEachLine } from '../dist/utils/line-reader.js';
import { TaskFailedError, withWorkerPool } from '../dist/utils/worker-pool.js';

describe('forEachLine', () => {
  it('keeps multi-byte characters whole across read boundaries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-lines-'));
    try {
      const lines = ['Ålesund havn', 'Göteborg — Älvsborg', '', 'plain', 'Łeba 港'];
      const file = path.join(tmp, 'lines.ndjson');
      fs.writeFileSync(file, lines.join('\n'));
      // Every chunk size, so a boundary lands inside every character.
      for (let chunk = 1; chunk <= 12; chunk++) {
        const read: string[] = [];
        forEachLine(file, (line) => read.push(line), chunk);
        assert.deepStrictEqual(
          read,
          lines.filter((l) => l !== ''),
          `chunk size ${String(chunk)}`
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('WorkerPool', () => {
  it('reports a failed task as a TaskFailedError', async () => {
    await withWorkerPool(1, undefined, async (pool) => {
      await assert.rejects(
        pool.run({
          op: 'gdal-translate',
          source: { path: path.join(os.tmpdir(), 'no-such-chart.kap') },
          dst: path.join(os.tmpdir(), 'no-such-chart.mbtiles'),
          args: ['-of', 'MBTiles']
        }),
        (err: unknown) => err instanceof TaskFailedError
      );
    });
  });
});
