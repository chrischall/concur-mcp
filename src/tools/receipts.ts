// Receipts: upload, list, get (download), attach / append / detach on an
// expense, and delete. Every Concur write is confirm-gated and RE-READS
// afterwards, answering with what Concur now shows. `concur_get_receipt` only
// writes a LOCAL file (or answers inline), so it is not gated.

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  messageOf,
  sniffMimeBytes,
  toolAnnotations,
  untrustedResult,
  vetUploadFile,
} from '@chrischall/mcp-utils';
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
  UPLOAD_MIME_BY_EXT,
  extensionForMime,
  makeReceiptOutput,
  uploadRoots,
  type ReceiptOutput,
} from '../receipt-files.js';
import { EXPENSE_ESSENTIAL, compactExpense, expenseIdParam, type ExpenseData } from './expenses.js';
import { reportIdParam } from './reports.js';
import { CONTEXT_ROLE, concurView, prune, respond, trueFlags, verify } from './shared.js';

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
  /** Where concur_get_receipt puts a download. Default: {@link makeReceiptOutput} from the env. */
  output?: ReceiptOutput;
  /** The folders an upload may come from. Default: {@link uploadRoots} from the env (read per call). */
  roots?: () => readonly string[];
  /** What a relative upload path resolves against. Default: the cwd. */
  baseDir?: string;
}

/** The receipt-tool registrar, with its file boundary injectable (tests, hosting). */
export function makeReceiptTools(opts: ReceiptToolOptions = {}) {
  return function registerReceiptTools(server: McpServer, client: ConcurClient): void {
    const output = opts.output ?? makeReceiptOutput();
    const roots = opts.roots ?? (() => uploadRoots());
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
          'an embedded resource). On a hosted server nothing is saved and it is always inline. Pass `reportId` ' +
          'for a receipt on a report so its permissions are judged in that context. Writes only a local file — ' +
          'nothing changes in Concur. ' +
          UNTRUSTED_DESCRIPTION_SUFFIX,
        annotations: toolAnnotations({
          title: 'Get a Concur receipt image',
          readOnly: false,
          destructive: false,
          openWorld: true,
        }),
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
        const file = { baseName: `receipt-${imageId}`, extension: extensionForMime(mimeType), bytes };

        let savedTo: string | undefined;
        let notice: string | undefined;
        let block: CallToolResult['content'][number] | undefined;
        const wantInline = inline || !output.persistsFiles;
        if (wantInline && bytes.byteLength <= MAX_INLINE_BYTES) {
          const data64 = Buffer.from(bytes).toString('base64');
          block = /^image\/(png|jpeg|gif|webp)$/.test(mimeType)
            ? { type: 'image', data: data64, mimeType }
            : { type: 'resource', resource: { uri: `concur-receipt:${imageId}`, mimeType, blob: data64 } };
        } else if (wantInline && !output.persistsFiles) {
          notice = `The receipt is ${bytes.byteLength} bytes — over the ${MAX_INLINE_BYTES}-byte inline limit — so it is not included; open it in the Concur web app.`;
        } else {
          savedTo = await output.save(file);
          if (wantInline) notice = `Too large to return inline (${bytes.byteLength} bytes), so it was saved instead.`;
        }

        const shown = view === 'raw' ? data : view === 'full' ? receipt : compactReceipt(receipt);
        const result = untrustedResult(
          prune({
            receipt: shown,
            mimeType,
            bytes: bytes.byteLength,
            savedTo,
            inline: block !== undefined,
            notice,
            ...warningsField(data),
          }),
        );
        return block ? { ...result, content: [...result.content, block] } : result;
      },
    );

    server.registerTool(
      'concur_upload_receipt',
      {
        description:
          `Upload a receipt file (${types}; up to 25 MB) from this computer to SAP Concur. The path must be inside ` +
          'the allowed upload folders — CONCUR_UPLOAD_ROOTS when set, otherwise the working directory, ~/Downloads, ' +
          '~/Documents or ~/Desktop — and its contents must match its extension; anything else is refused before a ' +
          'byte is sent. With `reportId` + `expenseId` it is attached to that expense straight away (`append: true` ' +
          'adds it to a receipt the expense already has); otherwise it lands in your available receipts. The ' +
          'preview names the file, its size and SHA-256, and the target expense. ' +
          GATE,
        // Destructive because `append: true` adds a page no tool can take back off (see concur_append_receipt).
        annotations: toolAnnotations({ title: 'Upload a Concur receipt', readOnly: false, destructive: true, openWorld: true }),
        inputSchema: z.object({
          path: z.string().min(1).describe('Local file path (a leading ~ is expanded; relative paths resolve against the working directory).'),
          reportId: reportIdParam.optional().describe('Report holding `expenseId` — attach the receipt to that expense.'),
          expenseId: expenseIdParam.optional().describe('Expense to attach the receipt to (needs `reportId`).'),
          append: z
            .boolean()
            .default(false)
            .describe('When the expense already has a receipt, add this image to it instead of refusing.'),
          confirmToken: confirmTokenParam,
        }),
      },
      async ({ path, reportId, expenseId, append, confirmToken }, ctx) => {
        if (Boolean(reportId) !== Boolean(expenseId)) {
          throw new McpToolError('Pass both `reportId` and `expenseId` to attach the receipt, or neither.', {
            hint: 'Find the ids with concur_get_report.',
          });
        }
        const userId = await client.userId();
        const file = await vetUploadFile(path, {
          mimeByExt: UPLOAD_MIME_BY_EXT,
          maxBytes: MAX_RECEIPT_BYTES,
          allowedRoots: roots(),
          ...(opts.baseDir ? { baseDir: opts.baseDir } : {}),
          denyHiddenSegments: true,
          readAll: true,
        });
        const bytes = file.bytes!;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const filename = basename(file.requested);

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
          payload: { file: file.requested, size: file.size, mimeType: file.mime, sha256, reportId, expenseId, field },
          preview: prune({
            file: { path: file.requested, name: filename, size: file.size, mimeType: file.mime, sha256 },
            attachTo: before ? expenseSummary(before) : undefined,
            mode: field,
          }),
          confirmToken,
        });
        if (gate) return gate;

        const uploaded = await client.upload({ data: bytes, filename, contentType: file.mime });

        // From here the upload has happened: nothing below may turn it into an error.
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
            });
          }
          const { response: attached, ...attachWarnings } = attach;
          return untrustedResult({
            uploaded: true,
            imageId: uploaded.imageId,
            attached: true,
            response: { upload: uploaded, [field]: attached },
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
