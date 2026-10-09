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

import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { parseBoolEnv, readEnvVar, resolveOutputDir, writeUniqueFile } from '@chrischall/mcp-utils';
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
 * - unset, locally → the cwd and `~/Downloads`, `~/Documents`, `~/Desktop`.
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
  return [process.cwd(), join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Desktop')];
}

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'application/pdf': 'pdf',
};

/** File extension (no dot) for a receipt's MIME type; `bin` when unknown. */
export function extensionForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
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
