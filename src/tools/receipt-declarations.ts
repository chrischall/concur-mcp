// Missing Receipt Declaration (Concur's internal name: affidavit; the web app
// also says "receipt exception" / "no receipt"). The employee certifies that an
// expense's receipt is missing, accepting the text their company's policy
// shows. Confirm-gated, and RE-READS afterwards. There is no remove: the web
// app only replaces a declaration by attaching a receipt image.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  UNTRUSTED_CONTENT_RULE,
  confirmTokenParam,
  confirmWrite,
  toolAnnotations,
  untrustedEnvelope,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { warningsField, warningsOf, type ConcurClient } from '../client.js';
import { CREATE_AFFIDAVITS, GET_AFFIDAVIT_CONTEXT } from '../graphql/receipt-declarations.js';
import { expenseIdParam } from './expenses.js';
import { REPORT_ESSENTIAL, reportIdParam } from './reports.js';
import { CONTEXT_ROLE, money, prune, verify, type Money } from './shared.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

const POLICY_TEXT_NOTE =
  "The explanation and acceptance below are your company's Concur policy text, written by its administrators " +
  "and shown verbatim, as the web app's Missing Receipt Declaration dialog shows them. " +
  UNTRUSTED_CONTENT_RULE;

// ── shapes ────────────────────────────────────────────────────────────────

interface EntrySummary {
  transactionDate?: string | null;
  isImageRequired?: boolean | null;
  isPaperReceiptRequired?: boolean | null;
  expenseType?: { name?: string | null } | null;
  vendor?: { description?: string | null; name?: string | null } | null;
  transactionAmount?: Money | null;
  meta?: { hasAffidavit?: boolean | null; hasReceiptImage?: boolean | null } | null;
}

interface Entry {
  expenseId: string;
  summary?: EntrySummary | null;
}

interface AffidavitContextData {
  employee: {
    expenseReport: {
      reportDetails: {
        name?: string | null;
        reportNumber?: string | null;
        policy?: {
          allowReceiptAffidavits?: boolean | null;
          receiptAffidavitExplanation?: string | null;
          receiptAffidavitAcceptance?: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
  reportEntriesDetails: { entries?: Entry[] | null } | null;
}

// ── reads ─────────────────────────────────────────────────────────────────

async function readContext(client: ConcurClient, userId: string, reportId: string) {
  const data = await client.spend<AffidavitContextData>(
    GET_AFFIDAVIT_CONTEXT,
    { userId, contextRole: CONTEXT_ROLE, reportId },
    REPORT_ESSENTIAL,
  );
  // REPORT_ESSENTIAL guarantees reportDetails.
  const details = data.employee!.expenseReport!.reportDetails!;
  const entries = new Map((data.reportEntriesDetails?.entries ?? []).map((e) => [e.expenseId, e]));
  return { data, details, entries };
}

/** The expense as the preview shows it. */
const expenseSummary = (e: Entry) => {
  const s = e.summary;
  return prune({
    expenseId: e.expenseId,
    date: s?.transactionDate,
    expenseType: s?.expenseType?.name,
    vendor: s?.vendor?.description ?? s?.vendor?.name,
    amount: money(s?.transactionAmount),
    receiptRequired: s ? s.isImageRequired === true || s.isPaperReceiptRequired === true : undefined,
  });
};

/** Why an expense cannot be declared (as the web app only offers it without a receipt), or undefined. */
function ineligibility(entry: Entry | undefined): string | undefined {
  if (!entry) return 'not on this report';
  if (entry.summary?.meta?.hasReceiptImage === true) return 'already has a receipt image';
  if (entry.summary?.meta?.hasAffidavit === true) return 'already has a missing receipt declaration';
  return undefined;
}

// ── registration ──────────────────────────────────────────────────────────

export function registerReceiptDeclarationTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_add_missing_receipt_declaration',
    {
      description:
        'Create a Missing Receipt Declaration (Concur: affidavit / receipt exception / no receipt) for one or more ' +
        'expenses on an SAP Concur report that have no receipt. Confirming it means the EMPLOYEE CERTIFIES the ' +
        "receipt is missing, accepting their company policy's declaration text, which the preview shows verbatim. " +
        'Refused when the report policy does not allow declarations, and for expenses that already have a receipt ' +
        'image or a declaration. There is no tool to remove a declaration (attaching a receipt replaces it). ' +
        'Re-reads the report afterwards and answers whether each expense now shows one. ' +
        GATE,
      annotations: toolAnnotations({
        title: 'Declare a Concur receipt missing',
        readOnly: false,
        // An employee certification with no inverse: no tool (or web-app action) removes it.
        destructive: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseIds: z
          .array(expenseIdParam)
          .min(1)
          .max(100)
          .describe('The expenses (on that report) whose receipt is missing. Duplicates are ignored.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, expenseIds: requested, confirmToken }, ctx) => {
      const expenseIds = [...new Set(requested)];
      const userId = await client.userId();
      const { data, details, entries } = await readContext(client, userId, reportId);

      // A certification is never made from a partial read.
      const gaps = warningsOf(data);
      if (gaps.length > 0) {
        throw new McpToolError(
          `SAP Concur could not read all of report ${reportId} (${gaps
            .map((w) => (w.correlationId ? `${w.path}, correlationId=${w.correlationId}` : w.path))
            .join('; ')}), so nothing was changed.`,
          { hint: 'Try again in a moment; if it persists, open the report in Concur to check it.' },
        );
      }

      const allowed = details.policy?.allowReceiptAffidavits;
      if (allowed === false) {
        throw new McpToolError(`Report ${reportId}'s policy does not allow missing receipt declarations.`, {
          hint: 'Attach a receipt instead (concur_upload_receipt, then concur_attach_receipt).',
        });
      }
      if (allowed !== true) {
        throw new McpToolError(
          `SAP Concur could not tell whether the policy of report ${reportId} allows missing receipt declarations, so nothing was changed.`,
          { hint: 'Try again in a moment.' },
        );
      }

      const refused = expenseIds
        .map((id) => ({ id, reason: ineligibility(entries.get(id)) }))
        .filter((r) => r.reason !== undefined);
      if (refused.length > 0) {
        throw new McpToolError(
          `Cannot declare the receipt missing for: ${refused.map((r) => `${r.id} (${r.reason})`).join('; ')}. Nothing was changed.`,
          {
            hint:
              'A declaration is only for an expense with no receipt and no declaration yet — check the expenses with concur_get_report.',
          },
        );
      }

      const selected = expenseIds.map((id) => entries.get(id)!);
      const variables = { userId, contextRole: CONTEXT_ROLE, reportId, expenseIds };
      const reportName = `"${details.name ?? reportId}"`;
      const gate = await confirmWrite(ctx, {
        tool: 'concur_add_missing_receipt_declaration',
        action: 'concur.receipt.declare_missing',
        summary:
          `Declare the receipt missing for ${expenseIds.length} expense(s) on report ${reportName} — ` +
          'you certify each receipt is missing',
        account: userId,
        target: reportId,
        revision: JSON.stringify(selected.map((e) => [e.expenseId, e.summary?.meta ?? null])),
        payload: variables,
        preview: {
          certification:
            'Confirming means the employee is certifying that the receipt for each expense below is missing, and ' +
            'accepting the policy text below as their own declaration. Approvers and auditors see it.',
          policyText: untrustedEnvelope(
            {
              explanation: details.policy?.receiptAffidavitExplanation ?? null,
              acceptance: details.policy?.receiptAffidavitAcceptance ?? null,
            },
            { note: POLICY_TEXT_NOTE },
          ),
          expenses: selected.map(expenseSummary),
        },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{ createAffidavits: { status: { success?: boolean | null } | null } | null }>(
        CREATE_AFFIDAVITS,
        variables,
      );
      const status = res.createAffidavits?.status;
      if (status?.success !== true) {
        throw new McpToolError('SAP Concur did not confirm the missing receipt declaration.', {
          hint: 'Re-read the report with concur_get_report to see what actually changed before retrying.',
        });
      }

      return untrustedResult({
        declared: true,
        reportId,
        expenseIds,
        response: { status },
        ...warningsField(res),
        ...(await verify(async () => {
          const after = await readContext(client, userId, reportId);
          const expenses = expenseIds.map((id) => ({
            expenseId: id,
            hasAffidavit: after.entries.get(id)?.summary?.meta?.hasAffidavit ?? null,
          }));
          const missing = expenses.filter((e) => e.hasAffidavit !== true).map((e) => e.expenseId);
          return {
            observed:
              missing.length === 0
                ? 'every expense now shows a missing receipt declaration'
                : `Concur accepted the declaration but these expenses do not show one yet: ${missing.join(', ')} — re-read the report with concur_get_report`,
            expenses,
            ...warningsField(after.data),
          };
        })),
      });
    },
  );
}
