// Receipts: upload, list, get (download), attach / append / detach on an
// expense, and delete. Every Concur write is confirm-gated and RE-READS
// afterwards, answering with what Concur now shows. `concur_get_receipt` only
// hands the file to the caller (inline, a signed link, or a LOCAL file), so it
// is not gated; neither is `concur_upload_slots`, which only signs PUT URLs.

import { chmod } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  messageOf,
  minifiedResult,
  sniffMimeBytes,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import {
  MAX_UPLOAD_FILES,
  blobStoreFromEnv,
  deliverFile,
  inlineFileSchema,
  isHostedEnv,
  mintUploadSlot,
  resolveUploadMime,
  resolveUploadSource,
  sanitizeUploadFilename,
  uploadSlotRequestSchema,
  type BlobStore,
  type DeliveredFile,
  type UploadRelease,
} from '@chrischall/mcp-utils/export';
import { warningsField, type ConcurClient } from '../client.js';
import { GET_EXPENSE } from '../graphql/expenses.js';
import {
  APPEND_RECEIPT,
  ATTACH_RECEIPT,
  DELETE_RECEIPT,
  DETACH_RECEIPT,
  GET_RECEIPT,
  LIST_AVAILABLE_RECEIPTS,
} from '../graphql/receipts.js';
import {
  MAX_INLINE_BYTES,
  MAX_RECEIPT_BYTES,
  RECEIPT_MIME_TYPES,
  UPLOAD_MIME_BY_EXT,
  extensionForMime,
  inlineReceiptsByDefault,
  receiptDownloadDir,
  uploadRoots,
} from '../receipt-files.js';
import { EXPENSE_ESSENTIAL, compactExpense, expenseIdParam, type ExpenseData } from './expenses.js';
import { reportIdParam } from './reports.js';
import { CONTEXT_ROLE, concurView, prune, respond, trueFlags, verify } from './shared.js';
import { CHANGE, LOOKUP } from './hints.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

// ── shapes ────────────────────────────────────────────────────────────────

export interface Receipt {
  imageId?: string | null;
  receiptId?: string | null;
  fileType?: string | null;
  imageDate?: string | null;
  fileName?: string | null;
  imageOrigin?: string | null;
  imageUrl?: string | null;
  thumbUrl?: string | null;
  receiptDigitizationStatus?: string | null;
  complianceCountryCode?: string | null;
  complianceType?: string | null;
  meta?: Record<string, boolean | null> | null;
}

interface AvailableReceiptsData {
  employee: { userId?: string; availableReceipts: Receipt[] | null } | null;
}

interface ReceiptData {
  employee: { userId?: string; lineItemImage: Receipt | null } | null;
}

type EntryImageField = 'attachImage' | 'appendImage' | 'detachImage';

type EntryImageData = {
  employee: {
    expenseReport: {
      entry: Partial<Record<EntryImageField, { id?: string | null; receiptImageId?: string | null } | null>> | null;
    } | null;
  } | null;
};

// ── params ────────────────────────────────────────────────────────────────

const imageIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'a Concur receipt image id')
  .describe('Receipt image id (`imageId` from concur_list_available_receipts, or `receiptImageId` on an expense).');

// ── projections ───────────────────────────────────────────────────────────

/** The compact rung: no signed URLs, the true permission flags by name. */
export function compactReceipt(r: Receipt) {
  return prune({
    imageId: r.imageId,
    receiptId: r.receiptId,
    fileName: r.fileName,
    fileType: r.fileType,
    date: r.imageDate,
    origin: r.imageOrigin,
    status: r.receiptDigitizationStatus,
    allowed: trueFlags(r.meta),
  });
}

/** The receipt store is the point of the call: a partial answer without it is an error. */
const RECEIPTS_ESSENTIAL = { essential: ['employee.availableReceipts'] } as const;

function availableReceiptsOf(data: AvailableReceiptsData): Receipt[] {
  if (!data.employee) throw new McpToolError('SAP Concur returned no employee record for the signed-in user.');
  return data.employee.availableReceipts ?? [];
}

// ── reads ─────────────────────────────────────────────────────────────────

async function readAvailableReceipts(client: ConcurClient, userId: string): Promise<Receipt[]> {
  return availableReceiptsOf(
    await client.spend<AvailableReceiptsData>(LIST_AVAILABLE_RECEIPTS, { userId, contextRole: CONTEXT_ROLE }, RECEIPTS_ESSENTIAL),
  );
}

async function readExpense(client: ConcurClient, userId: string, reportId: string, expenseId: string) {
  return compactExpense(
    await client.spend<ExpenseData>(GET_EXPENSE, {
      expenseId,
      reportId,
      userId,
      contextRole: CONTEXT_ROLE,
      expenseIdAsID: expenseId,
      reportIdAsID: reportId,
      userIdAsID: userId,
    }, EXPENSE_ESSENTIAL),
  );
}

type ObservedExpense = Awaited<ReturnType<typeof readExpense>>;

const receiptOf = (e: ObservedExpense): string | undefined => e.expense.receiptImageId ?? undefined;

/** The expense as the preview / answer shows it. */
const expenseSummary = (e: ObservedExpense) =>
  prune({
    expenseId: e.expense.expenseId,
    date: e.expense.date,
    expenseType: e.expense.expenseType,
    vendor: e.expense.vendor,
    amount: e.expense.amount,
    receiptImageId: receiptOf(e),
    reportId: e.report.reportId,
    report: e.report.name,
  });

/** Run AttachImage / AppendImage / DetachImage on one entry; answers the mutation's own response (+ warnings). */
async function entryImage(
  client: ConcurClient,
  field: EntryImageField,
  vars: { userId: string; reportId: string; expenseId: string; imageId?: string },
) {
  const doc = field === 'attachImage' ? ATTACH_RECEIPT : field === 'appendImage' ? APPEND_RECEIPT : DETACH_RECEIPT;
  const res = await client.spend<EntryImageData>(doc, { ...vars, contextRole: CONTEXT_ROLE });
  const response = res.employee?.expenseReport?.entry?.[field];
  if (!response) {
    throw new McpToolError(`SAP Concur did not confirm the ${field} change.`, {
      hint: 'Re-read the expense with concur_get_expense before retrying.',
    });
  }
  return { response, ...warningsField(res) };
}

/** Attaching onto an expense that already has a receipt is refused unless the caller asked to append. */
function attachField(current: string | undefined, append: boolean, expenseId: string): EntryImageField {
  if (append) return current ? 'appendImage' : 'attachImage';
  if (current) {
    throw new McpToolError(`Expense ${expenseId} already has a receipt (image ${current}).`, {
      hint: 'Pass append: true to add this image to it, or remove it first with concur_detach_receipt.',
    });
  }
  return 'attachImage';
}

// ── registration ──────────────────────────────────────────────────────────

export interface ReceiptToolOptions {
  /** The folders an upload path may come from. Default: {@link uploadRoots} from the env (read per call). */
  roots?: () => readonly string[];
  /** What a relative upload path resolves against. Default: the cwd. */
  baseDir?: string;
  /** True on a hosted deployment (upload paths refused, nothing saved to disk). Default: mcp-utils `isHostedEnv`. */
  hosted?: () => boolean;
  /** The mcp-host blob store (upload slots, download links). Default: mcp-utils `blobStoreFromEnv`. */
  store?: () => BlobStore | undefined;
  /** Whether concur_get_receipt answers inline unless told otherwise. Default: {@link inlineReceiptsByDefault}. */
  inlineByDefault?: () => boolean;
  /** Where a local install saves a download. Default: {@link receiptDownloadDir} (created on first use). */
  downloadDir?: () => string;
}

const SLOT_TOOL = 'concur_upload_slots';

/** The blob-store cleanup after an upload, for the answer: nothing for a path / inline upload. */
function releaseField(released: UploadRelease) {
  if (released.deleted === null) return {};
  return released.deleted ? { blobDeleted: true } : { blobDeleted: false, blobDeleteError: released.error };
}

/** The receipt-tool registrar, with its file boundary injectable (tests, hosting). */
export function makeReceiptTools(opts: ReceiptToolOptions = {}) {
  return function registerReceiptTools(server: McpServer, client: ConcurClient): void {
    const roots = opts.roots ?? (() => uploadRoots());
    const hosted = opts.hosted ?? (() => isHostedEnv());
    const storeOf = opts.store ?? (() => blobStoreFromEnv());
    const inlineByDefault = opts.inlineByDefault ?? (() => inlineReceiptsByDefault());
    const downloadDir = opts.downloadDir ?? (() => receiptDownloadDir());
    const types = Object.keys(UPLOAD_MIME_BY_EXT).join(', ');

    server.registerTool(
      'concur_list_available_receipts',
      {
        description:
          'List the receipt images in your SAP Concur receipt store — uploaded or emailed receipts not attached to ' +
          'any expense. Attach one with concur_attach_receipt, download it with concur_get_receipt, or delete it ' +
          'with concur_delete_receipt. ' +
          UNTRUSTED_DESCRIPTION_SUFFIX,
        annotations: toolAnnotations({ title: 'List Concur available receipts', readOnly: true, openWorld: true }),
        _meta: LOOKUP,
        inputSchema: z.object({
          view: concurView('compact drops the signed image/thumbnail URLs and lists only the permissions that are true.'),
        }),
      },
      async ({ view }) => {
        const data = await client.spend<AvailableReceiptsData>(
          LIST_AVAILABLE_RECEIPTS,
          { userId: await client.userId(), contextRole: CONTEXT_ROLE },
          RECEIPTS_ESSENTIAL,
        );
        availableReceiptsOf(data);
        return respond(
          view,
          data,
          {
            compact: (d) => {
              const receipts = availableReceiptsOf(d).map(compactReceipt);
              return { count: receipts.length, receipts };
            },
            full: (d) => ({ receipts: availableReceiptsOf(d) }),
          },
          { context: 'concur_list_available_receipts', untrusted: true },
        );
      },
    );

    server.registerTool(
      'concur_get_receipt',
      {
        description:
          'Download one SAP Concur receipt image by id (from concur_list_available_receipts, or an expense’s ' +
          '`receiptImageId`). Locally it is saved, never overwriting, to CONCUR_OUTPUT_DIR (else ~/Downloads/' +
          'concur-mcp) and the path is returned; `inline: true` returns the image in the result instead (a PDF as ' +
          'an embedded resource). On a hosted server nothing is saved: it comes back inline, or — over 10 MiB — as ' +
          'a signed download link that expires in an hour (`downloadUrl`; give it only to the user). Up to 25 MB. ' +
          'Pass `reportId` for a receipt on a report so its permissions are judged in that context. Nothing ' +
          'changes in Concur. ' +
          UNTRUSTED_DESCRIPTION_SUFFIX,
        annotations: toolAnnotations({
          title: 'Get a Concur receipt image',
          readOnly: false,
          destructive: false,
          openWorld: true,
        }),
        _meta: LOOKUP,
        inputSchema: z.object({
          imageId: imageIdParam,
          reportId: reportIdParam.optional(),
          inline: z.boolean().default(false).describe('Return the image in the result instead of saving a file.'),
          view: concurView('compact drops the signed image/thumbnail URLs and lists only the permissions that are true.'),
        }),
      },
      async ({ imageId, reportId, inline, view }) => {
        const data = await client.spend<ReceiptData>(GET_RECEIPT, {
          userId: await client.userId(),
          contextRole: CONTEXT_ROLE,
          imageId,
          ...(reportId ? { reportId } : {}),
        }, { essential: ['employee.lineItemImage'] });
        const receipt = data.employee?.lineItemImage;
        if (!receipt) {
          throw new McpToolError(`SAP Concur returned no receipt image ${imageId} for the signed-in user.`, {
            hint: 'Check the id with concur_list_available_receipts or the expense’s receiptImageId.',
          });
        }
        if (!receipt.imageUrl) {
          throw new McpToolError(`SAP Concur returned no downloadable image for receipt ${imageId}.`, {
            hint: 'It may still be processing — try again shortly, or open it in the Concur web app.',
          });
        }

        const { bytes, contentType } = await client.download(receipt.imageUrl, { maxBytes: MAX_RECEIPT_BYTES });
        const mimeType = sniffMimeBytes(bytes) ?? contentType ?? 'application/octet-stream';
        const fileName = `receipt-${imageId}.${extensionForMime(mimeType)}`;

        const isHosted = hosted();
        const wantInline = inline || inlineByDefault();
        // Only a local install that will actually write needs (and creates) the download folder.
        const needsDisk = !isHosted && !(wantInline && bytes.byteLength <= MAX_INLINE_BYTES);
        let delivered: DeliveredFile | undefined;
        let notice: string | undefined;
        try {
          delivered = await deliverFile({
            bytes,
            fileName,
            mimeType,
            prefer: wantInline ? 'inline' : 'disk',
            store: storeOf() ?? null,
            keyPrefix: 'files',
            inlineMaxBytes: MAX_INLINE_BYTES,
            ...(needsDisk ? { disk: { dir: downloadDir() } } : {}),
          });
        } catch (err) {
          // Hosted with no blob store and over the inline cap: no route to the bytes, but
          // the receipt's details still answer the call.
          if (!(err instanceof McpToolError) || err.kind !== 'too_large') throw err;
          notice = `${err.message} Open it in the Concur web app.`;
        }
        // A receipt is private: owner-only, like every file this server writes.
        if (delivered?.path) await chmod(delivered.path, 0o600);

        const shown = view === 'raw' ? data : view === 'full' ? receipt : compactReceipt(receipt);
        const result = untrustedResult(
          prune({
            receipt: shown,
            mimeType: delivered?.mimeType ?? mimeType,
            bytes: bytes.byteLength,
            via: delivered?.via,
            inline: (delivered?.content.length ?? 0) > 0,
            savedTo: delivered?.path,
            downloadUrl: delivered?.url,
            expiresAt: delivered?.expiresAt,
            notice: delivered?.note ?? notice,
            ...warningsField(data),
          }),
        );
        return delivered?.content.length ? { ...result, content: [...result.content, ...delivered.content] } : result;
      },
    );

    server.registerTool(
      SLOT_TOOL,
      {
        description:
          `Get upload URLs for receipt files (${types}; up to 25 MB each, at most ${MAX_UPLOAD_FILES} per call) ` +
          'so you can send them to concur_upload_receipt from anywhere — this is how to upload to a hosted ' +
          '(remote) server, which cannot read files on your machine. Each slot has a `curl` command: run it with ' +
          'the file\'s real path in place of the placeholder (it must send exactly the Content-Type shown), then ' +
          'call concur_upload_receipt with the slot\'s `blobKey`. The URLs expire in 30 minutes. Changes nothing ' +
          'in Concur. Needs the blob store a hosted deployment provides.',
        annotations: toolAnnotations({ title: 'Get Concur receipt upload URLs', readOnly: true, openWorld: false }),
        _meta: LOOKUP,
        inputSchema: z.object({
          files: z
            .array(uploadSlotRequestSchema)
            .min(1)
            .max(MAX_UPLOAD_FILES)
            .describe('The receipt files to upload, by name (and optionally MIME type).'),
        }),
      },
      async ({ files }) => {
        const store = storeOf();
        if (!store) {
          throw new McpToolError('This server has no blob store, so it cannot hand out upload URLs.', {
            hint: 'Call concur_upload_receipt with `path` (a file on this machine) or `inline` (base64) instead.',
          });
        }
        // Check every file before minting any, so a refusal leaves no half-used slots behind.
        for (const f of files) {
          const name = sanitizeUploadFilename(f.filename);
          const type = resolveUploadMime(name, f.mimeType);
          if (!RECEIPT_MIME_TYPES.includes(type)) {
            throw new McpToolError(`${name}: ${type} is not accepted here (accepted: ${RECEIPT_MIME_TYPES.join(', ')}).`);
          }
        }
        return minifiedResult({
          slots: files.map((f) => mintUploadSlot(store, f)),
          next: 'PUT each file with its curl command, then call concur_upload_receipt with that slot\'s blobKey (one per call).',
        });
      },
    );

    server.registerTool(
      'concur_upload_receipt',
      {
        description:
          `Upload a receipt file (${types}; up to 25 MB) to SAP Concur. Pass exactly one of: \`path\` — a file on ` +
          'this computer, inside the allowed upload folders (CONCUR_UPLOAD_ROOTS when set, otherwise the working ' +
          'directory, ~/Downloads, ~/Documents or ~/Desktop) — local installs only; `inline` — the bytes as base64, ' +
          `for a small file; or \`blobKey\` — a file PUT to an upload URL from ${SLOT_TOOL} (the way to send a ` +
          'file to a hosted server). Its contents must match its type; anything else is refused before a byte is ' +
          'sent. With `reportId` + `expenseId` it is attached to that expense straight away (`append: true` adds ' +
          'it to a receipt the expense already has); otherwise it lands in your available receipts. The preview ' +
          'names the file, its size and SHA-256, and the target expense; an upload-slot file is deleted from the ' +
          'slot once Concur has it. ' +
          GATE,
        // Destructive because `append: true` adds a page no tool can take back off (see concur_append_receipt).
        annotations: toolAnnotations({ title: 'Upload a Concur receipt', readOnly: false, destructive: true, openWorld: true }),
        _meta: CHANGE,
        inputSchema: z.object({
          path: z
            .string()
            .min(1)
            .optional()
            .describe('Local file path (a leading ~ is expanded; relative paths resolve against the working directory). Local installs only.'),
          inline: inlineFileSchema.optional().describe('The file itself: {filename, contentBase64, mimeType?}. Best for small files.'),
          blobKey: z
            .string()
            .min(1)
            .optional()
            .describe(`The blobKey of an upload slot from ${SLOT_TOOL}, after the file was PUT to its URL.`),
          reportId: reportIdParam.optional().describe('Report holding `expenseId` — attach the receipt to that expense.'),
          expenseId: expenseIdParam.optional().describe('Expense to attach the receipt to (needs `reportId`).'),
          append: z
            .boolean()
            .default(false)
            .describe('When the expense already has a receipt, add this image to it instead of refusing.'),
          confirmToken: confirmTokenParam,
        }),
      },
      async ({ path, inline, blobKey, reportId, expenseId, append, confirmToken }, ctx) => {
        if (Boolean(reportId) !== Boolean(expenseId)) {
          throw new McpToolError('Pass both `reportId` and `expenseId` to attach the receipt, or neither.', {
            hint: 'Find the ids with concur_get_report.',
          });
        }
        // Read (never consume) on BOTH phases: the confirmed call re-reads, and a changed
        // file has a different SHA-256, which the token binds.
        const src = await resolveUploadSource(
          { ...(path !== undefined ? { path } : {}), ...(inline !== undefined ? { inline } : {}), ...(blobKey !== undefined ? { blobKey } : {}) },
          {
            maxBytes: MAX_RECEIPT_BYTES,
            allowedMimeTypes: RECEIPT_MIME_TYPES,
            path: {
              mimeByExt: UPLOAD_MIME_BY_EXT,
              allowedRoots: roots(),
              ...(opts.baseDir ? { baseDir: opts.baseDir } : {}),
              denyHiddenSegments: true,
            },
            store: storeOf() ?? null,
            hosted: hosted(),
            names: { slotTool: SLOT_TOOL },
          },
        );
        const userId = await client.userId();
        const filename = src.fileName;

        let before: ObservedExpense | undefined;
        let field: EntryImageField | undefined;
        if (reportId && expenseId) {
          before = await readExpense(client, userId, reportId, expenseId);
          field = attachField(receiptOf(before), append, expenseId);
        }

        const gate = await confirmWrite(ctx, {
          tool: 'concur_upload_receipt',
          action: 'concur.receipt.upload',
          summary: before
            ? `Upload ${filename} to Concur and ${field === 'appendImage' ? 'append it to' : 'attach it to'} expense ${expenseId}`
            : `Upload ${filename} to your Concur available receipts`,
          account: userId,
          target: expenseId ?? '',
          revision: src.sha256,
          payload: {
            source: src.origin,
            file: path ?? src.blobKey ?? filename,
            size: src.sizeBytes,
            mimeType: src.mimeType,
            sha256: src.sha256,
            reportId,
            expenseId,
            field,
          },
          preview: prune({
            file: prune({ source: src.origin, path, name: filename, size: src.sizeBytes, mimeType: src.mimeType, sha256: src.sha256 }),
            attachTo: before ? expenseSummary(before) : undefined,
            mode: field,
          }),
          confirmToken,
        });
        if (gate) return gate;

        const uploaded = await client.upload({ data: src.bytes, filename, contentType: src.mimeType });

        // From here the upload has happened: nothing below may turn it into an error.
        // Concur has the receipt, so the upload slot's copy goes (release never throws).
        const cleanup = releaseField(await src.release());
        if (reportId && expenseId && field) {
          let attach: Awaited<ReturnType<typeof entryImage>>;
          try {
            attach = await entryImage(client, field, { userId, reportId, expenseId, imageId: uploaded.imageId });
          } catch (err) {
            return untrustedResult({
              uploaded: true,
              imageId: uploaded.imageId,
              response: uploaded,
              attached: false,
              attachError: `Attaching it to expense ${expenseId} failed: ${messageOf(err)}`,
              next: `The receipt is in your available receipts; attach it with concur_attach_receipt (imageId ${uploaded.imageId}) — do not upload it again.`,
              ...cleanup,
            });
          }
          const { response: attached, ...attachWarnings } = attach;
          return untrustedResult({
            uploaded: true,
            imageId: uploaded.imageId,
            attached: true,
            response: { upload: uploaded, [field]: attached },
            ...cleanup,
            ...attachWarnings,
            ...(await verify(async () => {
              const after = await readExpense(client, userId, reportId, expenseId);
              const now = receiptOf(after);
              return prune({
                receiptImageId: now,
                observed:
                  now !== undefined
                    ? `the expense now shows receipt image ${now}`
                    : 'Concur accepted the attach but the expense shows no receipt yet — re-read it with concur_get_expense shortly',
                expense: expenseSummary(after),
              });
            })),
          });
        }

        return untrustedResult({
          uploaded: true,
          imageId: uploaded.imageId,
          response: uploaded,
          ...cleanup,
          ...(await verify(async () => {
            const available = await readAvailableReceipts(client, userId);
            const landed = available.find((r) => r.imageId === uploaded.imageId);
            return prune({
              inAvailableReceipts: landed !== undefined,
              observed: landed
                ? 'the receipt is in your available receipts'
                : 'Concur accepted the upload (HTTP 202) but it is not in your available receipts yet — it may still be processing; check concur_list_available_receipts shortly',
              receipt: landed ? compactReceipt(landed) : undefined,
            });
          })),
        });
      },
    );

    const registerEntryImageTool = (
      name: 'concur_attach_receipt' | 'concur_append_receipt',
      field: 'attachImage' | 'appendImage',
    ) =>
      server.registerTool(
        name,
        {
          description:
            field === 'attachImage'
              ? 'Attach a receipt image already in SAP Concur (from concur_list_available_receipts, or uploaded with ' +
                'concur_upload_receipt) to an expense that has no receipt yet; an expense that already has one is ' +
                'refused (use concur_append_receipt, or concur_detach_receipt first). Undo with concur_detach_receipt. ' +
                'Re-reads the expense afterwards. ' +
                GATE
              : 'Add a receipt image already in SAP Concur (from concur_list_available_receipts) to the receipt an ' +
                'expense already has, as an extra page. Re-reads the expense afterwards. ' +
                GATE,
          annotations: toolAnnotations({
            title: field === 'attachImage' ? 'Attach a Concur receipt to an expense' : 'Append a Concur receipt to an expense',
            readOnly: false,
            // Attach has an inverse (concur_detach_receipt). Append does not: no tool takes a
            // single appended page back off — detach removes the whole receipt, original pages too.
            destructive: field === 'appendImage',
            openWorld: true,
          }),
          _meta: CHANGE,
          inputSchema: z.object({
            reportId: reportIdParam,
            expenseId: expenseIdParam,
            imageId: imageIdParam,
            confirmToken: confirmTokenParam,
          }),
        },
        async ({ reportId, expenseId, imageId, confirmToken }, ctx) => {
          const userId = await client.userId();
          const before = await readExpense(client, userId, reportId, expenseId);
          const current = receiptOf(before);
          if (field === 'attachImage') attachField(current, false, expenseId);
          else if (!current) {
            throw new McpToolError(`Expense ${expenseId} has no receipt to append to.`, {
              hint: 'Use concur_attach_receipt instead.',
            });
          }
          const variables = { userId, contextRole: CONTEXT_ROLE, reportId, expenseId, imageId };
          const gate = await confirmWrite(ctx, {
            tool: name,
            action: field === 'attachImage' ? 'concur.receipt.attach' : 'concur.receipt.append',
            summary: `${field === 'attachImage' ? 'Attach' : 'Append'} receipt image ${imageId} ${field === 'attachImage' ? 'to' : 'onto the receipt of'} expense ${expenseId}`,
            account: userId,
            target: expenseId,
            payload: variables,
            preview: { expense: expenseSummary(before), imageId },
            confirmToken,
          });
          if (gate) return gate;

          const change = await entryImage(client, field, { userId, reportId, expenseId, imageId });
          return untrustedResult({
            attached: true,
            reportId,
            expenseId,
            imageId,
            ...change,
            ...(await verify(async () => {
              const after = await readExpense(client, userId, reportId, expenseId);
              const now = receiptOf(after);
              return prune({
                receiptImageId: now,
                observed:
                  now !== undefined
                    ? `the expense now shows receipt image ${now}`
                    : 'Concur accepted the change but the expense shows no receipt — re-read it with concur_get_expense',
                expense: expenseSummary(after),
              });
            })),
          });
        },
      );

    registerEntryImageTool('concur_attach_receipt', 'attachImage');
    registerEntryImageTool('concur_append_receipt', 'appendImage');

    server.registerTool(
      'concur_detach_receipt',
      {
        description:
          'Take the receipt image off an expense on an unsubmitted SAP Concur report (re-attach one with ' +
          'concur_attach_receipt). The preview shows the expense and the image it carries. Re-reads the expense and ' +
          'your available receipts afterwards and reports whether the image went back to the receipt store. ' +
          GATE,
        annotations: toolAnnotations({ title: 'Detach a Concur receipt from an expense', readOnly: false, destructive: false, openWorld: true }),
        _meta: CHANGE,
        inputSchema: z.object({ reportId: reportIdParam, expenseId: expenseIdParam, confirmToken: confirmTokenParam }),
      },
      async ({ reportId, expenseId, confirmToken }, ctx) => {
        const userId = await client.userId();
        const before = await readExpense(client, userId, reportId, expenseId);
        const current = receiptOf(before);
        if (!current) {
          throw new McpToolError(`Expense ${expenseId} has no receipt to detach.`, {
            hint: 'Check it with concur_get_expense.',
          });
        }
        const variables = { userId, contextRole: CONTEXT_ROLE, reportId, expenseId };
        const gate = await confirmWrite(ctx, {
          tool: 'concur_detach_receipt',
          action: 'concur.receipt.detach',
          summary: `Detach receipt image ${current} from expense ${expenseId}`,
          account: userId,
          target: expenseId,
          revision: current,
          payload: variables,
          preview: { expense: expenseSummary(before) },
          confirmToken,
        });
        if (gate) return gate;

        const change = await entryImage(client, 'detachImage', { userId, reportId, expenseId });
        return untrustedResult({
          detached: true,
          reportId,
          expenseId,
          detachedImageId: current,
          ...change,
          ...(await verify(async () => {
            const after = await readExpense(client, userId, reportId, expenseId);
            const still = receiptOf(after);
            const available = await readAvailableReceipts(client, userId);
            const returned = available.some((r) => r.imageId === current);
            return prune({
              receiptImageId: still,
              inAvailableReceipts: returned,
              observed:
                still !== undefined
                  ? `Concur accepted the detach but the expense still shows receipt image ${still}`
                  : returned
                    ? 'the expense has no receipt now and the image is back in your available receipts'
                    : 'the expense has no receipt now; the image is not in your available receipts',
              expense: expenseSummary(after),
            });
          })),
        });
      },
    );

    server.registerTool(
      'concur_delete_receipt',
      {
        description:
          'Permanently delete a receipt image from your SAP Concur available receipts (see ' +
          'concur_list_available_receipts). Cannot be undone. Only an unattached receipt can be deleted — detach it ' +
          'from its expense first with concur_detach_receipt. Re-reads the receipt store afterwards to confirm. ' +
          GATE,
        annotations: toolAnnotations({ title: 'Delete a Concur receipt', destructive: true, openWorld: true }),
        _meta: CHANGE,
        inputSchema: z.object({ imageId: imageIdParam, confirmToken: confirmTokenParam }),
      },
      async ({ imageId, confirmToken }, ctx) => {
        const userId = await client.userId();
        const receipt = (await readAvailableReceipts(client, userId)).find((r) => r.imageId === imageId);
        if (!receipt) {
          throw new McpToolError(`Receipt image ${imageId} is not in your available receipts.`, {
            hint: 'List them with concur_list_available_receipts; a receipt on an expense must be detached first (concur_detach_receipt).',
          });
        }
        if (receipt.meta?.canDeleteReceipt === false) {
          throw new McpToolError(`SAP Concur does not allow receipt image ${imageId} to be deleted.`);
        }
        const gate = await confirmWrite(ctx, {
          tool: 'concur_delete_receipt',
          action: 'concur.receipt.delete',
          summary: `Permanently delete receipt image ${imageId}`,
          account: userId,
          target: imageId,
          payload: { imageId },
          preview: { receiptToDelete: compactReceipt(receipt) },
          confirmToken,
        });
        if (gate) return gate;

        const res = await client.spend<{ deleteReceipt?: unknown }>(DELETE_RECEIPT, { imageId });
        if (res.deleteReceipt === false || res.deleteReceipt === null || res.deleteReceipt === undefined) {
          throw new McpToolError('SAP Concur did not confirm deleting the receipt.', {
            hint: 'Re-read them with concur_list_available_receipts before retrying.',
          });
        }
        return untrustedResult({
          deleted: true,
          imageId,
          response: { deleteReceipt: res.deleteReceipt },
          ...warningsField(res),
          ...(await verify(async () => {
            const after = await readAvailableReceipts(client, userId);
            const gone = !after.some((r) => r.imageId === imageId);
            return {
              gone,
              observed: gone
                ? 'the receipt is no longer in your available receipts'
                : 'Concur reported success but the receipt is still in your available receipts',
              availableRemaining: after.length,
            };
          })),
        });
      },
    );
  };
}

/** Registrar for index.ts: the file boundary comes from the environment. */
export const registerReceiptTools = makeReceiptTools();
