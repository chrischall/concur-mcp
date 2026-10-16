// The receipt tools' local-file boundary: where an upload may be read from,
// and where a downloaded receipt goes.
//
// Uploads: `concur_upload_receipt` takes a model-supplied path, so it is vetted
// with mcp-utils `vetUploadFile` against operator-configured roots
// (`CONCUR_UPLOAD_ROOTS`) — never a tool argument.
//
// Downloads: an injectable output with a `persistsFiles` flag. Locally the
// server's disk IS the user's, so a receipt is written (never overwriting) to
// `CONCUR_OUTPUT_DIR` (else `~/Downloads/concur-mcp`). Hosted, the disk is the runner's and the
// user can never open a path on it, so the inline output writes nothing and the
// tool returns the bytes in the result instead of claiming "saved to <path>".

import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  extensionForMime as sharedExtensionForMime,
  parseBoolEnv,
  readEnvVar,
  resolveOutputDir,
  writeUniqueFile,
} from '@chrischall/mcp-utils';
import type { EnvSource } from './config.js';

/**
 * What `concur_upload_receipt` accepts, as the MIME type it sends. The web app
 * also takes tif/tiff, but `vetUploadFile` refuses any type whose magic bytes it
 * cannot verify, and it has no TIFF signature — so TIFF is not offered.
 */
export const UPLOAD_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
};

/** Largest receipt uploaded or downloaded. */
export const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

/**
 * Largest receipt returned inline. 10 MiB raw is ~13.3 MiB base64, under
 * mcp-host's 14 MiB per-result cap, so the tool's own note fires first.
 */
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;

/**
 * The folders an upload path must resolve inside:
 * - `CONCUR_UPLOAD_ROOTS` set → exactly those (a path-delimiter list, `~` expanded);
 * - unset, hosted (`MCP_DATA_DIR` set) → only `$MCP_DATA_DIR/uploads`;
 * - unset, locally → `~/Downloads`, `~/Documents`, `~/Desktop`, plus the cwd
 *   only when it is a folder INSIDE home (Claude Code's project dir). Claude
 *   Desktop starts .mcpb servers with cwd `/`, and `/` (or home itself, or a
 *   folder elsewhere) as a root would let an upload read nearly any file.
 * A blank or delimiter-only value counts as unset, so it can never disable confinement.
 */
export function uploadRoots(env: EnvSource = process.env): string[] {
  const configured = (readEnvVar('CONCUR_UPLOAD_ROOTS', { env }) ?? '')
    .split(delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const dataDir = readEnvVar('MCP_DATA_DIR', { env });
  if (dataDir) return [join(dataDir, 'uploads')];
  const home = homedir();
  const defaults = [join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Desktop')];
  const cwd = process.cwd();
  return isStrictlyInside(cwd, home) ? [cwd, ...defaults] : defaults;
}

/** True when `dir` is a folder below `parent` (not `parent` itself, not outside it). */
function isStrictlyInside(dir: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * File extension (no dot) for a receipt's MIME type — mcp-utils'
 * `extensionForMime` (fleet-audit#1301): known types by table (`image/jpeg` →
 * `jpg`, `image/tiff` → `tif`), else a plain subtype, else `bin`. Always a safe
 * extension for `writeUniqueFile`.
 */
export function extensionForMime(mime: string): string {
  return sharedExtensionForMime(mime);
}

export interface ReceiptFileToSave {
  baseName: string;
  extension: string;
  bytes: Uint8Array;
}

/** Where a downloaded receipt goes. */
export interface ReceiptOutput {
  /** True when `save` puts a file the user can open; false when the tool must answer inline. */
  readonly persistsFiles: boolean;
  /** Save the file; the path written, or undefined when nothing persists. */
  save(file: ReceiptFileToSave): Promise<string | undefined>;
}

/** Writes to `CONCUR_OUTPUT_DIR` (else `~/Downloads/concur-mcp`), owner-only, never overwriting. */
export class DiskReceiptOutput implements ReceiptOutput {
  readonly persistsFiles = true;

  constructor(private readonly env: EnvSource = process.env) {}

  async save(file: ReceiptFileToSave): Promise<string> {
    // Resolved per call (it creates the directory) — never at boot.
    const dir = resolveOutputDir(undefined, 'CONCUR_OUTPUT_DIR', { env: this.env, name: 'concur-mcp' });
    return writeUniqueFile({ dir, baseName: file.baseName, extension: file.extension, bytes: file.bytes, mode: 0o600 });
  }
}

/** Persists nothing: the tool returns the receipt in its result. */
export class InlineReceiptOutput implements ReceiptOutput {
  readonly persistsFiles = false;

  async save(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Disk locally; inline when hosted (`MCP_DATA_DIR` set). `CONCUR_INLINE_RECEIPTS`
 * overrides either way.
 */
export function makeReceiptOutput(env: EnvSource = process.env): ReceiptOutput {
  const hosted = Boolean(readEnvVar('MCP_DATA_DIR', { env }));
  return parseBoolEnv('CONCUR_INLINE_RECEIPTS', { env, default: hosted })
    ? new InlineReceiptOutput()
    : new DiskReceiptOutput(env);
}
