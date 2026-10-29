/**
 * Tests for the shared ENC store (`enc-store.ts`): how collections are
 * written, replaced, read and removed, and what readers are told.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chartOwner,
  chartSetCollections,
  chartSetOwner,
  collectionIdFor,
  collectionOf,
  encStoreRoot,
  getCollection,
  initEncStore,
  listCollections,
  onEncStoreChange,
  removeCollection,
  removeCollectionOf,
  storeCollection,
  storedFilePath,
  sweepEncStore,
  type StoreCollectionRequest
} from '../dist/utils/enc-store.js';
import { cachedCellSources, initChartSetCache } from '../dist/utils/chart-set-cache.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-store-test-'));
let dataDir = '';
let sourceDir = '';
let run = 0;

/** A cell's files in `dir`: its `.000` and the updates named, with fixed contents. */
function makeCell(dir: string, name: string, updates: string[] = [], content = name): string {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${name}.000`);
  fs.writeFileSync(base, `base ${content}`);
  for (const ext of updates) {
    fs.writeFileSync(path.join(dir, `${name}.${ext}`), `update ${ext} ${content}`);
  }
  return base;
}

function request(overrides: Partial<StoreCollectionRequest>): StoreCollectionRequest {
  return {
    owner: chartOwner('Harbour.mbtiles'),
    preferredId: 'Harbour.mbtiles',
    name: 'Harbour',
    kind: 'conversion',
    chart: 'Harbour.mbtiles',
    source: 'upload',
    cells: [],
    mode: 'link',
    ...overrides
  };
}

beforeEach(() => {
  run += 1;
  dataDir = path.join(tmpRoot, `data-${String(run)}`);
  sourceDir = path.join(tmpRoot, `source-${String(run)}`);
  fs.mkdirSync(dataDir, { recursive: true });
  initEncStore(dataDir, () => {});
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('collectionIdFor', () => {
  it('makes a safe id of a chart file or set name', () => {
    assert.strictEqual(collectionIdFor('Gulf of Finland'), 'Gulf_of_Finland');
    assert.strictEqual(collectionIdFor('US5MA1.mbtiles'), 'US5MA1');
    assert.strictEqual(collectionIdFor('../../etc'), 'etc');
    assert.strictEqual(collectionIdFor('åäö'), 'enc');
  });
});

describe('storeCollection', () => {
  it('stores each cell in its own folder, updates beside it, under the cell name', async () => {
    const a = makeCell(path.join(sourceDir, 'ENC_ROOT', 'A'), 'FI5AAAAA', ['001', '002']);
    const b = makeCell(path.join(sourceDir, 'ENC_ROOT', 'B'), 'FI5BBBBB');
    const result = await storeCollection(request({ cells: [{ base: a }, { base: b }] }));

    assert.strictEqual(result.id, 'Harbour');
    assert.deepStrictEqual(result.written.sort(), ['FI5AAAAA', 'FI5BBBBB']);
    const root = encStoreRoot();
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'Harbour', 'FI5AAAAA')).sort(), [
      'FI5AAAAA.000',
      'FI5AAAAA.001',
      'FI5AAAAA.002'
    ]);
    const collection = getCollection('Harbour');
    assert.ok(collection);
    assert.strictEqual(collection.cellCount, 2);
    assert.strictEqual(collection.kind, 'conversion');
    assert.strictEqual(collection.chart, 'Harbour.mbtiles');
    assert.deepStrictEqual(
      collection.cells.map((c) => [c.name, c.files.map((f) => f.name)]),
      [
        ['FI5AAAAA', ['FI5AAAAA.000', 'FI5AAAAA.001', 'FI5AAAAA.002']],
        ['FI5BBBBB', ['FI5BBBBB.000']]
      ]
    );
    assert.strictEqual(collection.dir, path.join(root, 'Harbour'));
    // No work folder is left.
    assert.deepStrictEqual(
      fs.readdirSync(root).filter((n) => n.startsWith('.')),
      []
    );
  });

  it('names updates kept apart after the cell, as given in files', async () => {
    const base = makeCell(path.join(sourceDir, 'base'), 'US5MA1AM');
    const update = path.join(sourceDir, 'upd', 'us5ma1am.001');
    fs.mkdirSync(path.dirname(update), { recursive: true });
    fs.writeFileSync(update, 'update');
    await storeCollection(request({ cells: [{ base, files: [base, update] }] }));
    assert.deepStrictEqual(
      fs.readdirSync(path.join(encStoreRoot(), 'Harbour', 'US5MA1AM')).sort(),
      ['US5MA1AM.000', 'US5MA1AM.001']
    );
  });

  it('keeps an unchanged cell as it is and tells listeners only of a change', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA', ['001']);
    const heard: string[] = [];
    const unsubscribe = onEncStoreChange((id) => heard.push(id));
    try {
      await storeCollection(request({ cells: [{ base: a }], mode: 'copy' }));
      const file = path.join(encStoreRoot(), 'Harbour', 'FI5AAAAA', 'FI5AAAAA.000');
      const ino = fs.statSync(file).ino;
      assert.strictEqual(fs.statSync(file).mtimeMs <= fs.statSync(a).mtimeMs + 1, true);

      const again = await storeCollection(request({ cells: [{ base: a }], mode: 'copy' }));
      assert.deepStrictEqual(again.written, []);
      assert.strictEqual(fs.statSync(file).ino, ino);
      assert.deepStrictEqual(heard, ['Harbour']);

      // An update added changes the cell.
      fs.writeFileSync(path.join(sourceDir, 'A', 'FI5AAAAA.002'), 'update 2');
      const changed = await storeCollection(request({ cells: [{ base: a }], mode: 'copy' }));
      assert.deepStrictEqual(changed.written, ['FI5AAAAA']);
      assert.deepStrictEqual(heard, ['Harbour', 'Harbour']);
    } finally {
      unsubscribe();
    }
  });

  it('removes cells left out and replaces a changed one whole', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA');
    const b = makeCell(path.join(sourceDir, 'B'), 'FI5BBBBB');
    await storeCollection(request({ cells: [{ base: a }, { base: b }] }));
    const a2 = makeCell(path.join(sourceDir, 'A2'), 'FI5AAAAA', [], 'new edition');
    const result = await storeCollection(request({ cells: [{ base: a2 }] }));
    assert.deepStrictEqual(result.written, ['FI5AAAAA']);
    assert.deepStrictEqual(result.removed, ['FI5BBBBB']);
    const stored = path.join(encStoreRoot(), 'Harbour', 'FI5AAAAA', 'FI5AAAAA.000');
    assert.strictEqual(fs.readFileSync(stored, 'utf8'), 'base new edition');
    assert.deepStrictEqual(
      getCollection('Harbour')?.cells.map((c) => c.name),
      ['FI5AAAAA']
    );
  });

  it('keeps one cell of each name and skips names that are not a cell', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA');
    const dup = makeCell(path.join(sourceDir, 'dup'), 'FI5AAAAA', [], 'other');
    const odd = makeCell(path.join(sourceDir, 'odd'), 'bad name');
    const result = await storeCollection(
      request({ cells: [{ base: a }, { base: dup }, { base: odd }] })
    );
    assert.deepStrictEqual(result.written, ['FI5AAAAA']);
    assert.deepStrictEqual(result.skipped, ['FI5AAAAA.000', 'bad name.000']);
    const stored = path.join(encStoreRoot(), 'Harbour', 'FI5AAAAA', 'FI5AAAAA.000');
    assert.strictEqual(fs.readFileSync(stored, 'utf8'), 'base FI5AAAAA');
  });

  it('gives another owner of the same name its own id, and an owner keeps its id', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA');
    await storeCollection(
      request({ owner: chartSetOwner('Harbour'), preferredId: 'Harbour', kind: 'chart-set' })
    );
    const first = await storeCollection(request({ cells: [{ base: a }] }));
    assert.strictEqual(first.id, 'Harbour-2');
    const again = await storeCollection(request({ cells: [{ base: a }] }));
    assert.strictEqual(again.id, 'Harbour-2');
    assert.strictEqual(collectionOf(chartOwner('Harbour.mbtiles')), 'Harbour-2');
    assert.deepStrictEqual(
      listCollections().map((c) => c.id),
      ['Harbour', 'Harbour-2']
    );
    assert.deepStrictEqual([...chartSetCollections()], [['Harbour', 'Harbour']]);
  });

  it('runs two writes of one collection one after the other', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA');
    const b = makeCell(path.join(sourceDir, 'B'), 'FI5BBBBB');
    const [one, two] = await Promise.all([
      storeCollection(request({ cells: [{ base: a }] })),
      storeCollection(request({ cells: [{ base: b }] }))
    ]);
    assert.strictEqual(one.id, two.id);
    assert.deepStrictEqual(
      getCollection(one.id)?.cells.map((c) => c.name),
      ['FI5BBBBB']
    );
  });
});

describe('storedFilePath', () => {
  it('finds a stored file and refuses anything else', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA', ['001']);
    await storeCollection(request({ cells: [{ base: a }] }));
    assert.strictEqual(
      storedFilePath('Harbour', 'FI5AAAAA', 'FI5AAAAA.001'),
      path.join(encStoreRoot(), 'Harbour', 'FI5AAAAA', 'FI5AAAAA.001')
    );
    assert.strictEqual(storedFilePath('Harbour', 'FI5AAAAA', 'FI5AAAAA.002'), null);
    assert.strictEqual(storedFilePath('Harbour', 'FI5AAAAA', 'collection.json'), null);
    assert.strictEqual(storedFilePath('Harbour', 'FI5AAAAA', 'FI5BBBBB.000'), null);
    assert.strictEqual(storedFilePath('..', 'FI5AAAAA', 'FI5AAAAA.000'), null);
    assert.strictEqual(storedFilePath('Harbour', '..', 'FI5AAAAA.000'), null);
  });
});

describe('removeCollection', () => {
  it('removes a collection and tells listeners', async () => {
    const a = makeCell(path.join(sourceDir, 'A'), 'FI5AAAAA');
    await storeCollection(request({ cells: [{ base: a }] }));
    const heard: string[] = [];
    const unsubscribe = onEncStoreChange((id) => heard.push(id));
    try {
      assert.strictEqual(await removeCollection('Harbour'), true);
      assert.strictEqual(await removeCollection('Harbour'), false);
      assert.strictEqual(getCollection('Harbour'), null);
      assert.deepStrictEqual(heard, ['Harbour']);
      // The source cells stay.
      assert.ok(fs.existsSync(a));
      await removeCollectionOf(chartOwner('Harbour.mbtiles'));
      assert.deepStrictEqual(fs.readdirSync(encStoreRoot()), []);
    } finally {
      unsubscribe();
    }
  });
});

describe('sweepEncStore', () => {
  it('removes work folders and collections without a record, once per process', () => {
    const root = encStoreRoot();
    fs.mkdirSync(path.join(root, '.staging-x-1-1', 'FI5AAAAA'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Half', 'FI5AAAAA'), { recursive: true });
    assert.deepStrictEqual(sweepEncStore().sort(), ['.staging-x-1-1', 'Half']);
    fs.mkdirSync(path.join(root, '.staging-y-1-1'), { recursive: true });
    assert.deepStrictEqual(sweepEncStore(), []);
    assert.ok(fs.existsSync(path.join(root, '.staging-y-1-1')));
  });
});

describe('chart set cells', () => {
  it('are mirrored by hard link with their versions', async () => {
    initChartSetCache(dataDir, () => {});
    const cellDir = path.join(dataDir, 'chart-set-cache', 'Gulf', 'cells', 'FI5AAAAA');
    makeCell(path.join(cellDir, 'raw'), 'FI5AAAAA', ['001']);
    fs.writeFileSync(
      path.join(cellDir, 'cell.json'),
      JSON.stringify({ version: 'FI5AAAAA_ED003_UP001', exportRevision: 2, image: 'x', bytes: 1 })
    );
    const cells = cachedCellSources('Gulf');
    assert.strictEqual(cells.length, 1);
    const result = await storeCollection({
      owner: chartSetOwner('Gulf'),
      preferredId: 'Gulf',
      name: 'Gulf',
      kind: 'chart-set',
      source: 'chart-set',
      cells,
      mode: 'link'
    });
    const stored = path.join(encStoreRoot(), result.id, 'FI5AAAAA', 'FI5AAAAA.001');
    assert.strictEqual(
      fs.statSync(stored).ino,
      fs.statSync(path.join(cellDir, 'raw', 'FI5AAAAA.001')).ino
    );
    const collection = getCollection('Gulf');
    assert.strictEqual(collection?.cells[0]?.version, 'FI5AAAAA_ED003_UP001');
    assert.strictEqual(collection.kind, 'chart-set');
  });
});

describe('processS57Directory keepCells', () => {
  it('hands the cells a chart was built from to keepCells, and logs its line', async () => {
    const { processS57Directory, getConversionProgress } =
      await import('../dist/utils/s57-converter.js');
    const { setConversionEnginePreference } = await import('../dist/utils/conversion-backend.js');
    setConversionEnginePreference('wasm');
    try {
      const encDir = path.join(sourceDir, 'enc');
      const base = makeCell(path.join(encDir, 'ENC_ROOT', 'US5MA1SK'), 'US5MA1SK', ['001']);
      const charts = path.join(sourceDir, 'out');
      fs.mkdirSync(charts, { recursive: true });
      const polygon = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { DRVAL1: 5 },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-70.9, 42.3],
                  [-70.8, 42.3],
                  [-70.8, 42.4],
                  [-70.9, 42.3]
                ]
              ]
            }
          }
        ]
      };
      let kept: { cells: readonly string[]; file: string } | null = null;
      const result = await processS57Directory(
        encDir,
        charts,
        'keep-cells',
        null,
        {
          // A band-5 cell is tiled from z13.
          minzoom: 13,
          maxzoom: 13,
          geojsonFor: (_files: readonly string[], outDir: string) => {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(
              path.join(outDir, 'DEPARE__US5MA1SK.geojson'),
              JSON.stringify(polygon)
            );
            return Promise.resolve();
          },
          keepCells: async (cells: readonly string[], file: string) => {
            kept = { cells, file };
            const stored = await storeCollection(
              request({
                owner: chartOwner(file),
                preferredId: file,
                cells: cells.map((c) => ({ base: c }))
              })
            );
            return `kept as ${stored.id}`;
          }
        },
        sourceDir
      );
      assert.deepStrictEqual(kept, { cells: [base], file: result.mbtilesFile });
      assert.ok(getConversionProgress('keep-cells')?.log.includes('kept as keep-cells'));
      assert.deepStrictEqual(
        getCollection('keep-cells')?.cells.map((c) => c.files.map((f) => f.name)),
        [['US5MA1SK.000', 'US5MA1SK.001']]
      );
    } finally {
      setConversionEnginePreference(undefined);
    }
  });
});
