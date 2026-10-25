import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { holdWorkDir, releaseWorkDir, sweepLeftoverTempDirs } from '../dist/utils/temp-dirs.js';

describe('sweepLeftoverTempDirs', () => {
  it('removes left-over work folders, but not one still in use or anything else', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-charts-temp-'));
    try {
      const names = [
        'convert-local-a1B2c3',
        'convert-local-Zz9yX8',
        'convert-upload-1700000000000',
        's57-download-1700000000001',
        'custom-catalogs',
        'chart-set-cache',
        'convert-local-'
      ];
      for (const name of names) {
        fs.mkdirSync(path.join(dataDir, name));
      }
      fs.writeFileSync(path.join(dataDir, 'convert-upload-1'), 'a file, not a folder');

      const active = path.join(dataDir, 'convert-local-Zz9yX8');
      holdWorkDir(active);
      try {
        assert.deepEqual(sweepLeftoverTempDirs(dataDir).sort(), [
          'convert-local-a1B2c3',
          'convert-upload-1700000000000',
          's57-download-1700000000001'
        ]);
        assert.deepEqual(fs.readdirSync(dataDir).sort(), [
          'chart-set-cache',
          'convert-local-',
          'convert-local-Zz9yX8',
          'convert-upload-1',
          'custom-catalogs'
        ]);
      } finally {
        releaseWorkDir(active);
      }

      // Once released, a later start removes it.
      assert.deepEqual(sweepLeftoverTempDirs(dataDir), ['convert-local-Zz9yX8']);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
