import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INLINE_BYTES,
  RECEIPT_MIME_TYPES,
  UPLOAD_MIME_BY_EXT,
  extensionForMime,
  inlineReceiptsByDefault,
  receiptDownloadDir,
  uploadRoots,
} from '../src/receipt-files.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'concur-receipts-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('uploadRoots', () => {
  it('defaults to the cwd and the home Downloads/Documents/Desktop folders when the cwd is inside home', () => {
    const cwd = join(homedir(), 'projects', 'expenses');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    expect(uploadRoots({})).toEqual([
      cwd,
      join(homedir(), 'Downloads'),
      join(homedir(), 'Documents'),
      join(homedir(), 'Desktop'),
    ]);
  });

  // fleet-audit#1186: Claude Desktop starts .mcpb servers with cwd `/`, which
  // as a root would let an upload read any file on the machine.
  it.each([
    ['/ (Claude Desktop / .mcpb)', '/'],
    ['the home directory itself', homedir()],
    ['a folder outside home', '/opt/elsewhere'],
  ])('never uses the cwd as a root when it is %s', (_label, cwd) => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const roots = uploadRoots({});
    expect(roots).not.toContain(cwd);
    expect(roots).not.toContain('/');
    expect(roots).toEqual([
      join(homedir(), 'Downloads'),
      join(homedir(), 'Documents'),
      join(homedir(), 'Desktop'),
    ]);
  });

  it('CONCUR_UPLOAD_ROOTS replaces the defaults (path-delimiter list, blanks dropped)', () => {
    expect(uploadRoots({ CONCUR_UPLOAD_ROOTS: '/a: /b ::' })).toEqual(['/a', '/b']);
  });

  it('a blank CONCUR_UPLOAD_ROOTS counts as unset — it can never disable confinement', () => {
    expect(uploadRoots({ CONCUR_UPLOAD_ROOTS: ' : ' })).toEqual(uploadRoots({}));
    expect(uploadRoots({ CONCUR_UPLOAD_ROOTS: ' : ' }).length).toBeGreaterThanOrEqual(3);
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
    ['IMAGE/PNG; charset=binary', 'png'],
    // Since the move onto mcp-utils' extensionForMime (fleet-audit#1301): an
    // unlisted type is named by its subtype rather than `bin`.
    ['image/heic', 'heic'],
  ])('%s → %s', (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });
});

describe('the receipt types', () => {
  it('derive from the shared extension table: png / jpg / jpeg / pdf, no TIFF (vetUploadFile cannot verify its bytes)', () => {
    expect(UPLOAD_MIME_BY_EXT).toEqual({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' });
    expect([...RECEIPT_MIME_TYPES].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
  });

  it('MAX_INLINE_BYTES keeps a result under the hosted 14 MiB cap', () => {
    expect(MAX_INLINE_BYTES * (4 / 3)).toBeLessThan(14 * 1024 * 1024);
  });
});

describe('receiptDownloadDir', () => {
  it('is CONCUR_OUTPUT_DIR when set', () => {
    const dir = tmp();
    expect(receiptDownloadDir({ CONCUR_OUTPUT_DIR: dir })).toBe(dir);
  });

  it('otherwise ~/Downloads/concur-mcp, never the cwd', () => {
    const home = tmp();
    vi.stubEnv('HOME', home);
    try {
      expect(receiptDownloadDir({})).toBe(join(home, 'Downloads', 'concur-mcp'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('inlineReceiptsByDefault', () => {
  it('is off locally', () => {
    expect(inlineReceiptsByDefault({})).toBe(false);
  });

  it('is on when hosted (MCP_DATA_DIR or a blob store)', () => {
    expect(inlineReceiptsByDefault({ MCP_DATA_DIR: '/data' })).toBe(true);
    expect(inlineReceiptsByDefault({ MCP_BLOB_BASE_URL: 'https://blob.example.test/b/reg' })).toBe(true);
  });

  it('CONCUR_INLINE_RECEIPTS overrides either way', () => {
    expect(inlineReceiptsByDefault({ CONCUR_INLINE_RECEIPTS: '1' })).toBe(true);
    expect(inlineReceiptsByDefault({ MCP_DATA_DIR: '/data', CONCUR_INLINE_RECEIPTS: 'false' })).toBe(false);
  });
});
