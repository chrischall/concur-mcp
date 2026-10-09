import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiskReceiptOutput,
  InlineReceiptOutput,
  MAX_INLINE_BYTES,
  extensionForMime,
  makeReceiptOutput,
  uploadRoots,
} from '../src/receipt-files.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'concur-receipts-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('uploadRoots', () => {
  it('defaults to the cwd and the home Downloads/Documents/Desktop folders', () => {
    expect(uploadRoots({})).toEqual([
      process.cwd(),
      join(homedir(), 'Downloads'),
      join(homedir(), 'Documents'),
      join(homedir(), 'Desktop'),
    ]);
  });

  it('CONCUR_UPLOAD_ROOTS replaces the defaults (path-delimiter list, blanks dropped)', () => {
    expect(uploadRoots({ CONCUR_UPLOAD_ROOTS: '/a: /b ::' })).toEqual(['/a', '/b']);
  });

  it('a blank CONCUR_UPLOAD_ROOTS counts as unset — it can never disable confinement', () => {
    expect(uploadRoots({ CONCUR_UPLOAD_ROOTS: ' : ' })).toHaveLength(4);
  });

  it('hosted (MCP_DATA_DIR set, no override) confines to $MCP_DATA_DIR/uploads only', () => {
    expect(uploadRoots({ MCP_DATA_DIR: '/data' })).toEqual(['/data/uploads']);
  });
});

describe('extensionForMime', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['application/pdf', 'pdf'],
    ['image/tiff', 'tif'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['application/octet-stream', 'bin'],
  ])('%s → %s', (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });
});

describe('DiskReceiptOutput', () => {
  it('writes a private, never-overwriting file into CONCUR_OUTPUT_DIR', async () => {
    const dir = tmp();
    const out = new DiskReceiptOutput({ CONCUR_OUTPUT_DIR: dir });
    expect(out.persistsFiles).toBe(true);
    const bytes = new Uint8Array([1, 2, 3]);
    const first = await out.save({ baseName: 'receipt-IMG1', extension: 'png', bytes });
    const second = await out.save({ baseName: 'receipt-IMG1', extension: 'png', bytes });
    expect(first).toBe(join(dir, 'receipt-IMG1.png'));
    expect(second).toBe(join(dir, 'receipt-IMG1-2.png'));
    expect(new Uint8Array(readFileSync(first!))).toEqual(bytes);
    expect(statSync(first!).mode & 0o077).toBe(0);
  });

  it('without CONCUR_OUTPUT_DIR saves to ~/Downloads/concur-mcp, never the cwd', async () => {
    const home = tmp();
    vi.stubEnv('HOME', home);
    try {
      const out = new DiskReceiptOutput({});
      const path = await out.save({ baseName: 'receipt-IMG1', extension: 'png', bytes: new Uint8Array([1]) });
      expect(path).toBe(join(home, 'Downloads', 'concur-mcp', 'receipt-IMG1.png'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a path-like base name cannot escape the directory', async () => {
    const dir = tmp();
    const out = new DiskReceiptOutput({ CONCUR_OUTPUT_DIR: dir });
    const path = await out.save({ baseName: '../../etc/x', extension: 'png', bytes: new Uint8Array([1]) });
    expect(path!.startsWith(dir)).toBe(true);
  });
});

describe('InlineReceiptOutput', () => {
  it('persists nothing', async () => {
    const out = new InlineReceiptOutput();
    expect(out.persistsFiles).toBe(false);
    await expect(out.save({ baseName: 'x', extension: 'png', bytes: new Uint8Array([1]) })).resolves.toBeUndefined();
  });

  it('MAX_INLINE_BYTES keeps a result under the hosted 14 MiB cap', () => {
    expect(MAX_INLINE_BYTES * (4 / 3)).toBeLessThan(14 * 1024 * 1024);
  });
});

describe('makeReceiptOutput', () => {
  it('defaults to disk locally', () => {
    expect(makeReceiptOutput({}).persistsFiles).toBe(true);
  });

  it('defaults to inline when hosted (MCP_DATA_DIR set)', () => {
    expect(makeReceiptOutput({ MCP_DATA_DIR: '/data' }).persistsFiles).toBe(false);
  });

  it('CONCUR_INLINE_RECEIPTS overrides either way', () => {
    expect(makeReceiptOutput({ CONCUR_INLINE_RECEIPTS: '1' }).persistsFiles).toBe(false);
    expect(makeReceiptOutput({ MCP_DATA_DIR: '/data', CONCUR_INLINE_RECEIPTS: 'false' }).persistsFiles).toBe(true);
  });
});
