// Expense-entry writes: create, update, delete, copy, and the available-expense
// writes (move onto a report, delete). Every one is confirm-gated, and every
// one RE-READS afterwards and answers with what Concur now shows under
// `verified`. Once the mutation succeeded the answer is a success (ids + the
// mutation's own response); a failed re-read is a `verificationError`.

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
import { warningsField, type ConcurClient } from '../client.js';
import {
  COPY_EXPENSE,
  CREATE_EXPENSE,
  DELETE_AVAILABLE_EXPENSES,
  EXPENSE_FORM,
  MOVE_AVAILABLE_EXPENSES,
  NEW_EXPENSE_FORM,
  UPDATE_EXPENSE,
} from '../graphql/expense-writes.js';
import { GET_EXPENSE, LIST_AVAILABLE_EXPENSES } from '../graphql/expenses.js';
import { LIST_PAYMENT_TYPES } from '../graphql/lookups.js';
import { DELETE_EXPENSE_ENTRIES } from '../graphql/report-writes.js';
import { GET_REPORT } from '../graphql/reports.js';
import {
  AVAILABLE_ESSENTIAL,
  EXPENSE_ESSENTIAL,
  availableOf,
  compactAvailable,
  compactExpense,
  expenseIdParam,
  type AvailableData,
  type AvailableExpense,
  type ExpenseData,
} from './expenses.js';
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
import { REPORT_ESSENTIAL, compactReport, reportIdParam, vendorOf, type EntrySummary, type ReportPageData } from './reports.js';
import { CONTEXT_ROLE, prune, verify } from './shared.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Custom and org-unit fields: the form-driven ones a caller sets by label. */
const isCustomKey = (id: string) => /^(custom|orgUnit)\d+$/.test(id);

/** The most available-expense pages a preview or re-read walks (100 rows each). */
const MAX_AVAILABLE_PAGES = 10;

// ── params ────────────────────────────────────────────────────────────────

const currencyParam = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'a three-letter ISO currency code')
  .transform((s) => s.toUpperCase());

const customFieldsParam = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    'Other expense-form fields by their LABEL as Concur shows it (or field id, e.g. "custom3"), e.g. {"Project": "Apollo"}. ' +
      'A list-valued field takes the item text or code and is resolved to its list item; a checkbox takes "true"/"false".',
  );

const availableIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'an available-expense id')
  .describe('Available-expense id (`id` from concur_list_available_expenses).');

const commonExpenseArgs = {
  paymentType: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Payment type by id or name (see concur_list_payment_types), e.g. "Cash".'),
  vendor: z.string().max(64).optional().describe('Vendor / merchant name.'),
  businessPurpose: z
    .string()
    .max(500)
    .optional()
    .describe('Business purpose: the item text of a required "Business Purpose" dropdown when the form has one, else free text.'),
  locationId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('City location: the `id` of a match from concur_search_locations.'),
  comment: z.string().max(2000).optional().describe('Expense comment (seen by approvers).'),
  personal: z.boolean().optional().describe('Mark the expense personal (not reimbursable).'),
  fields: customFieldsParam,
};

// ── shared shapes ─────────────────────────────────────────────────────────

interface ReportPolicy {
  id?: string | null;
  name?: string | null;
  currencyCode?: string | null;
  policy?: { id?: string | null; expenseListDetailFormId?: string | null } | null;
}

interface ExpenseType {
  id?: string | null;
  code?: string | null;
  name?: string | null;
  parentName?: string | null;
}

interface NewExpenseData {
  employee: {
    expenseReport: {
      reportId?: string;
      reportDetails:
        | (ReportPolicy & {
            expenseTypes?: ExpenseType[] | null;
            meta?: { isSubmitted?: boolean | null; canAddExpense?: boolean | null } | null;
          })
        | null;
    } | null;
  } | null;
  newExpenseForm?: { mainForm?: { fields?: FormField[] | null } | null } | null;
}

interface ExistingFormData {
  employee: {
    expenseReport: { reportId?: string; reportDetails: ReportPolicy | null; entry: EntrySummary | null } | null;
  } | null;
  existingExpenseForm: {
    expenseId?: string;
    expenseTypeId?: string | null;
    mainForm?: { isFormEditable?: boolean | null; fields?: FormField[] | null } | null;
  } | null;
}

interface PaymentType {
  paymentTypeId?: string | null;
  paymentTypeName?: string | null;
}

/** One field as sent (`wire`), compared (`ident`) and shown (`display`). */
interface Value {
  key: string;
  label: string;
  wire: unknown;
  ident: string;
  display: unknown;
  /** A list field's chosen item (a connected list's lower level searches under it). */
  item?: Picked;
}

type Values = Map<string, Value>;

const scalar = (key: string, label: string, wire: unknown, display: unknown = wire): Value => ({
  key,
  label,
  wire,
  ident: JSON.stringify(wire ?? null),
  display: display ?? null,
});

/** A custom field's value as the web app sends it: a list as `{listItemId, value}`, the rest as `{value}`. */
function customValue(f: FormField, picked: Picked | undefined): Value {
  const label = labelOf(f);
  if (isListField(f)) {
    const wire = { listItemId: picked?.sent ?? null, value: picked?.display ?? null };
    return { key: f.id, label, wire, ident: JSON.stringify(picked?.sent ?? null), display: picked?.display ?? null, item: picked };
  }
  const sent = picked?.sent ?? (f.control === 'CHECKBOX' ? 'false' : null);
  return scalar(f.id, label, { value: sent }, sent);
}

/** Every custom / org-unit field on the form with its current (or default) value. */
function customValues(fields: readonly FormField[]): Values {
  const out: Values = new Map();
  for (const f of fields) if (isCustomKey(f.id)) out.set(f.id, customValue(f, pickedOf(f)));
  return out;
}

/** A custom / org-unit field a person may edit — what `fields` can set. */
const isSettable = (f: FormField) => isCustomKey(f.id) && isEditable(f);

/**
 * Apply `fields` by label, top list level first, so a lower connected level
 * searches under its parent's item. Same-label twins are told apart by
 * chooseField. Answers the values plus the field id each requested name hit.
 */
async function overlayCustom(
  client: ConcurClient,
  form: readonly FormField[],
  base: Values,
  requested: Record<string, string> | undefined,
): Promise<{ values: Values; chosen: Map<string, string> }> {
  const out: Values = new Map(base);
  const settable = form.filter(isSettable).map(labelOf);
  const targets: Array<{ field: FormField; text: string; picked?: Picked }> = [];
  const chosen = new Map<string, string>();
  for (const [name, text] of Object.entries(requested ?? {})) {
    const choice = await chooseField(client, form, name, text, {
      settable: isSettable,
      parentOf: (f) => parentItemOf(form, f, (p) => base.get(p.id)?.item),
    });
    const field = choice?.field;
    if (!field) {
      throw new McpToolError(`This expense form has no field "${name}".`, {
        hint: settable.length > 0 ? `Settable fields: ${settable.join('; ')}.` : 'This expense type has no custom fields.',
      });
    }
    if (!isSettable(field)) {
      throw new McpToolError(`The "${labelOf(field)}" field cannot be set through \`fields\`.`, {
        hint:
          'Use the named arguments (date, amount, vendor, …) for standard fields' +
          (settable.length > 0 ? `; settable custom fields: ${settable.join('; ')}.` : '.'),
      });
    }
    // A lower connected-list level is re-resolved under the parent the overlays choose.
    const reuse = choice.picked && (field.list?.level ?? 1) <= 1;
    targets.push({ field, text, ...(reuse ? { picked: choice.picked } : {}) });
    chosen.set(name, field.id);
  }
  const level = (f: FormField) => f.list?.level ?? 0;
  for (const { field, text, picked: early } of targets.sort((a, b) => level(a.field) - level(b.field))) {
    const picked =
      early ??
      (isListField(field)
        ? await resolveListValue(client, field, text, parentItemOf(form, field, (f) => out.get(f.id)?.item))
        : { sent: text, display: text });
    out.set(field.id, customValue(field, picked));
  }
  return { values: out, chosen };
}

/**
 * The `fields` overlay plus a `businessPurpose` argument routed to the form's
 * required "Business Purpose" dropdown when it has one (as on the live
 * tenant), keyed by the dropdown's id. `routed` says whether it was.
 */
function withBusinessPurpose(form: readonly FormField[], fields: Record<string, string> | undefined, businessPurpose: string | undefined) {
  const dropdown = businessPurpose !== undefined ? businessPurposeList(form, isSettable) : undefined;
  if (!dropdown) return { requested: fields, routed: false };
  return { requested: { [dropdown.id]: businessPurpose!, ...fields }, routed: true };
}

/** REQUIRED fields a person can edit that this write leaves empty (read-only / computed ones skipped by accessMode). */
function missingRequiredOf(form: readonly FormField[], values: Values) {
  const isEmpty = (v: Value | undefined) => !v || v.display === null || v.display === '';
  return form
    .filter((f) => f.isRequired && isEditable(f) && values.has(f.id) && isEmpty(values.get(f.id)))
    .map((f) => ({ label: labelOf(f), field: f.id }));
}

const shown = (values: Iterable<Value>) => [...values].map((v) => ({ label: v.label, field: v.key, value: v.display }));

// ── resolution ────────────────────────────────────────────────────────────

/** The expense type a caller named (id, code, exact name, or a unique name fragment), as `{id, name}`. */
function resolveExpenseType(types: readonly ExpenseType[], text: string): { id: string; name: string } {
  const want = norm(text);
  const withId = types.filter((t): t is ExpenseType & { id: string } => Boolean(t.id));
  const exact = withId.find((t) => norm(t.id) === want || norm(t.code) === want);
  if (exact) return { id: exact.id, name: exact.name || exact.id };
  // Name matches only ever pick named types.
  const named = withId.filter((t) => norm(t.name) === want);
  const candidates = named.length > 0 ? named : withId.filter((t) => norm(t.name).includes(want));
  if (candidates.length === 1) return { id: candidates[0]!.id, name: candidates[0]!.name! };
  const describe = (t: ExpenseType) => `${t.name}${t.parentName ? ` (${t.parentName})` : ''} = ${t.id}`;
  if (candidates.length > 1) {
    throw new McpToolError(`"${text}" matches ${candidates.length} expense types on this report.`, {
      hint: `Pass one id: ${candidates.slice(0, 15).map(describe).join('; ')}.`,
    });
  }
  throw new McpToolError(`"${text}" is not an expense type this report's policy allows.`, {
    hint: 'List the allowed ones with concur_list_expense_types and pass an id or exact name.',
  });
}

function resolvePaymentType(types: readonly PaymentType[], text: string): { id: string; name: string } {
  const want = norm(text);
  const hit =
    types.find((p) => norm(p.paymentTypeId) === want) ??
    types.find((p) => norm(p.paymentTypeName) === want) ??
    (() => {
      const partial = types.filter((p) => norm(p.paymentTypeName).includes(want));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!hit?.paymentTypeId) {
    const names = types.map((p) => `${p.paymentTypeName ?? p.paymentTypeId} = ${p.paymentTypeId}`);
    throw new McpToolError(`"${text}" is not one of your payment types (or matches more than one).`, {
      hint: names.length > 0 ? `Pass one of: ${names.join('; ')}.` : 'See concur_list_payment_types.',
    });
  }
  return { id: hit.paymentTypeId, name: hit.paymentTypeName ?? hit.paymentTypeId };
}

async function paymentTypes(client: ConcurClient, userId: string): Promise<PaymentType[]> {
  const data = await client.spend<{ paymentTypes: PaymentType[] | null }>(LIST_PAYMENT_TYPES, { reportOwnerUserId: userId });
  return data.paymentTypes ?? [];
}

// ── reads ─────────────────────────────────────────────────────────────────

async function readReport(client: ConcurClient, userId: string, reportId: string): Promise<ReportPageData> {
  return client.spend<ReportPageData>(GET_REPORT, { userId, reportId, contextRole: CONTEXT_ROLE }, REPORT_ESSENTIAL);
}

async function readExpense(client: ConcurClient, userId: string, reportId: string, expenseId: string) {
  return client.spend<ExpenseData>(GET_EXPENSE, {
    expenseId,
    reportId,
    userId,
    contextRole: CONTEXT_ROLE,
    expenseIdAsID: expenseId,
    reportIdAsID: reportId,
    userIdAsID: userId,
  }, EXPENSE_ESSENTIAL);
}

/** Every available expense (up to MAX_AVAILABLE_PAGES pages of 100). */
async function readAvailable(client: ConcurClient, userId: string): Promise<AvailableExpense[]> {
  const rows: AvailableExpense[] = [];
  for (let page = 1; page <= MAX_AVAILABLE_PAGES; page++) {
    const data = await client.spend<AvailableData>(LIST_AVAILABLE_EXPENSES, {
      userId,
      contextRole: CONTEXT_ROLE,
      page,
      size: 100,
    }, AVAILABLE_ESSENTIAL);
    const { availableExpenses, pagination } = availableOf(data);
    rows.push(...availableExpenses);
    const totalPages = Number((pagination as { totalPages?: number } | null)?.totalPages ?? 1);
    if (page >= totalPages || availableExpenses.length === 0) break;
  }
  return rows;
}

/** The rows for `ids`, or a refusal naming the ids that are not available expenses. */
function pickAvailable(rows: readonly AvailableExpense[], ids: readonly string[]): AvailableExpense[] {
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length > 0) {
    throw new McpToolError(`Not among your available expenses: ${missing.join(', ')}.`, {
      hint: 'List them with concur_list_available_expenses and pass each row’s `id`.',
    });
  }
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

function requireSuccess(status: { success?: boolean | null } | null | undefined, what: string, hint: string): void {
  if (status?.success !== true) throw new McpToolError(`SAP Concur did not confirm ${what}.`, { hint });
}

/** The expense after a write, as Concur now shows it — plus a plain note when it carries exceptions. */
async function observeExpense(client: ConcurClient, userId: string, reportId: string, expenseId: string) {
  const data = await readExpense(client, userId, reportId, expenseId);
  const expense = compactExpense(data);
  const n = expense.exceptions.length;
  return {
    ...expense,
    ...warningsField(data),
    ...(n > 0
      ? {
          observedExceptions: `Concur saved the expense with ${n} exception(s) — see \`exceptions\` (missing required fields can be set with concur_update_expense).`,
        }
      : {}),
  };
}

// ── registration ──────────────────────────────────────────────────────────

export function registerExpenseWriteTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_create_expense',
    {
      description:
        'Add an expense to an unsubmitted SAP Concur report. The expense form is tenant- and type-specific: pick ' +
        'the expense type by id or name (concur_list_expense_types), give the date and amount (currency defaults ' +
        "to the report's), and optionally payment type, vendor, business purpose, location, comment, the personal " +
        'flag, and other form fields by label (list fields are resolved to their list item). The preview shows every ' +
        'value that will be sent and any required field still empty. Concur saves an expense with missing required ' +
        'fields but attaches exceptions — the answer reports them rather than failing. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Create a Concur expense', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseType: z.string().trim().min(1).describe('Expense type id (e.g. "DUESX") or its name (e.g. "Dues").'),
        date: IsoDate.describe('Transaction date, YYYY-MM-DD.'),
        amount: z.number().finite().describe('Amount in `currency` (the spend currency).'),
        currency: currencyParam.optional().describe("ISO currency code (default: the report's currency)."),
        ...commonExpenseArgs,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { reportId } = args;
      const userId = await client.userId();
      const formVars = (expenseTypeId: string, shouldFetchExpenseForm: boolean) => ({
        reportId,
        userId,
        reportIdAsID: reportId,
        userIdAsID: userId,
        expenseTypeId,
        contextRole: CONTEXT_ROLE,
        shouldFetchExpenseForm,
      });

      const header = await client.spend<NewExpenseData>(NEW_EXPENSE_FORM, formVars(args.expenseType, false), REPORT_ESSENTIAL);
      const details = header.employee?.expenseReport?.reportDetails;
      if (!details) {
        throw new McpToolError('SAP Concur returned no report with that id for the signed-in user.', {
          hint: 'Check the id with concur_list_reports.',
        });
      }
      if (details.meta?.canAddExpense === false) {
        throw new McpToolError(`Expenses cannot be added to report ${reportId} (it may be submitted).`, {
          hint: 'Recall it with concur_recall_report first, or add the expense to an unsubmitted report.',
        });
      }
      const policyId = details.policy?.id;
      if (!policyId) throw new McpToolError('SAP Concur returned no expense policy for that report.');
      const type = resolveExpenseType(details.expenseTypes ?? [], args.expenseType);

      const formData = await client.spend<NewExpenseData>(NEW_EXPENSE_FORM, formVars(type.id, true), {
        essential: ['newExpenseForm.mainForm.fields'],
      });
      const form = formData.newExpenseForm?.mainForm?.fields;
      if (!form) {
        throw new McpToolError(`SAP Concur returned no expense form for type "${type.name}" on that report.`);
      }

      let payment: { id: string; name: string };
      if (args.paymentType) {
        payment = resolvePaymentType(await paymentTypes(client, userId), args.paymentType);
      } else {
        const field = form.find((f) => f.id === 'paymentTypeId' || f.id === 'paymentType');
        const picked = field && pickedOf(field);
        if (!picked) {
          throw new McpToolError('This expense form has no default payment type.', {
            hint: 'Pass `paymentType` (see concur_list_payment_types).',
          });
        }
        payment = { id: picked.sent, name: picked.display };
      }

      const currency = args.currency ?? details.currencyCode ?? undefined;
      if (!currency) throw new McpToolError('Pass `currency`: the report has no currency to default to.');
      const sameCurrency = !details.currencyCode || currency === details.currencyCode;
      const bp = withBusinessPurpose(form, args.fields, args.businessPurpose);
      const { values: custom } = await overlayCustom(client, form, customValues(form), bp.requested);

      // The named values, in the shape the web app's captured create sends them.
      const named: Value[] = [
        scalar('expenseTypeId', 'Expense Type', type.id, type.name),
        scalar('transactionDate', 'Transaction Date', args.date),
        // Routed to the dropdown instead when the form has one (the web app sends this empty then).
        scalar('businessPurpose', 'Business Purpose', bp.routed ? '' : (args.businessPurpose ?? '')),
        scalar('vendorName', 'Vendor', args.vendor ?? ''),
        scalar('locationId', 'Location', args.locationId ?? null),
        scalar('paymentTypeId', 'Payment Type', payment.id, payment.name),
        scalar('transactionAmount', 'Amount', { value: args.amount, currencyCode: currency }, `${args.amount} ${currency}`),
        ...(sameCurrency ? [scalar('exchangeRate', 'Exchange Rate', { operation: 'MULTIPLY', value: 1 }, '1')] : []),
        scalar('taxRateLocation', 'Tax Rate Location', 'HOME'),
        scalar('receiptTypeId', 'Receipt Type', ''),
        scalar('isExpensePartOfTravelAllowance', 'Part of Travel Allowance', false),
        scalar('comment', 'Comment', args.comment ?? ''),
        scalar('isPersonalExpense', 'Personal', args.personal ?? false),
        scalar('receiptImageId', 'Receipt Image', null),
      ];
      const all: Values = new Map([...named.map((v) => [v.key, v] as const), ...custom]);
      const fields = Object.fromEntries([...all.values()].map((v) => [v.key, v.wire]));
      const missingRequired = missingRequiredOf(form, all);

      const variables = {
        userId,
        contextRole: CONTEXT_ROLE,
        reportId,
        expenseTypeId: type.id,
        policyId,
        expenseListDetailFormId: details.policy?.expenseListDetailFormId ?? null,
        taxFields: null,
        fields,
      };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_create_expense',
        action: 'concur.expense.create',
        summary: `Add a ${type.name} expense of ${args.amount} ${currency} to report "${details.name ?? reportId}"`,
        account: userId,
        target: reportId,
        payload: variables,
        preview: {
          fields: shown([...named.filter((v) => v.display !== null && v.display !== ''), ...custom.values()]),
          ...(sameCurrency
            ? {}
            : { exchangeRate: `${currency} differs from the report currency ${details.currencyCode}; Concur applies the exchange rate.` }),
          ...(missingRequired.length > 0
            ? {
                missingRequired,
                caveat: 'Concur will save the expense with a "missing required information" exception until these are set.',
              }
            : {}),
        },
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;

      const created = await client.spend<{ createExpense: { id?: string | null } | null }>(CREATE_EXPENSE, variables, {
        essential: ['createExpense.id'],
      });
      const expenseId = created.createExpense?.id;
      if (!expenseId) {
        throw new McpToolError('SAP Concur accepted the create but returned no expense id.', {
          hint: 'Re-read the report with concur_get_report before creating it again.',
        });
      }
      return untrustedResult({
        created: true,
        reportId,
        expenseId,
        response: created.createExpense,
        ...warningsField(created),
        ...(await verify(() => observeExpense(client, userId, reportId, expenseId))),
      });
    },
  );

  server.registerTool(
    'concur_update_expense',
    {
      description:
        'Change an expense on an unsubmitted SAP Concur report — date, amount/currency, payment type, vendor, ' +
        'business purpose, location, comment, the personal flag, or other form fields by label. Sends only the ' +
        'fields that actually change (the preview shows each from → to). To change the expense TYPE, delete it and ' +
        'create a new one. Answers with the expense as Concur shows it afterwards, including any exceptions. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Update a Concur expense', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseId: expenseIdParam,
        date: IsoDate.optional().describe('New transaction date, YYYY-MM-DD.'),
        amount: z.number().finite().optional().describe('New amount (in `currency`, or the current one).'),
        currency: currencyParam.optional().describe('New ISO currency code.'),
        ...commonExpenseArgs,
        confirmToken: confirmTokenParam,
      }),
    },
    async (args, ctx) => {
      const { reportId, expenseId } = args;
      const userId = await client.userId();
      const data = await client.spend<ExistingFormData>(EXPENSE_FORM, {
        expenseId,
        reportId,
        userId,
        contextRole: CONTEXT_ROLE,
        expenseIdAsID: expenseId,
        reportIdAsID: reportId,
        userIdAsID: userId,
      }, { essential: ['employee.expenseReport.reportDetails', 'employee.expenseReport.entry', 'existingExpenseForm.mainForm.fields'] });
      const report = data.employee?.expenseReport;
      const entry = report?.entry;
      const form = data.existingExpenseForm?.mainForm;
      if (!report?.reportDetails || !entry || !form?.fields) {
        throw new McpToolError('SAP Concur returned no expense with that id on that report for the signed-in user.', {
          hint: 'Check both ids with concur_get_report.',
        });
      }
      if (form.isFormEditable === false) {
        throw new McpToolError(`Expense ${expenseId} is not editable (the report may be submitted).`, {
          hint: 'Recall the report with concur_recall_report first.',
        });
      }
      const policyId = report.reportDetails.policy?.id;
      if (!policyId) throw new McpToolError('SAP Concur returned no expense policy for that report.');

      const formField = (id: string) => form.fields!.find((f) => f.id === id);
      const formScalar = (id: string) => {
        const f = formField(id);
        return f ? pickedOf(f)?.sent : undefined;
      };
      const amount = entry.transactionAmount;
      const before: Values = new Map(
        [
          scalar('transactionDate', 'Transaction Date', entry.transactionDate ?? null),
          scalar('vendorName', 'Vendor', vendorOf(entry) ?? null),
          scalar('paymentTypeId', 'Payment Type', entry.paymentType?.id ?? null, entry.paymentType?.name ?? entry.paymentType?.id),
          scalar(
            'transactionAmount',
            'Amount',
            { value: amount?.value ?? null, currencyCode: amount?.currencyCode ?? null },
            amount?.value !== undefined && amount?.value !== null ? `${amount.value} ${amount.currencyCode ?? ''}`.trim() : null,
          ),
          scalar('locationId', 'Location', entry.location?.id ?? null, entry.location?.name ?? entry.location?.id),
          scalar('isPersonalExpense', 'Personal', entry.isPersonalExpense ?? false),
          scalar('businessPurpose', 'Business Purpose', formScalar('businessPurpose') ?? null),
          scalar('comment', 'Comment', formScalar('comment') ?? null),
          ...customValues(form.fields).values(),
        ].map((v) => [v.key, v] as const),
      );

      const wanted: Value[] = [];
      if (args.date !== undefined) wanted.push(scalar('transactionDate', 'Transaction Date', args.date));
      if (args.vendor !== undefined) wanted.push(scalar('vendorName', 'Vendor', args.vendor));
      const bp = withBusinessPurpose(form.fields, args.fields, args.businessPurpose);
      if (args.businessPurpose !== undefined && !bp.routed) {
        wanted.push(scalar('businessPurpose', 'Business Purpose', args.businessPurpose));
      }
      if (args.comment !== undefined) wanted.push(scalar('comment', 'Comment', args.comment));
      if (args.locationId !== undefined) wanted.push(scalar('locationId', 'Location', args.locationId));
      if (args.personal !== undefined) wanted.push(scalar('isPersonalExpense', 'Personal', args.personal));
      if (args.amount !== undefined || args.currency !== undefined) {
        const value = args.amount ?? amount?.value;
        const currencyCode = args.currency ?? amount?.currencyCode ?? report.reportDetails.currencyCode;
        if (value === undefined || value === null || !currencyCode) {
          throw new McpToolError('Pass both `amount` and `currency`: the expense has no current amount to keep.');
        }
        wanted.push(scalar('transactionAmount', 'Amount', { value, currencyCode }, `${value} ${currencyCode}`));
      }
      if (args.paymentType !== undefined) {
        const p = resolvePaymentType(await paymentTypes(client, userId), args.paymentType);
        wanted.push(scalar('paymentTypeId', 'Payment Type', p.id, p.name));
      }
      const custom = await overlayCustom(client, form.fields, customValues(form.fields), bp.requested);
      for (const id of new Set(custom.chosen.values())) wanted.push(custom.values.get(id)!);

      // Every key `wanted` can hold is seeded in `before`.
      const changed = wanted.filter((v) => before.get(v.key)!.ident !== v.ident);
      if (changed.length === 0) {
        throw new McpToolError('Nothing to change: every field you passed already has that value.', {
          hint: 'Pass at least one field with a new value.',
        });
      }
      const fields = Object.fromEntries(changed.map((v) => [v.key, v.wire]));
      const variables = {
        userId,
        contextRole: CONTEXT_ROLE,
        reportId,
        expenseId,
        expenseTypeId: '',
        policyId,
        expenseListDetailFormId: report.reportDetails.policy?.expenseListDetailFormId ?? null,
        shouldCopyDownFields: false,
        updateRecentExpenseType: false,
        taxFields: null,
        fields,
      };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_update_expense',
        action: 'concur.expense.update',
        summary: `Update expense ${expenseId} on report "${report.reportDetails.name ?? reportId}"`,
        account: userId,
        target: expenseId,
        revision: JSON.stringify(changed.map((v) => [v.key, before.get(v.key)!.ident])),
        payload: variables,
        preview: {
          changes: changed.map((v) => ({ label: v.label, field: v.key, from: before.get(v.key)!.display, to: v.display })),
        },
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{ updateExpense?: unknown }>(UPDATE_EXPENSE, variables);
      return untrustedResult({
        updated: true,
        reportId,
        expenseId,
        changedFields: changed.map((v) => v.label),
        response: res.updateExpense ?? null,
        ...warningsField(res),
        ...(await verify(() => observeExpense(client, userId, reportId, expenseId))),
      });
    },
  );

  server.registerTool(
    'concur_delete_expenses',
    {
      description:
        'Permanently delete one or more expenses from an unsubmitted SAP Concur report. Card transactions return ' +
        'to your available expenses; manually entered expenses and their receipt attachments are gone. Cannot be ' +
        'undone. The preview lists each expense that will be deleted. Re-reads the report afterwards to confirm. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Delete Concur expenses', destructive: true, openWorld: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseIds: z.array(expenseIdParam).min(1).max(50).describe('Expense ids (`expenseId` from concur_get_report).'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, expenseIds, confirmToken }, ctx) => {
      const userId = await client.userId();
      const ids = [...new Set(expenseIds)];
      const current = compactReport(await readReport(client, userId, reportId));
      const missing = ids.filter((id) => !current.entries.some((e) => e.expenseId === id));
      if (missing.length > 0) {
        throw new McpToolError(`Not on report ${reportId}: ${missing.join(', ')}.`, {
          hint: 'List the report’s expenses with concur_get_report.',
        });
      }
      const variables = { userId, contextRole: CONTEXT_ROLE, reportId, expenseIds: ids };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_delete_expenses',
        action: 'concur.expense.delete',
        summary: `Permanently delete ${ids.length} expense(s) from report "${String(current.report.name ?? reportId)}"`,
        account: userId,
        target: reportId,
        payload: variables,
        preview: {
          expensesToDelete: current.entries
            .filter((e) => ids.includes(e.expenseId as string))
            .map((e) => prune({ expenseId: e.expenseId, date: e.date, expenseType: e.expenseType, vendor: e.vendor, amount: e.amount })),
        },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{
        employee: { expenseReport: { deleteExpenseEntries: { status: { success?: boolean } | null } | null } | null } | null;
      }>(DELETE_EXPENSE_ENTRIES, variables);
      requireSuccess(
        res.employee?.expenseReport?.deleteExpenseEntries?.status,
        'deleting the expenses',
        'Re-read the report with concur_get_report to see what actually changed before retrying.',
      );
      return untrustedResult({
        deleted: true,
        reportId,
        deletedExpenseIds: ids,
        response: res.employee?.expenseReport?.deleteExpenseEntries,
        ...warningsField(res),
        ...(await verify(async () => {
          const data = await readReport(client, userId, reportId);
          const after = compactReport(data);
          const stillPresent = ids.filter((id) => after.entries.some((e) => e.expenseId === id));
          return {
            ...(stillPresent.length > 0
              ? { stillPresent, observed: 'Concur reported success but these expenses are still on the report' }
              : { observed: 'the expenses are no longer on the report' }),
            ...after,
            ...warningsField(data),
          };
        })),
      });
    },
  );

  server.registerTool(
    'concur_copy_expense',
    {
      description:
        'Duplicate an expense on an unsubmitted SAP Concur report (same type, amount, vendor and fields; receipts ' +
        'are not copied as the original’s). Answers with the new copy as Concur shows it. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Copy a Concur expense', readOnly: false, destructive: false, openWorld: true }),
      inputSchema: z.object({ reportId: reportIdParam, expenseId: expenseIdParam, confirmToken: confirmTokenParam }),
    },
    async ({ reportId, expenseId, confirmToken }, ctx) => {
      const userId = await client.userId();
      const original = compactExpense(await readExpense(client, userId, reportId, expenseId));
      const variables = {
        userId,
        contextRole: CONTEXT_ROLE,
        reportId,
        expenseId,
        expenseListDetailFormId: original.report.expenseListDetailFormId ?? null,
      };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_copy_expense',
        action: 'concur.expense.copy',
        summary: `Copy expense ${expenseId} on report "${String(original.report.name ?? reportId)}"`,
        account: userId,
        target: expenseId,
        payload: variables,
        preview: {
          expense: prune({
            date: original.expense.date,
            expenseType: original.expense.expenseType,
            vendor: original.expense.vendor,
            amount: original.expense.amount,
          }),
        },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{
        employee: {
          expenseReport: { copyExpenseEntry: { status: { success?: boolean } | null; expenseId?: string | null } | null } | null;
        } | null;
      }>(COPY_EXPENSE, variables);
      const copy = res.employee?.expenseReport?.copyExpenseEntry;
      requireSuccess(copy?.status, 'copying the expense', 'Re-read the report with concur_get_report before copying again.');
      if (!copy?.expenseId) {
        throw new McpToolError('SAP Concur copied the expense but returned no id for the copy.', {
          hint: 'Re-read the report with concur_get_report before copying again.',
        });
      }
      const copyId = copy.expenseId;
      return untrustedResult({
        copied: true,
        reportId,
        fromExpenseId: expenseId,
        expenseId: copyId,
        response: copy,
        ...warningsField(res),
        ...(await verify(() => observeExpense(client, userId, reportId, copyId))),
      });
    },
  );

  server.registerTool(
    'concur_move_available_expenses_to_report',
    {
      description:
        'Move available expenses (card transactions, e-receipts, mobile captures — see concur_list_available_expenses) ' +
        'onto an unsubmitted SAP Concur report, where they become expenses. Concur has no operation that moves them ' +
        'back: removing one later means deleting the expense from the report. The preview lists each row being ' +
        'moved. Re-reads both the report and the available list afterwards. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Move Concur available expenses to a report', destructive: true, openWorld: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        ids: z.array(availableIdParam).min(1).max(50).describe('Available-expense ids to move.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, ids: requested, confirmToken }, ctx) => {
      const userId = await client.userId();
      const ids = [...new Set(requested)];
      const rows = pickAvailable(await readAvailable(client, userId), ids);
      const report = compactReport(await readReport(client, userId, reportId));
      const variables = { userId, contextRole: CONTEXT_ROLE, ids, reportId };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_move_available_expenses_to_report',
        action: 'concur.available.move',
        summary: `Move ${ids.length} available expense(s) onto report "${String(report.report.name ?? reportId)}"`,
        account: userId,
        target: reportId,
        payload: variables,
        preview: { expensesToMove: rows.map(compactAvailable) },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{
        employee: { moveAvailableExpensesToReport: { status: { success?: boolean } | null; errors?: unknown } | null } | null;
      }>(MOVE_AVAILABLE_EXPENSES, variables);
      const move = res.employee?.moveAvailableExpensesToReport;
      const errors = Array.isArray(move?.errors) && move.errors.length > 0 ? move.errors : undefined;
      if (move?.status?.success !== true) {
        throw new McpToolError(
          `SAP Concur did not confirm moving the expenses${errors ? `: ${errors.map(String).join('; ')}` : '.'}`,
          { hint: 'Re-read the report (concur_get_report) and your available expenses before retrying.' },
        );
      }
      return untrustedResult(
        prune({
          moved: true,
          reportId,
          movedIds: ids,
          errors,
          response: move,
          ...warningsField(res),
          ...(await verify(async () => {
            const availableAfter = await readAvailable(client, userId);
            const remaining = ids.filter((id) => availableAfter.some((r) => r.id === id));
            const after = compactReport(await readReport(client, userId, reportId));
            return prune({
              stillAvailable: remaining.length > 0 ? remaining : undefined,
              observed:
                remaining.length === 0
                  ? `the expenses left your available list; the report now has ${after.entries.length} expense(s)`
                  : 'Concur reported success but some expenses are still in your available list',
              ...after,
            });
          })),
        }),
      );
    },
  );

  server.registerTool(
    'concur_delete_available_expenses',
    {
      description:
        'Permanently delete available expenses (not yet on any report — see concur_list_available_expenses), e.g. ' +
        'duplicate mobile captures or quick expenses. Cannot be undone. The preview lists each row. Re-reads the ' +
        'available list afterwards to confirm. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Delete Concur available expenses', destructive: true, openWorld: true }),
      inputSchema: z.object({
        ids: z.array(availableIdParam).min(1).max(50).describe('Available-expense ids to delete.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ ids: requested, confirmToken }, ctx) => {
      const userId = await client.userId();
      const ids = [...new Set(requested)];
      const rows = pickAvailable(await readAvailable(client, userId), ids);
      const variables = { userId, contextRole: CONTEXT_ROLE, ids };

      const gate = await confirmWrite(ctx, {
        tool: 'concur_delete_available_expenses',
        action: 'concur.available.delete',
        summary: `Permanently delete ${ids.length} available expense(s)`,
        account: userId,
        payload: variables,
        preview: { expensesToDelete: rows.map(compactAvailable) },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{
        employee: { deleteAvailableExpenses: { status: { success?: boolean } | null } | null } | null;
      }>(DELETE_AVAILABLE_EXPENSES, variables);
      requireSuccess(
        res.employee?.deleteAvailableExpenses?.status,
        'deleting the available expenses',
        'Re-read them with concur_list_available_expenses before retrying.',
      );
      return untrustedResult({
        deleted: true,
        deletedIds: ids,
        response: res.employee?.deleteAvailableExpenses,
        ...warningsField(res),
        ...(await verify(async () => {
          const after = await readAvailable(client, userId);
          const remaining = ids.filter((id) => after.some((r) => r.id === id));
          return prune({
            stillAvailable: remaining.length > 0 ? remaining : undefined,
            observed:
              remaining.length === 0
                ? 'the expenses are no longer in your available list'
                : 'Concur reported success but some expenses are still in your available list',
            availableRemaining: after.length,
          });
        })),
      });
    },
  );
}
