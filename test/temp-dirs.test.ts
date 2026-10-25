import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sweepLeftoverTempDirs } from '../dist/utils/temp-dirs.js';

describe('sweepLeftoverTempDirs', () => {
  it('removes left-over work folders at the first start only', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-temp-'));
    try {
      for (const name of [
        'convert-local-a1B2c3',
        'convert-upload-1700000000000',
        's57-download-1700000000001',
        'custom-catalogs',
        'chart-set-cache',
        'convert-local-'
      ]) {
        fs.mkdirSync(path.join(dataDir, name));
      }
      fs.writeFileSync(path.join(dataDir, 'convert-upload-1'), 'a file, not a folder');

      assert.deepEqual(sweepLeftoverTempDirs(dataDir).sort(), [
        'convert-local-a1B2c3',
        'convert-upload-1700000000000',
        's57-download-1700000000001'
      ]);
      assert.deepEqual(fs.readdirSync(dataDir).sort(), [
        'chart-set-cache',
        'convert-local-',
        'convert-upload-1',
        'custom-catalogs'
      ]);

      // A plugin restart (a config save) while a download or conversion runs
      // leaves its work folder alone.
      fs.mkdirSync(path.join(dataDir, 'rnc-download-1700000000002'));
      fs.mkdirSync(path.join(dataDir, 'convert-local-Zz9yX8'));
      assert.deepEqual(sweepLeftoverTempDirs(dataDir), []);
      assert.ok(fs.existsSync(path.join(dataDir, 'rnc-download-1700000000002')));
      assert.ok(fs.existsSync(path.join(dataDir, 'convert-local-Zz9yX8')));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
