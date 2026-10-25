import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { buildVectorMbtiles, groupSources } from '../dist/utils/vector-tiler.js';
import { tileProperties } from '../dist/utils/vector-tile-shard.js';
import { withWorkerPool } from '../dist/utils/worker-pool.js';

type Position = [number, number];

function square(west: number, south: number, east: number, north: number): Position[][] {
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south]
    ]
  ];
}

function writeFC(file: string, features: unknown[]): void {
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
}

/** XYZ tile of a position. */
function tileOf(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function readTile(db: DatabaseSync, z: number, x: number, y: number): VectorTile | null {
  const row = db
    .prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    )
    .get(z, x, 2 ** z - 1 - y) as { tile_data: Uint8Array } | undefined;
  return row ? new VectorTile(new PbfReader(zlib.gunzipSync(row.tile_data))) : null;
}

function readTileAt(db: DatabaseSync, lon: number, lat: number, z: number): VectorTile | null {
  const { x, y } = tileOf(lon, lat, z);
  return readTile(db, z, x, y);
}

describe('tileProperties', () => {
  it('joins list attributes, drops nulls, keeps scalars', () => {
    assert.deepStrictEqual(
      tileProperties({ COLOUR: ['1', '3'], DRVAL1: 2.5, OBJNAM: null, LIT: true, NAME: 'x' }),
      { COLOUR: '1,3', DRVAL1: 2.5, LIT: true, NAME: 'x' }
    );
  });
});

describe('groupSources', () => {
  it('merges sources with the same layer and zoom range, drops empty ranges', () => {
    const { groups, files } = groupSources([
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a1'] },
      { layer: 'A', minzoom: 9, maxzoom: 12, files: ['a2'] },
      { layer: 'A', minzoom: 12, maxzoom: 16, files: ['a3'] },
      { layer: 'B', minzoom: 14, maxzoom: 12, files: ['b1'] }
    ]);
    assert.deepStrictEqual(groups, [
      { layer: 'A', minzoom: 9, maxzoom: 12 },
      { layer: 'A', minzoom: 12, maxzoom: 16 }
    ]);
    assert.deepStrictEqual(files, [
      { path: 'a1', group: 0 },
      { path: 'a2', group: 0 },
      { path: 'a3', group: 1 }
    ]);
  });
});

describe('buildVectorMbtiles', () => {
  let tmp: string;
  let db: DatabaseSync;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-'));
    // A coastal (band 4) and a harbour (band 5) depth area over the same
    // water, so their zoom ranges overlap at z12-z14, plus a light.
    writeFC(path.join(tmp, 'coastal.geojson'), [
      {
        type: 'Feature',
        properties: { DRVAL1: 0, BAND: 4, COLOUR: ['1', '3'], OBJNAM: null },
        geometry: { type: 'Polygon', coordinates: square(10.0, 54.0, 10.2, 54.1) }
      }
    ]);
    writeFC(path.join(tmp, 'harbour.geojson'), [
      {
        type: 'Feature',
        properties: { DRVAL1: 5, BAND: 5 },
        geometry: { type: 'Polygon', coordinates: square(10.05, 54.02, 10.1, 54.05) }
      }
    ]);
    writeFC(path.join(tmp, 'lights.geojson'), [
      {
        type: 'Feature',
        properties: { CATLIT: ['4'] },
        geometry: { type: 'Point', coordinates: [10.07, 54.03] }
      }
    ]);
    // A polygon far larger than its shards (z6 shards are ~5.6° wide), to
    // check that features reaching past a shard are cut cleanly.
    writeFC(path.join(tmp, 'overview.geojson'), [
      {
        type: 'Feature',
        properties: { BAND: 1 },
        geometry: { type: 'Polygon', coordinates: square(-10, -10, 10, 10) }
      }
    ]);

    const output = path.join(tmp, 'out.mbtiles');
    const result = await withWorkerPool(2, undefined, (pool) =>
      buildVectorMbtiles({
        sources: [
          { layer: 'DEPARE', minzoom: 10, maxzoom: 14, files: [path.join(tmp, 'coastal.geojson')] },
          { layer: 'DEPARE', minzoom: 12, maxzoom: 16, files: [path.join(tmp, 'harbour.geojson')] },
          { layer: 'LIGHTS', minzoom: 12, maxzoom: 16, files: [path.join(tmp, 'lights.geojson')] },
          { layer: 'M_COVR', minzoom: 6, maxzoom: 8, files: [path.join(tmp, 'overview.geojson')] }
        ],
        output,
        scratchDir: path.join(tmp, 'scratch'),
        pool,
        name: 'Test chart'
      })
    );
    assert.strictEqual(result.minzoom, 6);
    assert.strictEqual(result.maxzoom, 16);
    assert.strictEqual(result.features, 4);
    db = new DatabaseSync(output);
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes its scratch directory', () => {
    assert.strictEqual(fs.existsSync(path.join(tmp, 'scratch')), false);
  });

  it('writes MBTiles metadata with the layers and their fields', () => {
    const meta = Object.fromEntries(
      (
        db.prepare('SELECT name, value FROM metadata').all() as { name: string; value: string }[]
      ).map((r) => [r.name, r.value])
    );
    assert.strictEqual(meta.name, 'Test chart');
    assert.strictEqual(meta.format, 'pbf');
    assert.strictEqual(meta.minzoom, '6');
    assert.strictEqual(meta.maxzoom, '16');
    const json = JSON.parse(meta.json) as {
      vector_layers: {
        id: string;
        minzoom: number;
        maxzoom: number;
        fields: Record<string, string>;
      }[];
    };
    const depare = json.vector_layers.find((l) => l.id === 'DEPARE');
    assert.deepStrictEqual(
      { minzoom: depare?.minzoom, maxzoom: depare?.maxzoom },
      { minzoom: 10, maxzoom: 16 }
    );
    assert.deepStrictEqual(depare?.fields, { DRVAL1: 'Number', BAND: 'Number', COLOUR: 'String' });
    const [west, south, east, north] = meta.bounds.split(',').map(Number);
    assert.deepStrictEqual([west, south, east, north], [-10, -10, 10.2, 54.1]);
  });

  it('shows each source only within its zoom range', () => {
    const z10 = readTileAt(db, 10.07, 54.03, 10);
    assert.deepStrictEqual(Object.keys(z10?.layers ?? {}), ['DEPARE']);
    assert.strictEqual(z10?.layers.DEPARE.length, 1);
    assert.strictEqual(z10?.layers.DEPARE.feature(0).properties.BAND, 4);

    const z16 = readTileAt(db, 10.07, 54.03, 16);
    const bands = Array.from(
      { length: z16?.layers.DEPARE.length ?? 0 },
      (_, i) => z16?.layers.DEPARE.feature(i).properties.BAND
    );
    assert.deepStrictEqual(bands, [5]);
    assert.strictEqual(readTileAt(db, 10.07, 54.03, 9), null);
  });

  it('merges same-named layers where zoom ranges of sources overlap', () => {
    const z13 = readTileAt(db, 10.07, 54.03, 13);
    assert.ok(z13);
    assert.deepStrictEqual(Object.keys(z13.layers).sort(), ['DEPARE', 'LIGHTS']);
    const bands = Array.from({ length: z13.layers.DEPARE.length }, (_, i) =>
      Number(z13.layers.DEPARE.feature(i).properties.BAND)
    ).sort();
    assert.deepStrictEqual(bands, [4, 5]);
    assert.strictEqual(z13.layers.LIGHTS.feature(0).properties.CATLIT, '4');
    assert.strictEqual(z13.layers.DEPARE.feature(0).properties.OBJNAM, undefined);
  });

  it('cuts features larger than a shard exactly, with no copies across the antimeridian', () => {
    // Inside the big polygon: the tile is covered.
    const inside = readTileAt(db, 0, 0, 8);
    assert.ok(inside, 'a tile inside the polygon');
    const ring = inside.layers.M_COVR.feature(0).loadGeometry()[0];
    const xs = ring.map((p) => p.x);
    assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 4096, 'covers the whole tile');
    // Well outside it, on every side, nothing.
    for (const [lon, lat] of [
      [15, 0],
      [-15, 0],
      [0, 15],
      [0, -15],
      [170, 0]
    ] as const) {
      assert.strictEqual(
        readTileAt(db, lon, lat, 8),
        null,
        `no tile at ${String(lon)},${String(lat)}`
      );
    }
  });

  it('writes the tile rows south-up (TMS)', () => {
    const { x, y } = tileOf(5, 5, 6);
    const row = db
      .prepare('SELECT 1 FROM tiles WHERE zoom_level = 6 AND tile_column = ? AND tile_row = ?')
      .get(x, 2 ** 6 - 1 - y);
    assert.ok(row);
  });
});

describe('buildVectorMbtiles with SCAMIN', () => {
  let tmp: string;
  let db: DatabaseSync;
  const near = (i: number): [number, number] => [0.01 + i * 0.001, 0.01];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-scamin-'));
    // On the equator SCAMIN 90000 is reached at z13 (see s57-scamin.ts).
    const point = (c: string, i: number, props: Record<string, unknown> = {}): unknown => ({
      type: 'Feature',
      properties: { c, ...props },
      geometry: { type: 'Point', coordinates: near(i) }
    });
    writeFC(path.join(tmp, 'soundg.geojson'), [
      point('coastal', 0, { SCAMIN: 90000 }),
      point('overview', 1, { SCAMIN: 1e9 }),
      point('berth', 2, { SCAMIN: 1000 }),
      point('none', 3)
    ]);
    writeFC(path.join(tmp, 'plain.geojson'), [point('unflagged', 4, { SCAMIN: 90000 })]);
    const output = path.join(tmp, 'out.mbtiles');
    await withWorkerPool(2, undefined, (pool) =>
      buildVectorMbtiles({
        sources: [
          {
            layer: 'SOUNDG',
            minzoom: 9,
            maxzoom: 14,
            scamin: true,
            files: [path.join(tmp, 'soundg.geojson')]
          },
          { layer: 'PLAIN', minzoom: 9, maxzoom: 14, files: [path.join(tmp, 'plain.geojson')] }
        ],
        output,
        scratchDir: path.join(tmp, 'scratch'),
        pool,
        name: 'SCAMIN chart'
      })
    );
    db = new DatabaseSync(output);
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const shownAt = (layer: string, z: number): string[] => {
    const tile = readTileAt(db, ...near(0), z);
    const l = tile?.layers[layer];
    return Array.from({ length: l?.length ?? 0 }, (_, i) =>
      String(l?.feature(i).properties.c)
    ).sort();
  };

  it('leaves a feature out of tiles below its SCAMIN zoom, within its source range', () => {
    assert.deepStrictEqual(shownAt('SOUNDG', 9), ['none', 'overview']);
    assert.deepStrictEqual(shownAt('SOUNDG', 12), ['none', 'overview']);
    assert.deepStrictEqual(shownAt('SOUNDG', 13), ['coastal', 'none', 'overview']);
    // Capped at the source's maxzoom, so clients overzooming it still draw it.
    assert.deepStrictEqual(shownAt('SOUNDG', 14), ['berth', 'coastal', 'none', 'overview']);
  });

  it('ignores SCAMIN for sources that do not ask for it', () => {
    assert.deepStrictEqual(shownAt('PLAIN', 9), ['unflagged']);
  });

  it('keeps its bookkeeping out of the tiles', () => {
    const tile = readTileAt(db, ...near(0), 14);
    const layer = tile?.layers.SOUNDG;
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const keys = Object.keys(layer?.feature(i).properties ?? {}).sort();
      assert.ok(
        keys.every((k) => k === 'c' || k === 'SCAMIN'),
        keys.join(',')
      );
    }
    const meta = db.prepare("SELECT value FROM metadata WHERE name = 'json'").get() as {
      value: string;
    };
    const layers = (
      JSON.parse(meta.value) as { vector_layers: { id: string; fields: Record<string, string> }[] }
    ).vector_layers;
    const soundg = layers.find((l) => l.id === 'SOUNDG');
    assert.deepStrictEqual(Object.keys(soundg?.fields ?? {}).sort(), ['SCAMIN', 'c']);
  });
});

describe('buildVectorMbtiles failures', () => {
  it('rejects when no source has features and leaves no output behind', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-empty-'));
    try {
      writeFC(path.join(tmp, 'empty.geojson'), []);
      const output = path.join(tmp, 'out.mbtiles');
      await assert.rejects(
        withWorkerPool(1, undefined, (pool) =>
          buildVectorMbtiles({
            sources: [
              { layer: 'X', minzoom: 9, maxzoom: 10, files: [path.join(tmp, 'empty.geojson')] }
            ],
            output,
            scratchDir: path.join(tmp, 'scratch'),
            pool,
            name: 'x'
          })
        ),
        /No valid GeoJSON layers/
      );
      assert.strictEqual(fs.existsSync(output), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stops with a cancellation when the pool is aborted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-tiler-abort-'));
    try {
      writeFC(path.join(tmp, 'a.geojson'), [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: square(0, 0, 1, 1) }
        }
      ]);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        withWorkerPool(1, controller.signal, (pool) =>
          buildVectorMbtiles({
            sources: [
              { layer: 'X', minzoom: 9, maxzoom: 10, files: [path.join(tmp, 'a.geojson')] }
            ],
            output: path.join(tmp, 'out.mbtiles'),
            scratchDir: path.join(tmp, 'scratch'),
            pool,
            name: 'x',
            signal: controller.signal
          })
        ),
        /cancelled/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
