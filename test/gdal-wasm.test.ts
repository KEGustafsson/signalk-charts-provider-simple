/**
 * GDAL (gdal3.js) on the conversion workers: the operations the converters
 * run, on small inputs made here. The S-57 driver itself has no fixture; the
 * per-cell export runs on a GeoJSON "cell", which takes the same path.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gdalBuildId, loadGdalWasm } from '../dist/utils/gdal-wasm.js';
import { TaskFailedError, withWorkerPool } from '../dist/utils/worker-pool.js';

const square = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'land', COLOUR: ['1', '3'] },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-20, -10],
            [20, -10],
            [20, 10],
            [-20, 10],
            [-20, -10]
          ]
        ]
      }
    }
  ]
};

describe('gdal-wasm', () => {
  let tmp: string;
  let input: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-gdal-'));
    input = path.join(tmp, 'in put', 'LNDARE.geojson');
    fs.mkdirSync(path.dirname(input));
    fs.writeFileSync(input, JSON.stringify(square));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('identifies the GDAL build by the gdal3.js version', () => {
    assert.match(gdalBuildId(), /^gdal3\.js \d+\.\d+\.\d+$/);
  });

  it('has the drivers the converters need', async () => {
    const gdal = await loadGdalWasm();
    for (const name of ['S57', 'GeoJSON', 'GeoJSONSeq', 'ESRI Shapefile']) {
      assert.ok(gdal.hasDriver('vector', name), `vector driver ${name}`);
    }
    for (const name of ['BSB', 'MBTiles', 'GTiff', 'PNG']) {
      assert.ok(gdal.hasDriver('raster', name), `raster driver ${name}`);
    }
    assert.deepStrictEqual(gdal.layerNames({ path: input }), ['LNDARE']);
  });

  it('exports every layer of a cell, named after the cell', async () => {
    const out = path.join(tmp, 'export');
    fs.mkdirSync(out);
    const result = await withWorkerPool(1, undefined, (pool) =>
      pool.run({ op: 's57-cell', cell: input, outDir: out, multiFile: true, skipLayers: [] })
    );
    assert.deepStrictEqual(
      { files: result.files, complete: result.complete, errors: result.errors },
      { files: 1, complete: true, errors: [] }
    );
    const fc = JSON.parse(fs.readFileSync(path.join(out, 'LNDARE__LNDARE.geojson'), 'utf8')) as {
      features: { properties: Record<string, unknown> }[];
    };
    assert.strictEqual(fc.features[0].properties.NAME, 'land');
  });

  it('reports an unreadable cell as incomplete with GDAL’s error', async () => {
    const out = path.join(tmp, 'export-bad');
    fs.mkdirSync(out);
    const bad = path.join(tmp, 'BROKEN.000');
    fs.writeFileSync(bad, 'not an S-57 file');
    const result = await withWorkerPool(1, undefined, (pool) =>
      pool.run({ op: 's57-cell', cell: bad, outDir: out, multiFile: true, skipLayers: [] })
    );
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.files, 0);
    assert.ok(result.errors.some((e) => e.includes('BROKEN')));
  });

  it('rasterizes a shapefile-like source and tiles it into an MBTiles', async () => {
    const tif = path.join(tmp, 'world.tif');
    const mbtiles = path.join(tmp, 'world.mbtiles');
    await withWorkerPool(1, undefined, async (pool) => {
      await pool.run({
        op: 'gdal-rasterize',
        source: { path: input },
        dst: tif,
        args: [
          '-burn',
          '200',
          '-init',
          '10',
          '-a_srs',
          'EPSG:4326',
          '-te',
          '-180',
          '-85',
          '180',
          '85',
          '-ts',
          '512',
          '256',
          '-ot',
          'Byte',
          '-of',
          'GTiff'
        ]
      });
      await pool.run({
        op: 'gdal-translate',
        source: { path: tif },
        dst: mbtiles,
        args: ['-of', 'MBTiles', '-co', 'TILE_FORMAT=PNG']
      });
    });
    const db = new DatabaseSync(mbtiles);
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM tiles').get() as { n: number };
      assert.ok(n > 0);
    } finally {
      db.close();
    }
  });

  it('fails a task with GDAL’s message, leaving the pool usable', async () => {
    await withWorkerPool(1, undefined, async (pool) => {
      await assert.rejects(
        pool.run({
          op: 'gdal-translate',
          source: { path: path.join(tmp, 'missing.tif') },
          dst: path.join(tmp, 'x.mbtiles'),
          args: ['-of', 'MBTiles']
        }),
        (err: unknown) => err instanceof TaskFailedError && /missing\.tif/.test(err.message)
      );
      const ok = await pool.run({
        op: 'gdal-vector-translate',
        source: { path: input },
        dst: path.join(tmp, 'seq.geojsonl'),
        args: ['-f', 'GeoJSONSeq']
      });
      assert.strictEqual(ok.op, 'gdal-vector-translate');
      assert.match(fs.readFileSync(path.join(tmp, 'seq.geojsonl'), 'utf8'), /"land"/);
    });
  });
});
