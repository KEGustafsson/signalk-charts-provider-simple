import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  LocalSourceError,
  extractLocalChartSource,
  inspectLocalChartSource,
  isBsbChart,
  isS57Cell,
  resolveLocalPath
} from '../dist/utils/local-chart-source.js';
import {
  getConversionProgress as getRncProgress,
  processRncLocal
} from '../dist/utils/rnc-converter.js';
import { _testInternals } from '../dist/utils/s57-converter.js';

const { uniqueCells } = _testInternals;

// A minimal STORED ZIP, as in zip-extract.test.ts.
function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

function write(file: string, data: string | Buffer = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** Every file under `dir`, relative, with its size and modification time. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const st = fs.statSync(full);
        out.push(`${path.relative(dir, full)}:${String(st.size)}:${String(st.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-local-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('resolveLocalPath', () => {
  it('needs a full path', () => {
    assert.throws(() => resolveLocalPath('   '), LocalSourceError);
    assert.throws(() => resolveLocalPath('charts/ENC_ROOT'), LocalSourceError);
    assert.equal(resolveLocalPath(path.join(TMP, 'a', '..', 'b')), path.join(TMP, 'b'));
  });

  it('reads ~ as the home folder', () => {
    assert.equal(resolveLocalPath('~'), os.homedir());
    assert.equal(resolveLocalPath('~/charts'), path.join(os.homedir(), 'charts'));
  });
});

describe('chart file tests', () => {
  it('match cells and BSB charts, but not AppleDouble companions', () => {
    assert.ok(isS57Cell('US5MA1AA.000'));
    assert.ok(!isS57Cell('US5MA1AA.001'));
    assert.ok(!isS57Cell('._US5MA1AA.000'));
    assert.ok(isBsbChart('13221_1.KAP'));
    assert.ok(isBsbChart('13221.bsb'));
    assert.ok(!isBsbChart('._13221_1.kap'));
  });
});

describe('inspectLocalChartSource', () => {
  it('finds loose cells and the ZIP files that hold cells', async () => {
    const dir = path.join(TMP, 'mixed');
    write(path.join(dir, 'ENC_ROOT', 'US5MA1AA', 'US5MA1AA.000'));
    write(path.join(dir, 'ENC_ROOT', 'US5MA1AA', 'US5MA1AA.001'));
    write(path.join(dir, 'ENC_ROOT', 'US5MA1AA', '._US5MA1AA.000'));
    write(path.join(dir, '.hidden', 'US5XX1AA.000'));
    write(
      path.join(dir, 'zips', 'cells.zip'),
      storedZip([{ name: 'ENC_ROOT/US5MA2AA/US5MA2AA.000', data: Buffer.from('y') }])
    );
    write(
      path.join(dir, 'zips', 'other.zip'),
      storedZip([{ name: 'readme.txt', data: Buffer.from('z') }])
    );
    write(path.join(dir, 'broken.zip'), 'not a zip');

    const source = await inspectLocalChartSource(dir, isS57Cell, 'S-57 cells');
    assert.equal(source.root, dir);
    assert.equal(source.name, 'mixed');
    assert.deepEqual(source.looseFiles, [path.join(dir, 'ENC_ROOT', 'US5MA1AA', 'US5MA1AA.000')]);
    assert.deepEqual(source.zips, [path.join(dir, 'zips', 'cells.zip')]);
    assert.equal(source.unreadableZips.length, 1);
    assert.ok(source.unreadableZips[0]?.startsWith(path.join(dir, 'broken.zip')));
  });

  it('takes one ZIP file and names the chart after it', async () => {
    const zip = path.join(TMP, 'single', 'US_REGION_01.zip');
    write(zip, storedZip([{ name: 'BSB_ROOT/13221/13221_1.KAP', data: Buffer.from('k') }]));
    const source = await inspectLocalChartSource(zip, isBsbChart, 'BSB charts');
    assert.equal(source.name, 'US_REGION_01');
    assert.deepEqual(source.looseFiles, []);
    assert.deepEqual(source.zips, [zip]);
  });

  it('explains a path with nothing to convert', async () => {
    const empty = path.join(TMP, 'empty');
    write(path.join(empty, 'notes.txt'));
    await assert.rejects(
      inspectLocalChartSource(empty, isS57Cell, 'S-57 cells'),
      (err: Error) => err instanceof LocalSourceError && /holds no S-57 cells/.test(err.message)
    );
    await assert.rejects(
      inspectLocalChartSource(path.join(TMP, 'missing'), isS57Cell, 'S-57 cells'),
      (err: Error) => err instanceof LocalSourceError && /does not exist/.test(err.message)
    );
    await assert.rejects(
      inspectLocalChartSource(path.join(empty, 'notes.txt'), isS57Cell, 'S-57 cells'),
      (err: Error) => err instanceof LocalSourceError && /not a folder or a ZIP/.test(err.message)
    );
  });
});

describe('inspectLocalChartSource and links', () => {
  it('finds only charts inside the chosen folder, never through a link out of it', async () => {
    const outside = path.join(TMP, 'links-outside');
    write(path.join(outside, 'US5OUT01.000'));
    const dir = path.join(TMP, 'links-root');
    write(path.join(dir, 'ENC_ROOT', 'US5IN001', 'US5IN001.000'));
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    fs.symlinkSync(outside, path.join(dir, 'ENC_ROOT', 'elsewhere'), 'junction');
    const source = await inspectLocalChartSource(dir, isS57Cell, 'S-57 cells');
    assert.deepEqual(source.looseFiles, [path.join(dir, 'ENC_ROOT', 'US5IN001', 'US5IN001.000')]);
    for (const file of source.looseFiles) {
      assert.ok(!path.relative(dir, file).startsWith('..'), `${file} is outside ${dir}`);
    }
  });
});

describe('extractLocalChartSource', () => {
  it('returns loose files in place and extracted ones, without touching the source', async () => {
    const dir = path.join(TMP, 'extract');
    write(path.join(dir, 'a', '13221_1.KAP'));
    write(
      path.join(dir, 'b.zip'),
      storedZip([
        { name: 'BSB_ROOT/14000/14000_1.KAP', data: Buffer.from('k') },
        { name: '../escape.kap', data: Buffer.from('e') }
      ])
    );
    const before = snapshot(dir);
    const source = await inspectLocalChartSource(dir, isBsbChart, 'BSB charts');
    const workDir = path.join(TMP, 'extract-work');
    const archives: string[] = [];
    const files = await extractLocalChartSource(source, isBsbChart, workDir, (zip) => {
      archives.push(zip);
    });
    assert.deepEqual(archives, [path.join(dir, 'b.zip')]);
    assert.deepEqual(files, [
      path.join(dir, 'a', '13221_1.KAP'),
      path.join(workDir, 'archive-1', 'BSB_ROOT', '14000', '14000_1.KAP')
    ]);
    assert.ok(!fs.existsSync(path.join(workDir, 'escape.kap')));
    assert.deepEqual(snapshot(dir), before);
  });
});

describe('processRncLocal', () => {
  it('reports a folder whose charts fail to convert, and leaves it unchanged', async () => {
    const dir = path.join(TMP, 'bad-rnc');
    write(path.join(dir, 'broken_1.kap'), 'not a chart');
    const before = snapshot(dir);
    const source = await inspectLocalChartSource(dir, isBsbChart, 'BSB charts');
    const out = path.join(TMP, 'bad-rnc-out');
    fs.mkdirSync(out);
    await assert.rejects(
      processRncLocal(source, path.join(TMP, 'bad-rnc-work'), out, 'bad-rnc', null),
      /No charts converted/
    );
    assert.equal(getRncProgress('bad-rnc')?.status, 'failed');
    assert.deepEqual(fs.readdirSync(out), []);
    assert.deepEqual(snapshot(dir), before);
  });
});

describe('uniqueCells', () => {
  it('keeps the first cell of each name', () => {
    const { kept, duplicates } = uniqueCells([
      '/charts/ENC_ROOT/US5MA1AA/US5MA1AA.000',
      '/work/archive-1/ENC_ROOT/US5MA2AA/US5MA2AA.000',
      '/work/archive-1/ENC_ROOT/US5MA1AA/us5ma1aa.000'
    ]);
    assert.deepEqual(kept, [
      '/charts/ENC_ROOT/US5MA1AA/US5MA1AA.000',
      '/work/archive-1/ENC_ROOT/US5MA2AA/US5MA2AA.000'
    ]);
    assert.deepEqual(duplicates, ['/work/archive-1/ENC_ROOT/US5MA1AA/us5ma1aa.000']);
  });
});
