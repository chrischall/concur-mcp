// The receipt tools' file boundary: which files an upload may be, where an
// upload path may be read from, and where a downloaded receipt goes.
//
// Uploads arrive by path (local installs only — vetted against
// operator-configured roots, `CONCUR_UPLOAD_ROOTS`, never a tool argument),
// inline base64, or an upload-slot blobKey; mcp-utils `resolveUploadSource`
// validates all three the same way.
//
// Downloads go through mcp-utils `deliverFile`: inline when they fit, else a
// signed link when hosted (the runner's disk is nobody's), else a file under
// `CONCUR_OUTPUT_DIR` (else `~/Downloads/concur-mcp`) locally.

import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { extensionForMime as sharedExtensionForMime, parseBoolEnv, readEnvVar, resolveOutputDir } from '@chrischall/mcp-utils';
import { INLINE_DELIVERY_MAX_BYTES, isHostedEnv, mimeFromFileName } from '@chrischall/mcp-utils/export';
import type { EnvSource } from './config.js';

/**
 * The extensions `concur_upload_receipt` accepts. The web app also takes
 * tif/tiff, but the upload check refuses any type whose magic bytes it cannot
 * verify, and it has no TIFF signature — so TIFF is not offered.
 */
const RECEIPT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf'] as const;

/** Extension → MIME type for an upload path, from the shared mcp-utils table. */
export const UPLOAD_MIME_BY_EXT: Readonly<Record<string, string>> = Object.fromEntries(
  RECEIPT_EXTENSIONS.map((ext) => [ext, mimeFromFileName(`receipt.${ext}`)]),
);

/** The MIME types an upload may be, by any route. */
export const RECEIPT_MIME_TYPES: readonly string[] = [...new Set(Object.values(UPLOAD_MIME_BY_EXT))];

/** Largest receipt uploaded or downloaded. */
export const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

/**
 * Largest receipt returned inline. 10 MiB raw is ~13.3 MiB base64, under
 * mcp-host's 14 MiB per-result cap, so the tool's own note fires first.
 */
export const MAX_INLINE_BYTES = INLINE_DELIVERY_MAX_BYTES;

/**
 * The folders an upload path must resolve inside:
 * - `CONCUR_UPLOAD_ROOTS` set → exactly those (a path-delimiter list, `~` expanded);
 * - unset, hosted (`MCP_DATA_DIR` set) → only `$MCP_DATA_DIR/uploads` (defence in
 *   depth: a hosted server refuses every upload path before this is consulted);
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

/** Where a local install saves a downloaded receipt: `CONCUR_OUTPUT_DIR`, else `~/Downloads/concur-mcp` (created). */
export function receiptDownloadDir(env: EnvSource = process.env): string {
  return resolveOutputDir(undefined, 'CONCUR_OUTPUT_DIR', { env, name: 'concur-mcp' });
}

/**
 * Whether `concur_get_receipt` answers inline by default: on when hosted (the
 * runner's disk is not the user's), off locally. `CONCUR_INLINE_RECEIPTS`
 * overrides either way.
 */
export function inlineReceiptsByDefault(env: EnvSource = process.env): boolean {
  return parseBoolEnv('CONCUR_INLINE_RECEIPTS', { env, default: isHostedEnv(env) });
}
