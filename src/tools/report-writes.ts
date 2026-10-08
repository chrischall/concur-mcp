// Report-header writes: create, update, delete, comment, submit, recall. Every
// one is confirm-gated, and every one RE-READS the report afterwards and
// answers with what Concur now shows under `verified`. The re-read is
// best-effort: once the mutation succeeded the tool answers success (with the
// ids and the mutation's own response), and a failed re-read becomes a
// `verificationError` — never an error result for a change that was made.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  IsoDate,
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { GraphqlResponseError } from '@chrischall/mcp-utils/graphql';
import { warningsField, type ConcurClient } from '../client.js';
import {
  CREATE_REPORT,
  CREATE_REPORT_COMMENT,
  DELETE_EXPENSE_ENTRIES,
  DELETE_REPORT,
  NEW_REPORT_FORM,
  RECALL_REPORT,
  REPORT_FORM,
  SUBMIT_REPORT,
  UPDATE_REPORT,
} from '../graphql/report-writes.js';
import { GET_REPORT, GET_REPORT_TIMELINE } from '../graphql/reports.js';
import {
  businessPurposeList,
  chooseField,
  isEditable,
  isListField,
  labelOf,
  parentItemOf,
  pickedOf,
  resolveListValue,
  type FormField,
  type Picked,
} from './forms.js';
import {
  REPORT_ESSENTIAL,
  compactReport,
  reportIdParam,
  requireReport,
  requireTimeline,
  timelineComments,
  type ReportPageData,
  type TimelineData,
  type TimelineDay,
} from './reports.js';
import { CONTEXT_ROLE, prune, verify } from './shared.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

// ── header fields ─────────────────────────────────────────────────────────

/** Header keys sent as plain scalars (as the web app's captured create sends them); the rest are `{ value }`. */
const SCALAR_KEYS = new Set(['name', 'reportDate', 'businessPurpose', 'comment', 'countryCode']);
/** Form field ids whose input key differs (the bundle's field-id constants). */
const KEY_ALIASES: Record<string, string> = { country: 'countryCode' };

const keyOf = (f: FormField): string => KEY_ALIASES[f.id] ?? f.id;
/** The keys this tool sends: the captured scalars plus `customN` / `orgUnitN`. */
const isSendable = (key: string) => SCALAR_KEYS.has(key) || /^(custom|orgUnit)\d+$/.test(key);

function encode(key: string, p: Picked): unknown {
  if (key === 'countryCode') return p.code ?? p.sent;
  return SCALAR_KEYS.has(key) ? p.sent : { value: p.sent };
}

interface Setting {
  key: string;
  label: string;
  picked: Picked;
}

type Settings = Map<string, Setting>;

interface FormData {
  fields?: FormField[] | null;
  policyId?: string | null;
}

/** Every sendable field's current (or default) value, keyed by input key. */
function currentSettings(fields: readonly FormField[]): Settings {
  const out: Settings = new Map();
  for (const f of fields) {
    const key = keyOf(f);
    const picked = pickedOf(f);
    if (isSendable(key) && picked) out.set(key, { key, label: labelOf(f), picked });
  }
  return out;
}

/** One requested change: the named header args by key, `fields` by label or id. */
interface Overlay {
  field: FormField | undefined;
  key: string;
  text: string;
  /** The value, when choosing between same-label fields already resolved it (top list level only). */
  picked?: Picked;
}

/** A field this tool can send AND a person may edit. */
const isSettable = (f: FormField) => isSendable(keyOf(f)) && isEditable(f);

function namedOverlay(fields: readonly FormField[], key: string, text: string): Overlay {
  // "Business Purpose" is a required DROPDOWN on some tenants (custom5 on the
  // live one), beside an unused free-text `businessPurpose`: the argument goes
  // to the dropdown, resolved by item text, whenever the form has one.
  const dropdown = key === 'businessPurpose' ? businessPurposeList(fields, isSettable) : undefined;
  if (dropdown) return { field: dropdown, key: keyOf(dropdown), text };
  return { field: fields.find((f) => keyOf(f) === key), key, text };
}

async function labelledOverlay(
  client: ConcurClient,
  fields: readonly FormField[],
  base: Settings,
  name: string,
  text: string,
): Promise<Overlay> {
  const choice = await chooseField(client, fields, name, text, {
    settable: isSettable,
    parentOf: (f) => parentItemOf(fields, f, (p) => base.get(keyOf(p))?.picked),
  });
  const field = choice?.field;
  const settable = fields.filter(isSettable).map(labelOf);
  if (!field) {
    throw new McpToolError(`This report form has no field "${name}".`, {
      hint: `Settable fields: ${settable.join('; ')}.`,
    });
  }
  if (!isSettable(field)) {
    throw new McpToolError(`The "${labelOf(field)}" field cannot be set by this tool.`, {
      hint: `Settable fields: ${settable.join('; ')}.`,
    });
  }
  // A lower connected-list level is re-resolved under the parent the overlays choose.
  const reuse = choice.picked && (field.list?.level ?? 1) <= 1;
  return { field, key: keyOf(field), text, ...(reuse ? { picked: choice.picked } : {}) };
}

/**
 * Apply the overlays onto `base`, resolving list values (top list level
 * first, so a connected list's lower level searches under its parent's item).
 */
async function applyOverlays(
  client: ConcurClient,
  fields: readonly FormField[],
  base: Settings,
  overlays: readonly Overlay[],
): Promise<Settings> {
  const out: Settings = new Map(base);
  const level = (o: Overlay) => o.field?.list?.level ?? 0;
  for (const o of [...overlays].sort((a, b) => level(a) - level(b))) {
    const { field, key, text } = o;
    const picked =
      o.picked ??
      (field && isListField(field)
        ? await resolveListValue(client, field, text, parentItemOf(fields, field, (f) => out.get(keyOf(f))?.picked))
        : { sent: text, display: text });
    out.set(key, { key, label: field ? labelOf(field) : key, picked });
  }
  return out;
}

const shown = (settings: Iterable<Setting>) =>
  [...settings].map((s) => ({ label: s.label, field: s.key, value: s.picked.display }));

function requireForm(form: FormData | null | undefined): { fields: FormField[]; policyId: string | null | undefined } {
  if (!form?.fields) throw new McpToolError('SAP Concur returned no report header form for the signed-in user.');
  return { fields: form.fields, policyId: form.policyId };
}

interface HeaderArgs {
  name?: string;
  reportDate?: string;
  businessPurpose?: string;
  comment?: string;
  fields?: Record<string, string>;
}

async function overlaysOf(client: ConcurClient, fields: readonly FormField[], base: Settings, args: HeaderArgs): Promise<Overlay[]> {
  const named = (['name', 'reportDate', 'businessPurpose', 'comment'] as const)
    .filter((k) => args[k] !== undefined)
    .map((k) => namedOverlay(fields, k, args[k] as string));
  const labelled: Overlay[] = [];
  for (const [name, text] of Object.entries(args.fields ?? {})) labelled.push(await labelledOverlay(client, fields, base, name, text));
  return [...named, ...labelled];
}

/**
 * REQUIRED fields a person can edit that this write will send empty — listed
 * in the preview so the user sees them before confirming. Not a refusal:
 * Concur accepts the write and flags an exception. Read-only / computed fields
 * (report total, approval status, …) are skipped by their `accessMode`.
 */
function missingRequiredOf(fields: readonly FormField[], settings: Settings) {
  return fields
    .filter((f) => f.isRequired && isSettable(f) && !settings.get(keyOf(f))?.picked.sent)
    .map((f) => ({ label: labelOf(f), field: keyOf(f) }));
}

// ── re-reads ──────────────────────────────────────────────────────────────

async function readReport(client: ConcurClient, userId: string, reportId: string): Promise<ReportPageData> {
  return client.spend<ReportPageData>(GET_REPORT, { userId, reportId, contextRole: CONTEXT_ROLE }, REPORT_ESSENTIAL);
}

/** The report after a write, as Concur now shows it (header + entries + exceptions, plus any partial-read warnings). */
async function observe(client: ConcurClient, userId: string, reportId: string) {
  const data = await readReport(client, userId, reportId);
  return { ...compactReport(data), ...warningsField(data) };
}

/** Header meta flags (`isSubmitted`, `canRecall`, …) off a report read. */
function metaOf(data: ReportPageData): Record<string, unknown> {
  return ((requireReport(data).details as { meta?: Record<string, unknown> | null }).meta ?? {}) as Record<string, unknown>;
}

/** How a report is named in a summary: its name, else its id. */
const titleOf = (report: { name?: unknown }, reportId: string) => `"${String(report.name ?? reportId)}"`;

/** An exception as one line: its message, else its code. */
const exceptionText = (e: { message?: unknown; code?: unknown }) => String(e.message ?? e.code);

function requireSuccess(status: { success?: boolean | null } | null | undefined, what: string): void {
  if (status?.success !== true) {
    throw new McpToolError(`SAP Concur did not confirm ${what}.`, {
      hint: 'Re-read the report with concur_get_report to see what actually changed before retrying.',
    });
  }
}

/** The reason a submit was refused, from `errors[0].extensions.exception` (as the web app reads it). */
function submitRefusal(err: GraphqlResponseError) {
  const ext = (err.errors[0]?.extensions ?? {}) as { exception?: { key?: string; data?: { errorMessage?: string } } };
  return prune({ key: ext.exception?.key, message: ext.exception?.data?.errorMessage ?? err.message });
}

// ── registration ──────────────────────────────────────────────────────────

const headerFieldsParam = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    'Other header fields by their LABEL as Concur shows it (or field id), e.g. {"Business Purpose": "Client visit"}. ' +
      'A list-valued field takes the item text or code and is resolved to its list item.',
  );

export function registerReportWriteTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_create_report',
    {
      description:
        'Create a new (unsubmitted) SAP Concur expense report. The header form is tenant-specific: it starts from ' +
        "your company's defaults, then applies `name`, `reportDate` and any other fields you name by label " +
        '(list fields such as a Business Purpose dropdown are resolved to their list item). The preview lists every ' +
        'field that will be sent and any required field still empty. Answers with the new report as Concur shows it. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Create a Concur expense report', readOnly: false, destructive: false }),
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe('Report name.'),
        reportDate: IsoDate.optional().describe('Report date, YYYY-MM-DD (default today).'),
        businessPurpose: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Business purpose. When the form has a required "Business Purpose" dropdown this is the item text to pick ' +
              '(e.g. "Internal Meetings/Expenses"); otherwise it is free text.',
          ),
        comment: z.string().max(2000).optional().describe('Header comment.'),
        policyId: z.string().min(1).optional().describe('Expense policy id (default: the form’s default policy).'),
        fields: headerFieldsParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const userId = await client.userId();
      const data = await client.spend<{ newReportForm: FormData | null }>(NEW_REPORT_FORM, {
        userId,
        contextRole: CONTEXT_ROLE,
        policyId: args.policyId ?? null,
      }, { essential: ['newReportForm.fields'] });
      const form = requireForm(data.newReportForm);
      const policyId = args.policyId ?? form.policyId;
      if (!policyId) {
        throw new McpToolError('SAP Concur returned no default expense policy for a new report.', {
          hint: 'Pass `policyId` (see an existing report with concur_get_report).',
        });
      }
      const reportDate = args.reportDate ?? new Date(client.now()).toISOString().slice(0, 10);
      const base = currentSettings(form.fields);
      const settings = await applyOverlays(
        client,
        form.fields,
        base,
        await overlaysOf(client, form.fields, base, { ...args, reportDate }),
      );
      // The web app always sends these two, empty when unused.
      for (const key of ['businessPurpose', 'comment']) {
        if (!settings.has(key)) settings.set(key, { key, label: key, picked: { sent: '', display: '' } });
      }
      const missingRequired = missingRequiredOf(form.fields, settings);
      const fields: Record<string, unknown> = { policyId, reportSource: 'WEB' };
      for (const s of settings.values()) fields[s.key] = encode(s.key, s.picked);
      const variables = { userId, contextRole: CONTEXT_ROLE, fields };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_create_report',
        action: 'concur.report.create',
        summary: `Create the expense report "${args.name}"`,
        account: userId,
        payload: variables,
        preview: {
          fields: shown(settings.values()),
          ...(missingRequired.length > 0
            ? {
                missingRequired,
                caveat:
                  'These required fields will be sent empty. Concur still creates the report but flags an exception until they are set.',
              }
            : {}),
        },
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;

      const created = await client.spend<{ createReport: { reportId?: string | null } | null }>(CREATE_REPORT, variables, {
        essential: ['createReport.reportId'],
      });
      const reportId = created.createReport?.reportId;
      if (!reportId) {
        throw new McpToolError('SAP Concur accepted the create but returned no report id.', {
          hint: 'List your unsubmitted reports with concur_list_reports before creating it again.',
        });
      }
      return untrustedResult({
        created: true,
        reportId,
        response: created.createReport,
        ...warningsField(created),
        ...(await verify(() => observe(client, userId, reportId))),
      });
    },
  );

  server.registerTool(
    'concur_update_report',
    {
      description:
        "Change an unsubmitted SAP Concur report's header — name, date, business purpose, comment, or other header " +
        'fields by label. Sends only the fields that actually change; the preview shows each one from → to. ' +
        'Answers with the report as Concur shows it afterwards. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Update a Concur report header', readOnly: false, destructive: false }),
      inputSchema: z.object({
        reportId: reportIdParam,
        name: z.string().min(1).max(200).optional().describe('New report name.'),
        reportDate: IsoDate.optional().describe('New report date, YYYY-MM-DD.'),
        businessPurpose: z
          .string()
          .max(500)
          .optional()
          .describe('New business purpose: the item text of a required "Business Purpose" dropdown when the form has one, else free text.'),
        comment: z.string().max(2000).optional().describe('New header comment.'),
        fields: headerFieldsParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { reportId } = args;
      const userId = await client.userId();
      const data = await client.spend<{ existingReportForm: FormData | null }>(REPORT_FORM, {
        userId,
        contextRole: CONTEXT_ROLE,
        reportId,
      }, { essential: ['existingReportForm.fields'] });
      const form = requireForm(data.existingReportForm);
      const before = currentSettings(form.fields);
      const after = await applyOverlays(client, form.fields, before, await overlaysOf(client, form.fields, before, args));
      const changed = [...after.values()].filter((s) => before.get(s.key)?.picked.sent !== s.picked.sent);
      if (changed.length === 0) {
        throw new McpToolError('Nothing to change: every field you passed already has that value.', {
          hint: 'Pass at least one of name, reportDate, businessPurpose, comment or fields with a new value.',
        });
      }
      const fields = Object.fromEntries(changed.map((s) => [s.key, encode(s.key, s.picked)]));
      const variables = { userId, contextRole: CONTEXT_ROLE, reportId, fields };
      const missingRequired = missingRequiredOf(form.fields, after);

      const gate = await confirmWrite(ctx, {
        tool: 'concur_update_report',
        action: 'concur.report.update',
        summary: `Update the header of report ${reportId}`,
        account: userId,
        target: reportId,
        revision: JSON.stringify(changed.map((s) => [s.key, before.get(s.key)?.picked.sent ?? null])),
        payload: variables,
        preview: {
          changes: changed.map((s) => ({
            label: s.label,
            field: s.key,
            from: before.get(s.key)?.picked.display ?? null,
            to: s.picked.display,
          })),
          ...(missingRequired.length > 0
            ? { missingRequired, caveat: 'These required fields are still empty after this change; Concur flags an exception until they are set.' }
            : {}),
        },
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{ updateReport: { reportId?: string | null } | null }>(UPDATE_REPORT, variables);
      return untrustedResult({
        updated: true,
        reportId,
        changedFields: changed.map((s) => s.label),
        response: res.updateReport,
        ...warningsField(res),
        ...(await verify(() => observe(client, userId, reportId))),
      });
    },
  );

  server.registerTool(
    'concur_delete_report',
    {
      description:
        'Permanently delete an unsubmitted SAP Concur expense report AND every expense on it (the expenses first, ' +
        'then the report — as the web app does). Card transactions on it return to your available expenses; ' +
        'manually entered expenses and their receipts attachments are gone. Cannot be undone. The preview lists the ' +
        'expenses that will be deleted. Re-reads afterwards to confirm the report is gone. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Delete a Concur expense report', destructive: true }),
      inputSchema: z.object({ reportId: reportIdParam, confirmToken: confirmTokenParam }),
    },
    async ({ reportId, confirmToken }, ctx) => {
      const userId = await client.userId();
      const current = compactReport(await readReport(client, userId, reportId));
      const expenseIds = current.entries.map((e) => e.expenseId as string);

      const gate = await confirmWrite(ctx, {
        tool: 'concur_delete_report',
        action: 'concur.report.delete',
        summary: `Permanently delete report ${titleOf(current.report, reportId)} and its ${expenseIds.length} expense(s)`,
        account: userId,
        target: reportId,
        revision: expenseIds.join(','),
        payload: { userId, contextRole: CONTEXT_ROLE, reportId, expenseIds },
        preview: {
          report: prune({
            name: current.report.name,
            reportNumber: current.report.reportNumber,
            approvalStatus: current.report.approvalStatus,
            total: current.report.total,
          }),
          expensesToDelete: current.entries.map((e) =>
            prune({ date: e.date, expenseType: e.expenseType, vendor: e.vendor, amount: e.amount }),
          ),
        },
        confirmToken,
      });
      if (gate) return gate;

      if (expenseIds.length > 0) {
        const del = await client.spend<{
          employee: { expenseReport: { deleteExpenseEntries: { status: { success?: boolean } | null } | null } | null } | null;
        }>(DELETE_EXPENSE_ENTRIES, { userId, contextRole: CONTEXT_ROLE, reportId, expenseIds });
        requireSuccess(del.employee?.expenseReport?.deleteExpenseEntries?.status, "deleting the report's expenses (the report was NOT deleted)");
      }
      // The expenses are gone now: a failure from here on must say so.
      const reportFailed = (detail: string) =>
        new McpToolError(
          `${expenseIds.length > 0 ? `The report's ${expenseIds.length} expense(s) WERE deleted, but ` : ''}${detail}`,
          { hint: 'Re-read the report with concur_get_report to see what actually changed before retrying.' },
        );
      let res: { employee: { expenseReport: { deleteReport: { status: { success?: boolean } | null } | null } | null } | null };
      try {
        res = await client.spend(DELETE_REPORT, { userId, contextRole: CONTEXT_ROLE, reportId });
      } catch (err) {
        if (expenseIds.length === 0) throw err;
        throw reportFailed(`deleting the report itself failed: ${(err as Error).message}`);
      }
      const status = res.employee?.expenseReport?.deleteReport?.status;
      if (status?.success !== true) throw reportFailed('SAP Concur did not confirm deleting the report.');

      // Verify: the report must no longer be readable.
      const gone = { observed: 'the report is no longer readable' };
      const verification = await verify(async () => {
        let after: ReportPageData;
        try {
          after = await readReport(client, userId, reportId);
        } catch (err) {
          if (err instanceof GraphqlResponseError) return gone;
          throw err;
        }
        if (!after.employee?.expenseReport?.reportDetails) return gone;
        return { observed: 'Concur reported success but the report can still be read', ...compactReport(after) };
      });
      return untrustedResult({
        deleted: true,
        reportId,
        deletedExpenses: expenseIds.length,
        response: { status },
        ...warningsField(res),
        ...verification,
      });
    },
  );

  server.registerTool(
    'concur_add_report_comment',
    {
      description:
        'Add a comment to an SAP Concur expense report. Comments are permanent (there is no delete) and are seen ' +
        "by your approvers and auditors. Confirms the comment is on the report's timeline afterwards (from Concur's " +
        'answer, else by re-reading the timeline). ' +
        GATE,
      annotations: toolAnnotations({ title: 'Comment on a Concur report', destructive: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        comment: z.string().trim().min(1).max(2000).describe('The comment text.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, comment, confirmToken }, ctx) => {
      const userId = await client.userId();
      const vars = { userId, reportId, contextRole: CONTEXT_ROLE };
      const beforeData = await client.spend<TimelineData>(GET_REPORT_TIMELINE, vars, REPORT_ESSENTIAL);
      const before = requireTimeline(beforeData);
      const countBefore = timelineComments(beforeData.timelineSummary).length;

      const gate = await confirmWrite(ctx, {
        tool: 'concur_add_report_comment',
        action: 'concur.report.comment',
        summary: `Add a comment to report ${titleOf(before.details, reportId)} (visible to approvers; cannot be deleted)`,
        account: userId,
        target: reportId,
        payload: { ...vars, comment },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{
        createNewReportComment: { status: { success?: boolean } | null; timelineSummary?: TimelineDay[] | null } | null;
      }>(CREATE_REPORT_COMMENT, { ...vars, comment });
      requireSuccess(res.createNewReportComment?.status, 'adding the comment');

      // Comments live in `timelineSummary` (not `reportDetails.comments`, which
      // stays empty). The mutation answers with the timeline itself: verify
      // there first, and only re-read when it does not show the comment.
      const seen = (days: TimelineDay[] | null | undefined, via: string) => {
        const comments = timelineComments(days);
        const found = comments.some((c) => c.comment?.trim() === comment);
        return {
          onTimeline: found,
          via,
          observed: found
            ? 'the comment is on the report timeline'
            : `Concur reported success but the comment is not on the timeline yet (${comments.length} comment(s), ${countBefore} before)`,
          comments: comments.map((c) => c.comment),
        };
      };
      const fromMutation = seen(res.createNewReportComment?.timelineSummary, 'mutation response');
      const verification = fromMutation.onTimeline
        ? { verified: fromMutation }
        : await verify(async () => {
            const after = await client.spend<TimelineData>(GET_REPORT_TIMELINE, vars, REPORT_ESSENTIAL);
            requireTimeline(after);
            return seen(after.timelineSummary, 're-read');
          });

      return untrustedResult({
        commented: true,
        reportId,
        response: { status: res.createNewReportComment?.status },
        ...warningsField(res),
        ...verification,
      });
    },
  );

  server.registerTool(
    'concur_submit_report',
    {
      description:
        'Submit an SAP Concur expense report for approval. This SENDS it to your approver (a third party) and locks ' +
        'it for editing — only concur_recall_report can pull it back, and only before it is approved. Concur ' +
        'validates first: a report with blocking exceptions is refused before anything is sent, and one with ' +
        'warnings comes back unsubmitted with Concur’s message unless `acknowledgeWarnings` is true. Re-reads the ' +
        'report afterwards and answers with its observed status. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Submit a Concur expense report', destructive: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        acknowledgeWarnings: z
          .boolean()
          .default(false)
          .describe("Submit even though Concur's validation raised warnings (as the web app's \"submit anyway\"). Default false."),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, acknowledgeWarnings, confirmToken }, ctx) => {
      const userId = await client.userId();
      const current = compactReport(await readReport(client, userId, reportId));
      const blocking = current.exceptions.filter((e) => e.blocking);
      if (blocking.length > 0) {
        throw new McpToolError(
          `Report ${reportId} has ${blocking.length} blocking exception(s) and cannot be submitted: ` +
            blocking.map(exceptionText).join('; '),
          { hint: 'Fix them (concur_get_report lists each one) and try again.' },
        );
      }
      const variables = {
        contextRole: CONTEXT_ROLE,
        reportId,
        userId,
        reportSource: 'WEB',
        validate: !acknowledgeWarnings,
        approverValidated: false,
      };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_submit_report',
        action: 'concur.report.submit',
        summary: `Submit report ${titleOf(current.report, reportId)} to your approver`,
        account: userId,
        target: reportId,
        revision: JSON.stringify([current.report.total, current.entries.length]),
        payload: variables,
        preview: {
          report: prune({
            name: current.report.name,
            reportNumber: current.report.reportNumber,
            total: current.report.total,
            expenses: current.entries.length,
          }),
          warnings: current.exceptions.map(exceptionText),
          caveat: 'Submitting sends the report to your approver and locks it.',
        },
        confirmToken,
      });
      if (gate) return gate;

      let status: unknown;
      let refusal: Record<string, unknown> | undefined;
      let warnings: object = {};
      try {
        const res = await client.spend<{ CDS_expense: { report: { submit: { status?: unknown } | null } | null } | null }>(
          SUBMIT_REPORT,
          variables,
        );
        status = res.CDS_expense?.report?.submit?.status;
        warnings = warningsField(res);
      } catch (err) {
        if (!(err instanceof GraphqlResponseError)) throw err;
        refusal = submitRefusal(err);
      }
      // Whether it went through is read back from the report (a `validate` pass
      // with warnings answers a status, not a submit) — best-effort.
      const verification = await verify(async () => {
        const after = await readReport(client, userId, reportId);
        const submitted = metaOf(after).isSubmitted === true;
        return {
          submitted,
          observed: submitted
            ? 'the report is submitted'
            : 'the report is NOT submitted — see `status` / `refusal` for Concur’s reason',
          ...compactReport(after),
          ...warningsField(after),
        };
      });
      const submitted = 'verified' in verification ? verification.verified.submitted : undefined;
      return untrustedResult(
        prune({
          submitted,
          reportId,
          status,
          refusal,
          ...(submitted === undefined
            ? {
                observed: refusal
                  ? 'Concur refused the submit — see `refusal`'
                  : 'Concur answered the submit (see `status`) but the report could not be re-read — check it with concur_get_report before submitting again',
              }
            : {}),
          ...warnings,
          ...verification,
        }),
      );
    },
  );

  server.registerTool(
    'concur_recall_report',
    {
      description:
        'Recall a submitted SAP Concur expense report from your approver, returning it to you unsubmitted so it can ' +
        'be edited and resubmitted (the inverse of concur_submit_report). Only possible before it is approved. ' +
        'Re-reads the report afterwards and answers with its observed status. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Recall a Concur expense report', readOnly: false, destructive: false }),
      inputSchema: z.object({ reportId: reportIdParam, confirmToken: confirmTokenParam }),
    },
    async ({ reportId, confirmToken }, ctx) => {
      const userId = await client.userId();
      const data = await readReport(client, userId, reportId);
      const current = compactReport(data);
      if (metaOf(data).canRecall === false) {
        throw new McpToolError(`Report ${reportId} cannot be recalled (status: ${String(current.report.approvalStatus)}).`, {
          hint: 'Only a submitted report that is not yet approved can be recalled.',
        });
      }
      const variables = { contextRole: CONTEXT_ROLE, reportId, userId };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_recall_report',
        action: 'concur.report.recall',
        summary: `Recall report ${titleOf(current.report, reportId)} from your approver`,
        account: userId,
        target: reportId,
        revision: String(current.report.approvalStatus),
        payload: variables,
        preview: { report: prune({ name: current.report.name, approvalStatus: current.report.approvalStatus }) },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{ recallReport: { id?: string | null; approvalStatus?: string | null } | null }>(
        RECALL_REPORT,
        variables,
      );
      return untrustedResult({
        recalled: true,
        reportId,
        response: res.recallReport,
        ...warningsField(res),
        ...(await verify(async () => {
          const after = await readReport(client, userId, reportId);
          const back = metaOf(after).isSubmitted !== true;
          return {
            unsubmitted: back,
            observed: back ? 'the report is back with you, unsubmitted' : 'Concur accepted the recall but the report still shows as submitted',
            ...compactReport(after),
            ...warningsField(after),
          };
        })),
      });
    },
  );
}
