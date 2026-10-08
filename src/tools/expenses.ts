// Expense reads: one expense entry on a report (summary, form fields, comments,
// exceptions) and the available expenses not yet on any report.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { ConcurClient } from '../client.js';
import { GET_EXPENSE, LIST_AVAILABLE_EXPENSES } from '../graphql/expenses.js';
import { compactEntry, compactException, reportIdParam } from './reports.js';
import {
  CONTEXT_ROLE,
  concurView,
  money,
  pageParam,
  personName,
  prune,
  respond,
  sizeParam,
  trueFlags,
  type Money,
  type PersonName,
} from './shared.js';

export const expenseIdParam = z
  .string()
  .regex(/^[A-Za-z0-9]{1,64}$/, 'a Concur expense id (e.g. 32 hex characters)')
  .describe('Expense entry id (`expenseId` from concur_get_report).');

type Rec = Record<string, unknown>;

// ── get_expense ───────────────────────────────────────────────────────────

interface FormField {
  id?: string;
  label?: string;
  formFieldId?: string;
  isRequired?: boolean | null;
  value?: Rec | null;
  [key: string]: unknown;
}

export interface ExpenseData {
  entryExceptions: {
    entryExceptions?: Rec[] | null;
    itemizationsExceptions?: Array<{ exceptions?: Rec[] | null }> | null;
  } | null;
  employee: {
    expenseReport: {
      reportId?: string;
      reportDetails: {
        name?: string;
        currencyCode?: string;
        policy?: { id?: string; expenseListDetailFormId?: string } | null;
      } | null;
      entry: (Rec & {
        id?: string;
        travel?: Rec | null;
        itemizations?: Array<{
          id?: string;
          isPersonalExpense?: boolean | null;
          expenseType?: { name?: string } | null;
          transactionAmount?: Money | null;
          transactionDate?: string | null;
        }> | null;
        entryComments?: Array<{ author?: PersonName | null; comment?: string | null; creationDate?: string | null }> | null;
      }) | null;
    } | null;
  } | null;
  existingExpenseForm: {
    expenseTypeId?: string;
    mainForm?: { isFormEditable?: boolean; fields?: FormField[] | null } | null;
  } | null;
}

const SCALAR_VALUE_KEYS = [
  'stringValue',
  'dateValue',
  'booleanValue',
  'floatValue',
  'integerValue',
  'expenseAmountValue',
] as const;

/**
 * A form field's value, flattened from the value-union the form returns: an
 * amount becomes "12.5 USD", a list item `{value, id, code}` (the id is what a
 * write sends), an exchange rate `{value, operation}`, and scalars stay scalars.
 * An empty value is undefined.
 */
export function formValue(v: Rec | null | undefined): unknown {
  if (!v) return undefined;
  if ('amountValue' in v) return money(v.amountValue as Money | null);
  if ('listItemValue' in v) {
    const item = prune({ value: v.listItemValue, id: v.id, code: v.code });
    return Object.keys(item).length > 0 ? item : undefined;
  }
  if ('listValue' in v) return v.listValue ?? undefined;
  if ('locationValue' in v) return v.locationValue ?? undefined;
  if ('operation' in v) return prune({ value: v.value, operation: v.operation });
  const key = SCALAR_VALUE_KEYS.find((k) => k in v);
  return key ? (v[key] ?? undefined) : undefined;
}

/** What an expense read cannot do without. */
export const EXPENSE_ESSENTIAL = { essential: ['employee.expenseReport.entry'] } as const;
/** What an available-expense page cannot do without. */
export const AVAILABLE_ESSENTIAL = { essential: ['employee.availableExpensesWithPagination'] } as const;

function requireExpense(data: ExpenseData) {
  const report = data.employee?.expenseReport;
  if (!report?.entry) {
    throw new McpToolError('SAP Concur returned no expense with that id on that report for the signed-in user.', {
      hint: 'Check both ids with concur_get_report.',
    });
  }
  return { report, entry: report.entry };
}

function expenseExceptions(data: ExpenseData): Rec[] {
  const ex = data.entryExceptions;
  return [...(ex?.entryExceptions ?? []), ...(ex?.itemizationsExceptions ?? []).flatMap((i) => i.exceptions ?? [])];
}

export function compactExpense(data: ExpenseData) {
  const { report, entry } = requireExpense(data);
  const form = data.existingExpenseForm;
  const fields = (form?.mainForm?.fields ?? [])
    .map((f) => prune({ id: f.id, label: f.label, value: formValue(f.value), required: f.isRequired || undefined }))
    .filter((f) => f.value !== undefined || f.required);
  return {
    expense: prune({
      ...compactEntry(entry.id, entry),
      hotelCheckin: entry.travel?.hotelCheckinDate,
      hotelCheckout: entry.travel?.hotelCheckoutDate,
    }),
    report: prune({
      reportId: report.reportId,
      name: report.reportDetails?.name,
      currency: report.reportDetails?.currencyCode,
      policyId: report.reportDetails?.policy?.id,
      expenseListDetailFormId: report.reportDetails?.policy?.expenseListDetailFormId,
    }),
    expenseTypeId: form?.expenseTypeId,
    editable: form?.mainForm?.isFormEditable,
    fields,
    itemizations: (entry.itemizations ?? []).map((i) =>
      prune({
        id: i.id,
        date: i.transactionDate,
        expenseType: i.expenseType?.name,
        amount: money(i.transactionAmount),
        personal: i.isPersonalExpense || undefined,
      }),
    ),
    comments: (entry.entryComments ?? []).map((c) =>
      prune({ by: personName(c.author), date: c.creationDate, comment: c.comment }),
    ),
    exceptions: expenseExceptions(data).map(compactException),
  };
}

function fullExpense(data: ExpenseData) {
  const { report, entry } = requireExpense(data);
  return {
    expense: entry,
    report: { reportId: report.reportId, ...report.reportDetails },
    form: data.existingExpenseForm,
    exceptions: data.entryExceptions,
  };
}

// ── list_available_expenses ───────────────────────────────────────────────

export interface AvailableExpense {
  id?: string;
  transactionDate?: string | null;
  vendor?: string | null;
  expenseType?: { id?: string; name?: string } | null;
  paymentType?: { name?: string } | null;
  location?: { name?: string | null } | null;
  transactionAmount?: Money | null;
  postedAmount?: Money | null;
  estimatedAmount?: Money | null;
  creditCard?: { cardLastSegment?: string | null } | null;
  receiptImageId?: string | null;
  meta?: (Rec & { missingData?: string[] | null }) | null;
  [key: string]: unknown;
}

export interface AvailableData {
  employee: {
    availableExpensesWithPagination: { availableExpenses: AvailableExpense[] | null; pagination: Rec | null } | null;
  } | null;
}

export function availableOf(data: AvailableData) {
  const page = data.employee?.availableExpensesWithPagination;
  if (!page) throw new McpToolError('SAP Concur returned no available-expense list for the signed-in user.');
  return { availableExpenses: page.availableExpenses ?? [], pagination: page.pagination };
}

export function compactAvailable(e: AvailableExpense) {
  const missing = e.meta?.missingData ?? [];
  return prune({
    id: e.id,
    date: e.transactionDate,
    vendor: e.vendor,
    expenseType: e.expenseType?.name,
    expenseTypeId: e.expenseType?.id,
    paymentType: e.paymentType?.name,
    amount: money(e.transactionAmount),
    posted: money(e.postedAmount),
    estimated: money(e.estimatedAmount),
    location: e.location?.name,
    cardLast4: e.creditCard?.cardLastSegment,
    receiptImageId: e.receiptImageId,
    sources: trueFlags(e.meta),
    missingData: missing.length > 0 ? missing : undefined,
  });
}

// ── registration ──────────────────────────────────────────────────────────

export function registerExpenseTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_get_expense',
    {
      description:
        'Get one expense entry on an SAP Concur report: date, type, vendor, payment type, amounts, location, ' +
        'receipt, itemizations, comments, exceptions, and the expense form fields by label with their current ' +
        'values (list-valued fields include the list item id). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Concur expense', readOnly: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseId: expenseIdParam,
        view: concurView(
          'compact keeps only form fields that have a value or are required (label, id, flattened value) and flattens amounts and names; full returns every selected form-field attribute.',
        ),
      }),
    },
    async ({ reportId, expenseId, view }) => {
      const userId = await client.userId();
      const data = await client.spend<ExpenseData>(GET_EXPENSE, {
        expenseId,
        reportId,
        userId,
        contextRole: CONTEXT_ROLE,
        expenseIdAsID: expenseId,
        reportIdAsID: reportId,
        userIdAsID: userId,
      }, EXPENSE_ESSENTIAL);
      requireExpense(data);
      return respond(
        view,
        data,
        { compact: compactExpense, full: fullExpense },
        { context: 'GetExistingExpenseEntry', untrusted: true },
      );
    },
  );

  server.registerTool(
    'concur_list_available_expenses',
    {
      description:
        'List SAP Concur available expenses — card transactions, e-receipts, mobile/ExpenseIt captures and quick ' +
        'expenses that are not on any report yet. A row whose fields are empty with `missingData` set is a receipt ' +
        'still being read, not an error. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'List Concur available expenses', readOnly: true }),
      inputSchema: z.object({
        page: pageParam,
        size: sizeParam,
        view: concurView(
          'compact flattens amounts, keeps the card last digits and lists true source flags by name; it drops card account/transaction ids, e-receipt ids and the exchange rate.',
        ),
      }),
    },
    async ({ page, size, view }) => {
      const data = await client.spend<AvailableData>(LIST_AVAILABLE_EXPENSES, {
        userId: await client.userId(),
        contextRole: CONTEXT_ROLE,
        page,
        size,
      }, AVAILABLE_ESSENTIAL);
      availableOf(data);
      return respond(
        view,
        data,
        {
          compact: (d) => {
            const { availableExpenses, pagination } = availableOf(d);
            return { availableExpenses: availableExpenses.map(compactAvailable), pagination };
          },
          full: availableOf,
        },
        { context: 'GetAvailableExpenses', untrusted: true },
      );
    },
  );
}
