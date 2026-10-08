import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import {
  COPY_EXPENSE,
  CREATE_EXPENSE,
  DELETE_AVAILABLE_EXPENSES,
  EXPENSE_FORM,
  MOVE_AVAILABLE_EXPENSES,
  NEW_EXPENSE_FORM,
  UPDATE_EXPENSE,
} from '../src/graphql/expense-writes.js';
import { GET_EXPENSE, LIST_AVAILABLE_EXPENSES } from '../src/graphql/expenses.js';
import { LIST_ITEMS } from '../src/graphql/forms.js';
import { LIST_PAYMENT_TYPES } from '../src/graphql/lookups.js';
import { DELETE_EXPENSE_ENTRIES } from '../src/graphql/report-writes.js';
import { GET_REPORT } from '../src/graphql/reports.js';
import type { FormField } from '../src/tools/forms.js';
import { registerExpenseWriteTools } from '../src/tools/expense-writes.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload } from './helpers.js';

const RID = '0123456789ABCDEF0123';
const E1 = '0123456789abcdef0123456789abcdef';
const E2 = 'fedcba9876543210fedcba9876543210';
const E3 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string; willSend: Record<string, unknown> & { fields: Record<string, unknown> } };
}

const isMutation = (q: string) => /^\s*mutation\b/.test(q);

/** Phase 1 only: the preview (or refusal), and proof nothing was written. */
async function preview(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerExpenseWriteTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  const text = textOf(result);
  return { result, text, sent: t.sent, parsed: () => parseToolResult<Preview>(result) };
}

/** Both phases: preview (no writes), then the same args + token. */
async function confirmed(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerExpenseWriteTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1), jwt: t.jwt };
}

/** The live failure: the post-write re-read answered only errors[] (e.g. a legacy field like rptKey). */
const failedReRead = () =>
  new Response(JSON.stringify({ data: null, errors: [fieldError(['employee', 'expenseReport'], 'corr-reread')] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A success result whose re-read failed: no error flag, and a verificationError instead of `verified`. */
function expectUnverifiedSuccess(result: unknown, text: string) {
  expect((result as { isError?: boolean }).isError).toBeFalsy();
  const out = untrustedPayload(text);
  expect(out.verified).toBeUndefined();
  expect(out.verificationError).toMatch(/The change was made, but re-reading it failed: .*correlationId=corr-reread/);
  return out;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const usd = (value: number) => ({ value, currencyCode: 'USD' });

const TYPES = [
  { id: 'DUESX', code: 'DUESX', name: 'Dues', parentName: 'Fees' },
  { id: 'MEALB', code: 'MEALB', name: 'Meals - Business', parentName: 'Meals' },
  { id: 'MEALT', code: 'MEALT', name: 'Meals - Team', parentName: null },
];

const header = (over: Record<string, unknown> = {}) => ({
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: {
        id: RID,
        name: 'October travel',
        currencyCode: 'USD',
        policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' },
        expenseTypes: TYPES,
        meta: { isSubmitted: false, canAddExpense: true },
        ...over,
      },
    },
  },
});

const FORM: FormField[] = [
  { id: 'paymentTypeId', label: 'Payment Type', value: null, defaultValue: { value: 'Cash', code: 'CASH', listItemId: 'CASH' } },
  { id: 'businessPurpose', label: 'Business Purpose', accessMode: 'READ_WRITE', isRequired: true, value: null },
  { id: 'custom1', label: 'Project', accessMode: 'READ_WRITE', list: { id: 'LST_PRJ', level: 1, defaultSearchBy: 'TEXT' }, value: null },
  { id: 'custom2', label: 'Sub-project', accessMode: 'READ_WRITE', list: { id: 'LST_PRJ', level: 2, defaultSearchBy: 'TEXT' }, value: null },
  { id: 'custom15', label: 'Billable', control: 'CHECKBOX', accessMode: 'READ_WRITE', value: null },
  { id: 'custom7', label: 'Ticket', accessMode: 'READ_WRITE', isRequired: true, value: null },
  {
    id: 'custom9',
    label: 'Region',
    accessMode: 'READ_WRITE',
    options: [{ id: 'R_E', code: 'E', value: 'East' }],
    value: { code: 'E', id: 'R_E', listItemValue: 'East' },
  },
  { id: 'custom20', label: 'Cost Center', accessMode: 'RO', value: { stringValue: '012345' } },
  { id: 'vendorName', label: 'Vendor', accessMode: 'READ_WRITE', isRequired: true, value: null },
];

const newForm = (fields: FormField[] | null = FORM, over: Record<string, unknown> = {}) => ({
  ...header(over),
  newExpenseForm: fields ? { mainForm: { fields } } : null,
});

const payments = { paymentTypes: [{ paymentTypeId: 'CASH', paymentTypeName: 'Cash' }, { paymentTypeId: 'CBCP', paymentTypeName: 'Company Card' }] };
const items = (...list: Array<[string, string, string]>) => ({
  CDS_spend: { list: { items: list.map(([id, code, value]) => ({ id, code, value })) } },
});
const prjItems = items(['PRJ_A', 'A', 'Apollo'], ['PRJ_Z', 'Z', 'Zeus']);
const subItems = items(['SUB_B', 'B', 'Beta']);

const expenseData = (id: string, exceptions: unknown[] = []) => ({
  entryExceptions: { entryExceptions: exceptions, itemizationsExceptions: [] },
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: { id: RID, name: 'October travel', currencyCode: 'USD', policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' } },
      entry: {
        id,
        transactionDate: '2026-10-02',
        expenseType: { id: 'DUESX', name: 'Dues' },
        vendor: { description: 'Acme' },
        transactionAmount: usd(12.5),
      },
    },
  },
  existingExpenseForm: { expenseTypeId: 'DUESX', mainForm: { isFormEditable: true, fields: [] } },
});

const entry = (expenseId: string) => ({
  expenseId,
  summary: { id: expenseId, transactionDate: '2026-10-02', expenseType: { id: 'DUESX', name: 'Dues' }, vendor: { description: 'Acme' }, transactionAmount: usd(12.5) },
});

const reportData = (entries: unknown[] = [], name: string | null = 'October travel') => ({
  employee: {
    userId: SUB,
    expenseReport: { reportId: RID, reportDetails: { id: RID, name, policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' } } },
  },
  reportEntriesDetails: { reportId: RID, entries },
  reportExceptions: { reportId: RID, reportExceptions: [], entryExceptions: [] },
});

const avRow = (id: string) => ({
  id,
  transactionDate: '2026-10-01',
  vendor: 'Hotel',
  transactionAmount: usd(200),
  meta: { hasSourceCreditCard: true, missingData: [] },
});
const avPage = (rows: unknown[], number = 1, totalPages: number | null = 1) => ({
  employee: {
    availableExpensesWithPagination: {
      availableExpenses: rows,
      pagination: totalPages === null ? null : { number, size: 100, totalElements: rows.length, totalPages },
    },
  },
});

// ── annotations ───────────────────────────────────────────────────────────

describe('expense write tools', () => {
  it('are all confirm-gated writes with truthful destructive hints', async () => {
    const t = await toolHarness(registerExpenseWriteTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.destructiveHint]));
    expect(hints).toEqual({
      concur_create_expense: false,
      concur_update_expense: false,
      concur_delete_expenses: true,
      concur_copy_expense: false,
      concur_move_available_expenses_to_report: true,
      concur_delete_available_expenses: true,
    });
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('confirmToken');
      expect(tool.description).toMatch(/confirmToken/);
    }
  });
});

// ── create ────────────────────────────────────────────────────────────────

describe('concur_create_expense', () => {
  const base = { reportId: RID, expenseType: 'dues', date: '2026-10-02', amount: 12.5 };

  it('resolves type, payment and list fields, previews every value, creates, then re-reads', async () => {
    const args = {
      ...base,
      vendor: 'Acme',
      businessPurpose: 'Club dues',
      paymentType: 'cash',
      locationId: 'LOC1',
      comment: 'annual',
      personal: false,
      // Lower list level first on purpose: the top level must still resolve first.
      fields: { 'Sub-project': 'beta', project: 'apollo', Billable: 'true', Ticket: 'T-1' },
    };
    const phase = [header(), newForm(), payments, prjItems, subItems];
    const { preview: p, text, sent, jwt } = await confirmed('concur_create_expense', args, [
      ...phase,
      ...phase,
      { createExpense: { id: E1 } },
      expenseData(E1),
    ]);
    const fields = {
      expenseTypeId: 'DUESX',
      transactionDate: '2026-10-02',
      businessPurpose: 'Club dues',
      vendorName: 'Acme',
      locationId: 'LOC1',
      paymentTypeId: 'CASH',
      transactionAmount: { value: 12.5, currencyCode: 'USD' },
      exchangeRate: { operation: 'MULTIPLY', value: 1 },
      taxRateLocation: 'HOME',
      receiptTypeId: '',
      isExpensePartOfTravelAllowance: false,
      comment: 'annual',
      isPersonalExpense: false,
      receiptImageId: null,
      custom1: { listItemId: 'PRJ_A', value: 'Apollo' },
      custom2: { listItemId: 'SUB_B', value: 'Beta' },
      custom15: { value: 'true' },
      custom7: { value: 'T-1' },
      custom9: { listItemId: 'R_E', value: 'East' },
      custom20: { value: '012345' },
    };
    const variables = {
      userId: SUB,
      contextRole: 'TRAVELER',
      reportId: RID,
      expenseTypeId: 'DUESX',
      policyId: 'POL1',
      expenseListDetailFormId: 'FORM1',
      taxFields: null,
      fields,
    };
    expect(p.preview.willSend).toEqual(variables);
    expect(p.preview.action).toContain('Add a Dues expense of 12.5 USD to report "October travel"');
    expect(p.preview.missingRequired).toBeUndefined();
    expect(p.preview.fields).toEqual(
      expect.arrayContaining([
        { label: 'Expense Type', field: 'expenseTypeId', value: 'Dues' },
        { label: 'Payment Type', field: 'paymentTypeId', value: 'Cash' },
        { label: 'Amount', field: 'transactionAmount', value: '12.5 USD' },
        { label: 'Project', field: 'custom1', value: 'Apollo' },
        { label: 'Sub-project', field: 'custom2', value: 'Beta' },
        { label: 'Region', field: 'custom9', value: 'East' },
      ]),
    );

    expect(sent.map((s) => s.query)).toEqual([
      NEW_EXPENSE_FORM,
      NEW_EXPENSE_FORM,
      LIST_PAYMENT_TYPES,
      LIST_ITEMS,
      LIST_ITEMS,
      CREATE_EXPENSE,
      GET_EXPENSE,
    ]);
    const formVars = { reportId: RID, userId: SUB, reportIdAsID: RID, userIdAsID: SUB, contextRole: 'TRAVELER' };
    expect(sent[0]!.variables).toEqual({ ...formVars, expenseTypeId: 'dues', shouldFetchExpenseForm: false });
    expect(sent[1]!.variables).toEqual({ ...formVars, expenseTypeId: 'DUESX', shouldFetchExpenseForm: true });
    expect(sent[2]!.variables).toEqual({ reportOwnerUserId: SUB });
    expect(sent[3]!.variables.listInformation).toEqual({ id: 'LST_PRJ', parentListItemId: null, searchBy: 'TEXT', searchByCriteria: 'apollo' });
    expect(sent[4]!.variables.listInformation).toEqual({ id: 'LST_PRJ', parentListItemId: 'PRJ_A', searchBy: 'TEXT', searchByCriteria: 'beta' });
    expect(sent[5]!.variables).toEqual(variables);
    expect(sent[6]!.variables).toMatchObject({ expenseId: E1, reportId: RID, userId: SUB });

    expect(text).not.toContain(jwt);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({
      created: true,
      reportId: RID,
      expenseId: E1,
      response: { id: E1 },
      verified: { expense: { expenseId: E1, vendor: 'Acme' } },
    });
    expect((out.verified as Record<string, unknown>).observedExceptions).toBeUndefined();
  });

  it('a create whose re-read fails is STILL a success, with the new expenseId', async () => {
    const { result, text } = await confirmed('concur_create_expense', { ...base, expenseType: 'DUESX', amount: 10 }, [
      header(),
      newForm(),
      header(),
      newForm(),
      { createExpense: { id: E1 } },
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ created: true, reportId: RID, expenseId: E1, response: { id: E1 } });
  });

  it('a pre-read with a failed sub-field still builds the preview', async () => {
    const { parsed } = await preview('concur_create_expense', { ...base, expenseType: 'DUESX', amount: 10 }, [
      gqlPartial(header(), fieldError(['employee', 'expenseReport', 'rptKey'])),
      newForm(),
    ]);
    expect(parsed().status).toBe('confirmation-required');
  });

  it('defaults payment from the form, leaves a foreign rate to Concur, flags required gaps, and reports exceptions', async () => {
    const args = { ...base, expenseType: 'DUESX', amount: 10, currency: 'eur' };
    const { preview: p, text, sent } = await confirmed('concur_create_expense', args, [
      header(),
      newForm(),
      header(),
      newForm(),
      { createExpense: { id: E1 } },
      expenseData(E1, [{ message: 'Missing required information', exceptionCode: 'MISS', isBlocking: false }]),
    ]);
    expect(p.preview.willSend.fields).toMatchObject({
      paymentTypeId: 'CASH',
      transactionAmount: { value: 10, currencyCode: 'EUR' },
      vendorName: '',
      custom1: { listItemId: null, value: null },
      custom15: { value: 'false' },
      custom7: { value: null },
    });
    expect(p.preview.willSend.fields.exchangeRate).toBeUndefined();
    expect(p.preview.exchangeRate).toMatch(/EUR differs from the report currency USD/);
    expect(p.preview.missingRequired).toEqual([
      { label: 'Business Purpose', field: 'businessPurpose' },
      { label: 'Ticket', field: 'custom7' },
      { label: 'Vendor', field: 'vendorName' },
    ]);
    expect(p.preview.caveat).toMatch(/missing required information/);
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, CREATE_EXPENSE, GET_EXPENSE]);
    const out = untrustedPayload(text).verified as Record<string, unknown>;
    expect(out.observedExceptions).toMatch(/1 exception/);
    expect(out.exceptions).toEqual([{ message: 'Missing required information', code: 'MISS' }]);
  });

  it('defaults the currency to the report’s and treats a report without one as same-currency', async () => {
    const { parsed } = await preview('concur_create_expense', { ...base, currency: 'GBP' }, [
      header({ currencyCode: null }),
      newForm(FORM, { currencyCode: null }),
    ]);
    expect(parsed().preview.willSend.fields.exchangeRate).toEqual({ operation: 'MULTIPLY', value: 1 });
  });

  it.each([
    ['Meals - Team', 'MEALT'],
    ['meals - b', 'MEALB'],
    ['mealb', 'MEALB'],
  ])('resolves expense type %s', async (expenseType, id) => {
    const { sent } = await preview('concur_create_expense', { ...base, expenseType }, [header(), newForm()]);
    expect(sent[1]!.variables.expenseTypeId).toBe(id);
  });

  it.each([
    ['meals', TYPES, 'matches 2 expense types', 'Meals - Business (Meals) = MEALB; Meals - Team = MEALT'],
    ['dup', [{ id: 'D1', name: 'Dup' }, { id: 'D2', name: 'dup' }, { id: 'D3', name: null }], 'matches 2 expense types', 'Dup = D1; dup = D2'],
    ['zzz', TYPES, 'is not an expense type', 'concur_list_expense_types'],
    ['zzz', null, 'is not an expense type', 'concur_list_expense_types'],
  ])('refuses expense type %s', async (expenseType, expenseTypes, message, hint) => {
    const { text, sent } = await preview('concur_create_expense', { ...base, expenseType }, [header({ expenseTypes })]);
    expect(sent).toHaveLength(1);
    expect(text).toContain(message);
    expect(text).toContain(hint);
  });

  it('names a type without a name by its id when it is ambiguous', async () => {
    const { text } = await preview('concur_create_expense', { ...base, expenseType: 'x' }, [
      header({ expenseTypes: [{ id: 'X1', name: 'x1' }, { id: 'X2', name: null, code: 'Q' }, { id: 'X3', name: 'xx' }] }),
    ]);
    expect(text).toContain('x1 = X1; xx = X3');
  });

  it.each([
    [{ employee: { expenseReport: null } }, 'no report with that id'],
    [header({ meta: { canAddExpense: false } }), 'cannot be added to report'],
    [header({ policy: null }), 'no expense policy'],
  ])('refuses a report it cannot add to (%#)', async (data, message) => {
    const { text } = await preview('concur_create_expense', base, [data]);
    expect(text).toContain(message);
  });

  it('names an unnamed type by its id, an unnamed report by its id, and sends a missing form id as null', async () => {
    const over = { name: null, policy: { id: 'POL1' }, expenseTypes: [...TYPES, { id: 'NONAME', code: null, name: null }] };
    const { parsed } = await preview('concur_create_expense', { ...base, expenseType: 'noname' }, [header(over), newForm(FORM, over)]);
    const p = parsed().preview;
    expect(p.action).toContain(`Add a NONAME expense of 12.5 USD to report "${RID}"`);
    expect(p.willSend.expenseListDetailFormId).toBeNull();
    expect(p.fields).toEqual(expect.arrayContaining([{ label: 'Expense Type', field: 'expenseTypeId', value: 'NONAME' }]));
  });

  it('refuses when Concur returns no form for the type', async () => {
    const { text } = await preview('concur_create_expense', base, [header(), newForm(null)]);
    expect(text).toContain('no expense form for type "Dues"');
  });

  it('asks for a payment type when the form has no default', async () => {
    const form = FORM.filter((f) => f.id !== 'paymentTypeId');
    const { text } = await preview('concur_create_expense', base, [header(), newForm(form)]);
    expect(text).toContain('no default payment type');
    const empty = FORM.map((f) => (f.id === 'paymentTypeId' ? { ...f, defaultValue: null } : f));
    const again = await preview('concur_create_expense', base, [header(), newForm(empty)]);
    expect(again.text).toContain('no default payment type');
  });

  it.each([
    ['bitcoin', payments, 'Pass one of: Cash = CASH; Company Card = CBCP.'],
    ['card', { paymentTypes: [{ paymentTypeId: 'C1', paymentTypeName: 'Card A' }, { paymentTypeId: 'C2', paymentTypeName: 'Card B' }, { paymentTypeId: 'C3', paymentTypeName: null }] }, 'Card A = C1; Card B = C2; C3 = C3'],
    ['x', { paymentTypes: null }, 'See concur_list_payment_types.'],
  ])('refuses payment type %s', async (paymentType, list, hint) => {
    const { text } = await preview('concur_create_expense', { ...base, paymentType }, [header(), newForm(), list]);
    expect(text).toContain(`"${paymentType}" is not one of your payment types`);
    expect(text).toContain(hint);
  });

  it('resolves a payment type by a unique name fragment, and names an unnamed one by id', async () => {
    const { parsed } = await preview('concur_create_expense', { ...base, paymentType: 'company' }, [header(), newForm(), payments]);
    expect(parsed().preview.willSend.fields.paymentTypeId).toBe('CBCP');
    const unnamed = await preview('concur_create_expense', { ...base, paymentType: 'P9' }, [
      header(),
      newForm(),
      { paymentTypes: [{ paymentTypeId: 'P9', paymentTypeName: null }] },
    ]);
    expect(unnamed.parsed().preview.fields).toEqual(expect.arrayContaining([{ label: 'Payment Type', field: 'paymentTypeId', value: 'P9' }]));
  });

  it('refuses when neither the caller nor the report gives a currency', async () => {
    const { text } = await preview('concur_create_expense', base, [header({ currencyCode: null }), newForm(FORM, { currencyCode: null })]);
    expect(text).toContain('Pass `currency`');
  });

  it.each([
    [{ Nope: 'x' }, FORM, 'This expense form has no field "Nope".', 'Settable fields: Project; Sub-project; Billable; Ticket; Region.'],
    [{ Vendor: 'x' }, FORM, 'The "Vendor" field cannot be set through `fields`.', 'settable custom fields: Project;'],
    [{ 'Cost Center': 'x' }, FORM, 'The "Cost Center" field cannot be set through `fields`.', 'Region.'],
    [{ Nope: 'x' }, FORM.slice(0, 2), 'no field "Nope"', 'This expense type has no custom fields.'],
    [{ 'Business Purpose': 'x' }, FORM.slice(0, 2), 'cannot be set through', 'for standard fields.'],
  ])('refuses fields %j', async (fields, form, message, hint) => {
    const { text } = await preview('concur_create_expense', { ...base, paymentType: 'cash', fields }, [header(), newForm(form), payments]);
    expect(text).toContain(message);
    expect(text).toContain(hint);
  });

  it('reports a create that returned no id instead of claiming success', async () => {
    const { text, sent } = await confirmed('concur_create_expense', base, [header(), newForm(), header(), newForm(), { createExpense: null }]);
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, CREATE_EXPENSE]);
    expect(text).toContain('returned no expense id');
  });
});

// ── a "Business Purpose" dropdown on the expense form ─────────────────────

describe('expense forms with a "Business Purpose" dropdown', () => {
  const base = { reportId: RID, expenseType: 'DUESX', date: '2026-10-02', amount: 12.5, paymentType: 'Cash' };
  // The same pattern as the live report header: a free-text field plus a required list.
  const dropdown: FormField = {
    id: 'custom3',
    label: 'Business Purpose',
    dataType: 'LIST',
    isRequired: true,
    accessMode: 'READ_WRITE',
    list: { id: 'LST_BP', level: 1, defaultSearchBy: 'TEXT' },
    value: null,
  };
  const twins: FormField[] = [
    { id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', accessMode: 'READ_WRITE', value: null },
    dropdown,
    { id: 'custom20', label: 'Cost Center', accessMode: 'RO', isRequired: true, value: null },
  ];
  const meetings = items(['BP_IME', 'IME', 'Internal Meetings/Expenses']);

  it('create: businessPurpose goes to the dropdown; read-only required fields are not "missing"', async () => {
    const { parsed, sent } = await preview('concur_create_expense', { ...base, businessPurpose: 'Internal Meetings/Expenses' }, [
      header(),
      newForm(twins),
      payments,
      meetings,
    ]);
    const p = parsed().preview;
    expect(p.willSend.fields).toMatchObject({
      businessPurpose: '',
      custom3: { listItemId: 'BP_IME', value: 'Internal Meetings/Expenses' },
    });
    expect(p.missingRequired).toBeUndefined();
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, LIST_PAYMENT_TYPES, LIST_ITEMS]);
  });

  it('create: fields {"Business Purpose": …} picks the dropdown twin too', async () => {
    const { parsed } = await preview('concur_create_expense', { ...base, fields: { 'Business Purpose': 'IME' } }, [
      header(),
      newForm(twins),
      payments,
      meetings,
    ]);
    expect(parsed().preview.willSend.fields).toMatchObject({ custom3: { listItemId: 'BP_IME' } });
  });

  it('non-required twins: the one whose list holds the text wins (a pick list, resolved once)', async () => {
    const form: FormField[] = [
      { id: 'custom11', label: 'Tier', accessMode: 'READ_WRITE', value: null },
      { id: 'custom12', label: 'Tier', accessMode: 'READ_WRITE', options: [{ id: 'T_G', code: 'G', value: 'Gold' }], value: null },
      { id: 'custom13', label: 'Team', accessMode: 'READ_WRITE', value: null },
      { id: 'custom14', label: 'Team', accessMode: 'READ_WRITE', list: { id: 'LST_T', level: 2, defaultSearchBy: 'TEXT' }, value: null },
      {
        id: 'custom16',
        label: 'Department',
        accessMode: 'READ_WRITE',
        list: { id: 'LST_T', level: 1 },
        value: null,
        defaultValue: { value: 'Engineering', code: 'ENG', listItemId: 'D_ENG' },
      },
    ];
    const qa = items(['T_QA', 'QA', 'QA']);
    const { parsed, sent } = await preview('concur_create_expense', { ...base, fields: { Tier: 'gold', Team: 'qa' } }, [
      header(),
      newForm(form),
      payments,
      qa,
      qa,
    ]);
    expect(parsed().preview.willSend.fields).toMatchObject({
      custom12: { listItemId: 'T_G', value: 'Gold' },
      custom14: { listItemId: 'T_QA', value: 'QA' },
    });
    // Tier resolved locally; Team (a lower list level) looked up while choosing, then again under its parent.
    const lookups = sent.filter((s) => s.query === LIST_ITEMS);
    expect(lookups).toHaveLength(2);
    expect(lookups[0]!.variables.listInformation).toMatchObject({ id: 'LST_T', parentListItemId: 'D_ENG' });
  });

  it('create without a purpose flags the dropdown as missing', async () => {
    const { parsed } = await preview('concur_create_expense', base, [header(), newForm(twins), payments]);
    expect(parsed().preview.missingRequired).toEqual([{ label: 'Business Purpose', field: 'custom3' }]);
  });

  it('update: businessPurpose changes the dropdown, not the free-text field', async () => {
    const data = expenseData(E1);
    data.existingExpenseForm.mainForm.fields = twins as never;
    const { parsed } = await preview(
      'concur_update_expense',
      { reportId: RID, expenseId: E1, businessPurpose: 'Internal Meetings/Expenses' },
      [data, meetings],
    );
    const p = parsed().preview;
    expect(p.willSend.fields).toEqual({ custom3: { listItemId: 'BP_IME', value: 'Internal Meetings/Expenses' } });
    expect(p.changes).toEqual([{ label: 'Business Purpose', field: 'custom3', from: null, to: 'Internal Meetings/Expenses' }]);
  });
});

// ── update ────────────────────────────────────────────────────────────────

describe('concur_update_expense', () => {
  const existing = (over: { entry?: Record<string, unknown> | null; form?: Record<string, unknown> | null; details?: Record<string, unknown> } = {}) => ({
    employee: {
      userId: SUB,
      expenseReport: {
        reportId: RID,
        reportDetails: {
          id: RID,
          name: 'October travel',
          currencyCode: 'USD',
          policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' },
          ...over.details,
        },
        entry:
          over.entry === null
            ? null
            : {
                id: E1,
                transactionDate: '2026-10-02',
                paymentType: { id: 'CASH', name: 'Cash' },
                vendor: { description: 'Acme' },
                transactionAmount: usd(12.5),
                location: { id: 'LOC1', name: 'Toronto' },
                isPersonalExpense: false,
                ...over.entry,
              },
      },
    },
    existingExpenseForm:
      over.form === null
        ? null
        : {
            expenseId: E1,
            expenseTypeId: 'DUESX',
            mainForm: {
              isFormEditable: true,
              fields: [
                { id: 'businessPurpose', label: 'Business Purpose', accessMode: 'READ_WRITE', value: { stringValue: 'Dues' } },
                { id: 'comment', label: 'Comment', accessMode: 'READ_WRITE', value: null },
                {
                  id: 'custom1',
                  label: 'Project',
                  accessMode: 'READ_WRITE',
                  list: { id: 'LST_PRJ', level: 1, defaultSearchBy: 'TEXT' },
                  value: { code: 'A', id: 'PRJ_A', listItemValue: 'Apollo' },
                },
                { id: 'custom7', label: 'Ticket', accessMode: 'READ_WRITE', value: { stringValue: 'T-1' } },
              ],
              ...over.form,
            },
          },
  });
  const ids = { reportId: RID, expenseId: E1 };

  it('sends only the fields that change and previews each from → to, then re-reads', async () => {
    const args = {
      ...ids,
      date: '2026-10-03',
      amount: 20,
      vendor: 'Acme',
      businessPurpose: 'Dues',
      comment: 'hi',
      locationId: 'LOC2',
      personal: true,
      paymentType: 'Company Card',
      fields: { Project: 'zeus', Ticket: 'T-1' },
    };
    const phase = [existing(), payments, prjItems];
    const { preview: p, text, sent } = await confirmed('concur_update_expense', args, [
      ...phase,
      ...phase,
      { updateExpense: { id: E1 } },
      expenseData(E1),
    ]);
    const variables = {
      userId: SUB,
      contextRole: 'TRAVELER',
      reportId: RID,
      expenseId: E1,
      expenseTypeId: '',
      policyId: 'POL1',
      expenseListDetailFormId: 'FORM1',
      shouldCopyDownFields: false,
      updateRecentExpenseType: false,
      taxFields: null,
      fields: {
        transactionDate: '2026-10-03',
        comment: 'hi',
        locationId: 'LOC2',
        isPersonalExpense: true,
        transactionAmount: { value: 20, currencyCode: 'USD' },
        paymentTypeId: 'CBCP',
        custom1: { listItemId: 'PRJ_Z', value: 'Zeus' },
      },
    };
    expect(p.preview.willSend).toEqual(variables);
    expect(p.preview.changes).toEqual([
      { label: 'Transaction Date', field: 'transactionDate', from: '2026-10-02', to: '2026-10-03' },
      { label: 'Comment', field: 'comment', from: null, to: 'hi' },
      { label: 'Location', field: 'locationId', from: 'Toronto', to: 'LOC2' },
      { label: 'Personal', field: 'isPersonalExpense', from: false, to: true },
      { label: 'Amount', field: 'transactionAmount', from: '12.5 USD', to: '20 USD' },
      { label: 'Payment Type', field: 'paymentTypeId', from: 'Cash', to: 'Company Card' },
      { label: 'Project', field: 'custom1', from: 'Apollo', to: 'Zeus' },
    ]);
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM, LIST_PAYMENT_TYPES, LIST_ITEMS, UPDATE_EXPENSE, GET_EXPENSE]);
    expect(sent[0]!.variables).toEqual({
      expenseId: E1,
      reportId: RID,
      userId: SUB,
      contextRole: 'TRAVELER',
      expenseIdAsID: E1,
      reportIdAsID: RID,
      userIdAsID: SUB,
    });
    expect(sent[3]!.variables).toEqual(variables);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ updated: true, reportId: RID, expenseId: E1, response: { id: E1 } });
    expect(out.changedFields).toEqual(['Transaction Date', 'Comment', 'Location', 'Personal', 'Amount', 'Payment Type', 'Project']);
    expect((out.verified as { expense: unknown }).expense).toBeDefined();
  });

  it('an update whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed('concur_update_expense', { ...ids, vendor: 'New' }, [
      existing(),
      existing(),
      {},
      failedReRead(),
    ]);
    const out = expectUnverifiedSuccess(result, text);
    expect(out).toMatchObject({ updated: true, expenseId: E1, changedFields: ['Vendor'], response: null });
  });

  it('changes only the currency, keeping the amount', async () => {
    const { parsed } = await preview('concur_update_expense', { ...ids, currency: 'cad' }, [existing()]);
    expect(parsed().preview.willSend.fields).toEqual({ transactionAmount: { value: 12.5, currencyCode: 'CAD' } });
  });

  it('reads an expense with no amount, vendor, location or payment as empty', async () => {
    const bare = existing({
      entry: { transactionDate: null, paymentType: null, vendor: null, transactionAmount: null, location: null, isPersonalExpense: null },
    });
    const { parsed } = await preview('concur_update_expense', { ...ids, amount: 5, vendor: 'V', personal: false, date: '2026-10-01' }, [bare]);
    expect(parsed().preview.changes).toEqual([
      { label: 'Transaction Date', field: 'transactionDate', from: null, to: '2026-10-01' },
      { label: 'Vendor', field: 'vendorName', from: null, to: 'V' },
      { label: 'Amount', field: 'transactionAmount', from: null, to: '5 USD' },
    ]);
    const noCurrency = existing({ entry: { transactionAmount: { value: 3, currencyCode: null } } });
    const again = await preview('concur_update_expense', { ...ids, amount: 4 }, [noCurrency]);
    expect(again.parsed().preview.changes).toEqual([{ label: 'Amount', field: 'transactionAmount', from: '3', to: '4 USD' }]);
  });

  it('refuses an amount change when neither the expense nor the report has a currency', async () => {
    const { text } = await preview('concur_update_expense', { ...ids, amount: 4 }, [
      existing({ entry: { transactionAmount: null }, details: { currencyCode: null } }),
    ]);
    expect(text).toContain('Pass both `amount` and `currency`');
    const noValue = await preview('concur_update_expense', { ...ids, currency: 'EUR' }, [existing({ entry: { transactionAmount: null } })]);
    expect(noValue.text).toContain('Pass both `amount` and `currency`');
  });

  it('treats standard fields missing from the form as empty, and names an unnamed report by its id', async () => {
    const data = existing({ form: { fields: [] }, details: { name: null, policy: { id: 'POL1' } } });
    const { parsed } = await preview('concur_update_expense', { ...ids, businessPurpose: 'Trip' }, [data]);
    const p = parsed().preview;
    expect(p.action).toContain(`on report "${RID}"`);
    expect(p.willSend.expenseListDetailFormId).toBeNull();
    expect(p.changes).toEqual([{ label: 'Business Purpose', field: 'businessPurpose', from: null, to: 'Trip' }]);
  });

  it('refuses when nothing would change, without writing', async () => {
    const { text } = await preview('concur_update_expense', { ...ids, vendor: 'Acme', fields: { Ticket: 'T-1' } }, [existing()]);
    expect(text).toContain('Nothing to change');
  });

  it.each([
    [existing({ entry: null }), 'no expense with that id'],
    [existing({ form: null }), 'no expense with that id'],
    [{ employee: null, existingExpenseForm: null }, 'no expense with that id'],
    [existing({ form: { fields: null } }), 'no expense with that id'],
    [existing({ form: { isFormEditable: false } }), 'is not editable'],
    [existing({ details: { policy: null } }), 'no expense policy'],
  ])('refuses an expense it cannot update (%#)', async (data, message) => {
    const { text } = await preview('concur_update_expense', { ...ids, vendor: 'New' }, [data]);
    expect(text).toContain(message);
  });
});

// ── delete expenses ───────────────────────────────────────────────────────

describe('concur_delete_expenses', () => {
  const del = (status: unknown) => ({ employee: { expenseReport: { deleteExpenseEntries: { status } } } });

  it('previews, deletes, and confirms the expenses are gone', async () => {
    const before = reportData([entry(E1), entry(E2), entry(E3)]);
    const { preview: p, text, sent } = await confirmed('concur_delete_expenses', { reportId: RID, expenseIds: [E1, E2, E1] }, [
      before,
      before,
      del({ success: true }),
      reportData([entry(E3)]),
    ]);
    expect(p.preview.action).toContain('Permanently delete 2 expense(s) from report "October travel"');
    expect(p.preview.expensesToDelete).toEqual([
      { expenseId: E1, date: '2026-10-02', expenseType: 'Dues', vendor: 'Acme', amount: '12.5 USD' },
      { expenseId: E2, date: '2026-10-02', expenseType: 'Dues', vendor: 'Acme', amount: '12.5 USD' },
    ]);
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, DELETE_EXPENSE_ENTRIES, GET_REPORT]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID, expenseIds: [E1, E2] });
    const out = untrustedPayload(text);
    expect(out).toMatchObject({
      deleted: true,
      reportId: RID,
      deletedExpenseIds: [E1, E2],
      response: { status: { success: true } },
      verified: { observed: 'the expenses are no longer on the report' },
    });
    expect((out.verified as Record<string, unknown>).stillPresent).toBeUndefined();
  });

  it('a delete whose re-read fails is still a success', async () => {
    const before = reportData([entry(E1)]);
    const { result, text } = await confirmed('concur_delete_expenses', { reportId: RID, expenseIds: [E1] }, [
      before,
      before,
      del({ success: true }),
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ deleted: true, deletedExpenseIds: [E1] });
  });

  it('says so when an expense is still on the report afterwards', async () => {
    const before = reportData([entry(E1)], null);
    const { preview: p, text } = await confirmed('concur_delete_expenses', { reportId: RID, expenseIds: [E1] }, [
      before,
      before,
      del({ success: true }),
      before,
    ]);
    expect(p.preview.action).toContain(`report "${RID}"`);
    expect(untrustedPayload(text)).toMatchObject({
      deleted: true,
      deletedExpenseIds: [E1],
      verified: { stillPresent: [E1], observed: 'Concur reported success but these expenses are still on the report' },
    });
  });

  it('refuses ids that are not on the report', async () => {
    const { text } = await preview('concur_delete_expenses', { reportId: RID, expenseIds: [E1, E2] }, [reportData([entry(E1)])]);
    expect(text).toContain(`Not on report ${RID}: ${E2}.`);
  });

  it('reports an unconfirmed delete', async () => {
    const before = reportData([entry(E1)]);
    const { text } = await confirmed('concur_delete_expenses', { reportId: RID, expenseIds: [E1] }, [before, before, { employee: null }]);
    expect(text).toContain('did not confirm deleting the expenses');
  });
});

// ── copy ──────────────────────────────────────────────────────────────────

describe('concur_copy_expense', () => {
  const copy = (value: unknown) => ({ employee: { expenseReport: { copyExpenseEntry: value } } });

  it('copies and answers with the new expense', async () => {
    const { preview: p, text, sent } = await confirmed('concur_copy_expense', { reportId: RID, expenseId: E1 }, [
      expenseData(E1),
      expenseData(E1),
      copy({ status: { success: true }, expenseId: E2 }),
      expenseData(E2),
    ]);
    expect(p.preview.action).toContain(`Copy expense ${E1} on report "October travel"`);
    expect(p.preview.expense).toEqual({ date: '2026-10-02', expenseType: 'Dues', vendor: 'Acme', amount: '12.5 USD' });
    expect(sent.map((s) => s.query)).toEqual([GET_EXPENSE, COPY_EXPENSE, GET_EXPENSE]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID, expenseId: E1, expenseListDetailFormId: 'FORM1' });
    expect(sent[2]!.variables).toMatchObject({ expenseId: E2 });
    expect(untrustedPayload(text)).toMatchObject({
      copied: true,
      reportId: RID,
      fromExpenseId: E1,
      expenseId: E2,
      response: { status: { success: true }, expenseId: E2 },
      verified: { expense: { expenseId: E2 } },
    });
  });

  it('a copy whose re-read fails is still a success, with the copy’s id', async () => {
    const { result, text } = await confirmed('concur_copy_expense', { reportId: RID, expenseId: E1 }, [
      expenseData(E1),
      expenseData(E1),
      copy({ status: { success: true }, expenseId: E2 }),
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ copied: true, fromExpenseId: E1, expenseId: E2 });
  });

  it('sends a null form id and names the report by id when the read lacks them', async () => {
    const bare = expenseData(E1);
    bare.employee.expenseReport.reportDetails = { id: RID } as never;
    const { parsed } = await preview('concur_copy_expense', { reportId: RID, expenseId: E1 }, [bare]);
    expect(parsed().preview.willSend.expenseListDetailFormId).toBeNull();
    expect(parsed().preview.action).toContain(`report "${RID}"`);
  });

  it.each([
    [copy({ status: { success: false } }), 'did not confirm copying'],
    [copy(null), 'did not confirm copying'],
    [copy({ status: { success: true }, expenseId: null }), 'returned no id for the copy'],
  ])('reports a copy it cannot confirm (%#)', async (res, message) => {
    const { text } = await confirmed('concur_copy_expense', { reportId: RID, expenseId: E1 }, [expenseData(E1), expenseData(E1), res]);
    expect(text).toContain(message);
  });
});

// ── move available ────────────────────────────────────────────────────────

describe('concur_move_available_expenses_to_report', () => {
  const move = (value: unknown) => ({ employee: { moveAvailableExpensesToReport: value } });

  it('walks every available page, moves, and re-reads both sides', async () => {
    const pages = [avPage([avRow('AV1')], 1, 2), avPage([avRow('AV2')], 2, 2)];
    const { preview: p, text, sent } = await confirmed('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV2', 'AV1'] }, [
      ...pages,
      reportData(),
      ...pages,
      reportData(),
      move({ status: { success: true }, errors: [] }),
      avPage([]),
      reportData([entry(E1), entry(E2)]),
    ]);
    expect(p.preview.action).toContain('Move 2 available expense(s) onto report "October travel"');
    expect(p.preview.expensesToMove).toEqual([
      { id: 'AV2', date: '2026-10-01', vendor: 'Hotel', amount: '200 USD', sources: ['hasSourceCreditCard'] },
      { id: 'AV1', date: '2026-10-01', vendor: 'Hotel', amount: '200 USD', sources: ['hasSourceCreditCard'] },
    ]);
    expect(sent.map((s) => s.query)).toEqual([
      LIST_AVAILABLE_EXPENSES,
      LIST_AVAILABLE_EXPENSES,
      GET_REPORT,
      MOVE_AVAILABLE_EXPENSES,
      LIST_AVAILABLE_EXPENSES,
      GET_REPORT,
    ]);
    expect(sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', page: 1, size: 100 });
    expect(sent[1]!.variables).toMatchObject({ page: 2 });
    expect(sent[3]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', ids: ['AV2', 'AV1'], reportId: RID });
    const out = untrustedPayload(text);
    expect(out).toMatchObject({
      moved: true,
      reportId: RID,
      movedIds: ['AV2', 'AV1'],
      response: { status: { success: true }, errors: [] },
      verified: { observed: expect.stringContaining('now has 2 expense(s)') },
    });
    expect((out.verified as Record<string, unknown>).stillAvailable).toBeUndefined();
    expect(out.errors).toBeUndefined();
  });

  it('a move whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1'] }, [
      avPage([avRow('AV1')]),
      reportData(),
      avPage([avRow('AV1')]),
      reportData(),
      move({ status: { success: true }, errors: [] }),
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ moved: true, movedIds: ['AV1'] });
  });

  it('says so when a moved expense is still available, and names the report by id', async () => {
    const { preview: p, text } = await confirmed('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1'] }, [
      avPage([avRow('AV1')], 1, null),
      reportData([], null),
      avPage([avRow('AV1')], 1, null),
      reportData([], null),
      move({ status: { success: true }, errors: ['partial'] }),
      avPage([avRow('AV1')]),
      reportData([], null),
    ]);
    expect(p.preview.action).toContain(`report "${RID}"`);
    expect(untrustedPayload(text)).toMatchObject({ moved: true, errors: ['partial'], verified: { stillAvailable: ['AV1'] } });
  });

  it('refuses ids that are not available expenses', async () => {
    const { text, sent } = await preview('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1', 'AV9'] }, [
      avPage([avRow('AV1')]),
    ]);
    expect(sent).toHaveLength(1);
    expect(text).toContain('Not among your available expenses: AV9.');
  });

  it('stops paging at an empty page', async () => {
    const { text, sent } = await preview('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1'] }, [avPage([], 1, 5)]);
    expect(sent).toHaveLength(1);
    expect(text).toContain('Not among your available expenses');
  });

  it('refuses when Concur returns no available list', async () => {
    const { text } = await preview('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1'] }, [{ employee: null }]);
    expect(text).toContain('no available-expense list');
  });

  it.each([
    [move({ status: { success: false }, errors: ['Report is submitted'] }), 'did not confirm moving the expenses: Report is submitted'],
    [move(null), 'did not confirm moving the expenses.'],
  ])('reports an unconfirmed move (%#)', async (res, message) => {
    const { text } = await confirmed('concur_move_available_expenses_to_report', { reportId: RID, ids: ['AV1'] }, [
      avPage([avRow('AV1')]),
      reportData(),
      avPage([avRow('AV1')]),
      reportData(),
      res,
    ]);
    expect(text).toContain(message);
  });
});

// ── delete available ──────────────────────────────────────────────────────

describe('concur_delete_available_expenses', () => {
  const del = (status: unknown) => ({ employee: { deleteAvailableExpenses: { status } } });

  it('previews, deletes, and confirms they left the available list', async () => {
    const before = avPage([avRow('AV1'), avRow('AV2')]);
    const { preview: p, text, sent } = await confirmed('concur_delete_available_expenses', { ids: ['AV1'] }, [
      before,
      before,
      del({ success: true }),
      avPage([avRow('AV2')]),
    ]);
    expect(p.preview.action).toContain('Permanently delete 1 available expense(s)');
    expect(p.preview.expensesToDelete).toEqual([expect.objectContaining({ id: 'AV1', vendor: 'Hotel' })]);
    expect(sent.map((s) => s.query)).toEqual([LIST_AVAILABLE_EXPENSES, DELETE_AVAILABLE_EXPENSES, LIST_AVAILABLE_EXPENSES]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', ids: ['AV1'] });
    expect(untrustedPayload(text)).toEqual({
      deleted: true,
      deletedIds: ['AV1'],
      response: { status: { success: true } },
      verified: { observed: 'the expenses are no longer in your available list', availableRemaining: 1 },
    });
  });

  it('a delete whose re-read fails is still a success', async () => {
    const before = avPage([avRow('AV1')]);
    const { result, text } = await confirmed('concur_delete_available_expenses', { ids: ['AV1'] }, [
      before,
      before,
      del({ success: true }),
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ deleted: true, deletedIds: ['AV1'] });
  });

  it('says so when one is still available', async () => {
    const before = avPage([avRow('AV1')]);
    const { text } = await confirmed('concur_delete_available_expenses', { ids: ['AV1'] }, [before, before, del({ success: true }), before]);
    expect(untrustedPayload(text)).toMatchObject({ deleted: true, deletedIds: ['AV1'], verified: { stillAvailable: ['AV1'] } });
  });

  it('refuses unknown ids and unconfirmed deletes', async () => {
    const missing = await preview('concur_delete_available_expenses', { ids: ['AV9'] }, [avPage([avRow('AV1')])]);
    expect(missing.text).toContain('Not among your available expenses: AV9.');
    await harness?.close();
    const before = avPage([avRow('AV1')]);
    const { text } = await confirmed('concur_delete_available_expenses', { ids: ['AV1'] }, [before, before, del({ success: false })]);
    expect(text).toContain('did not confirm deleting the available expenses');
  });
});
