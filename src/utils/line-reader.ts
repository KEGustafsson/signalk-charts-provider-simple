import fs from 'node:fs';

/**
 * Read `file` line by line in large chunks: far cheaper than readline, and
 * without holding a whole file as one string (GDAL's line-delimited output
 * for a large cell can pass V8's string size limit). Empty lines are skipped.
 */
export function forEachLine(
  file: string,
  onLine: (line: string) => void,
  chunkBytes = 16 * 1024 * 1024
): void {
  const fd = fs.openSync(file, 'r');
  try {
    // Sized to the file: most files are small, and each read fills the
    // buffer before any of it is used, so it needs no zeroing.
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, size)));
    // The partial last line of a read, kept as bytes: the read boundary may
    // fall inside a multi-byte character, so only whole lines are decoded.
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) {
        break;
      }
      const end = chunk.lastIndexOf(0x0a, n - 1);
      if (end < 0) {
        carry = Buffer.concat([carry, chunk.subarray(0, n)]);
        continue;
      }
      const text = Buffer.concat([carry, chunk.subarray(0, end)]).toString('utf8');
      carry = Buffer.from(chunk.subarray(end + 1, n));
      for (const line of text.split('\n')) {
        if (line) {
          onLine(line);
        }
      }
    }
    if (carry.length > 0) {
      onLine(carry.toString('utf8'));
    }
  } finally {
    fs.closeSync(fd);
  }
}
