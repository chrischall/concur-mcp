import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { CREATE_EXPENSE, EXCHANGE_RATE, EXPENSE_FORM, NEW_EXPENSE_FORM, UPDATE_EXPENSE } from '../src/graphql/expense-writes.js';
import { GET_EXPENSE } from '../src/graphql/expenses.js';
import { LIST_PAYMENT_TYPES } from '../src/graphql/lookups.js';
import { registerExpenseWriteTools } from '../src/tools/expense-writes.js';
import { checkLength, isSettable, maxLengthOf, standardSpec, standardWire, whyNotSettable } from '../src/tools/expense-fields.js';
import type { FormField } from '../src/tools/forms.js';
import { SUB, textOf, toolHarness, untrustedPayload } from './helpers.js';

// Standard (non-custom) expense-form fields set through `fields`, the
// foreign-currency exchange rate, and text-length limits. Field shapes mirror
// what GetNewExpenseEntry / GetExistingExpenseEntry answer; no real data.

const RID = '0123456789ABCDEF0123';
const E1 = '0123456789abcdef0123456789abcdef';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { willSend: Record<string, unknown> & { fields: Record<string, unknown> } };
}

const isMutation = (q: string) => /^\s*mutation\b/.test(q);

async function preview(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerExpenseWriteTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  return { result, text: textOf(result), sent: t.sent, parsed: () => parseToolResult<Preview>(result) };
}

async function confirmed(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerExpenseWriteTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1) };
}

// ── fixtures ──────────────────────────────────────────────────────────────

const rw = (f: FormField): FormField => ({ accessMode: 'READ_WRITE', value: null, ...f });

const RAIL: FormField[] = [
  rw({ id: 'paymentTypeId', label: 'Payment Type', defaultValue: { value: 'Cash', code: 'CASH', listItemId: 'CASH' } }),
  rw({ id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', control: 'TEXT_AREA', maximumLength: 64 }),
  rw({ id: 'vendorName', label: 'Vendor', dataType: 'STRING', control: 'EDIT', maximumLength: 40 }),
  rw({ id: 'comment', label: 'Comment', dataType: 'STRING', control: 'TEXT_AREA', maximumLength: 500 }),
  rw({ id: 'ticketNumber', label: 'Ticket Number', dataType: 'STRING', control: 'EDIT', isRequired: true, maximumLength: 32 }),
  rw({ id: 'fromLocation', label: 'From Location', dataType: 'STRING', control: 'EDIT', maximumLength: 100 }),
  rw({ id: 'toLocation', label: 'To Location', dataType: 'STRING', control: 'EDIT', maximumLength: 100 }),
  rw({ id: 'hotelCheckinDate', label: 'Check-in Date', dataType: 'DATE', control: 'DATE_EDIT' }),
  rw({ id: 'carRentalDays', label: 'Rental Days', dataType: 'INTEGER', control: 'EDIT' }),
  rw({ id: 'isExpenseBillable', label: 'Billable', dataType: 'BOOLEAN', control: 'CHECKBOX' }),
  rw({ id: 'isPartOfTravelAllowance', label: 'Part of Travel Allowance', dataType: 'BOOLEAN', control: 'CHECKBOX' }),
  rw({
    id: 'foreignOrDomestic',
    label: 'Foreign/Domestic',
    dataType: 'STRING',
    control: 'PICK_LIST',
    options: [
      { id: 'HOME', value: 'Domestic' },
      { id: 'FOREIGN', value: 'Foreign' },
    ],
  }),
  rw({
    id: 'receiptType',
    label: 'Receipt Status',
    dataType: 'LIST',
    control: 'PICK_LIST',
    options: [
      { id: 'T', code: 'T', value: 'Tax Receipt' },
      { id: 'N', code: 'N', value: 'No Receipt' },
    ],
  }),
  rw({ id: 'aftCode', label: 'Airline Fee Type', dataType: 'LIST', control: 'PICK_LIST' }),
  rw({ id: 'custom4', label: 'Notes', dataType: 'STRING', control: 'EDIT', maximumLength: 255 }),
  { id: 'vatTaxTotal', label: 'Tax Posted Amount', dataType: 'AMOUNT', accessMode: 'READ_WRITE', value: null },
  { id: 'hasVat', label: 'Has VAT', dataType: 'BOOLEAN', control: 'CHECKBOX', accessMode: 'READ_WRITE', value: null },
  { id: 'isPaperReceiptReceived', label: 'Paper Receipt Received', control: 'CHECKBOX', accessMode: 'READ_WRITE', value: null },
  { id: 'companyTaxId', label: 'Company Tax ID', dataType: 'STRING', accessMode: 'READ_WRITE', value: null },
  { id: 'invoiceId', label: 'Invoice', dataType: 'STRING', accessMode: 'READ_ONLY', value: null },
  { id: 'exchangeRate', label: 'Exchange Rate', dataType: 'NUMERIC', accessMode: 'READ_WRITE', value: null },
];

const header = (currencyCode: string | null = 'USD') => ({
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: {
        id: RID,
        name: 'October travel',
        currencyCode,
        policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' },
        expenseTypes: [{ id: 'TRAIN', code: 'TRAIN', name: 'Train/Rail - I Paid', parentName: 'Travel' }],
        meta: { isSubmitted: false, canAddExpense: true },
      },
    },
  },
});
const newForm = (fields: FormField[] = RAIL, currencyCode: string | null = 'USD') => ({
  ...header(currencyCode),
  newExpenseForm: { mainForm: { fields } },
});
const rate = (value: number | null) => ({ exchangeRate: value === null ? null : { rate: value, date: '2026-10-02' } });

const base = { reportId: RID, expenseType: 'TRAIN', date: '2026-10-02', amount: 42 };

const expenseData = (id: string) => ({
  entryExceptions: { entryExceptions: [], itemizationsExceptions: [] },
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: { id: RID, name: 'October travel', currencyCode: 'USD', policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' } },
      entry: { id, transactionDate: '2026-10-02', expenseType: { id: 'TRAIN', name: 'Train/Rail - I Paid' }, transactionAmount: { value: 42, currencyCode: 'USD' } },
    },
  },
  existingExpenseForm: { expenseTypeId: 'TRAIN', mainForm: { isFormEditable: true, fields: [] } },
});

// ── unit: the catalogue ───────────────────────────────────────────────────

describe('standard field catalogue', () => {
  const field = (id: string) => RAIL.find((f) => f.id === id)!;

  it('settles which fields `fields` may set', () => {
    const settable = RAIL.filter(isSettable).map((f) => f.id);
    expect(settable).toEqual([
      'ticketNumber',
      'fromLocation',
      'toLocation',
      'hotelCheckinDate',
      'carRentalDays',
      'isExpenseBillable',
      'isPartOfTravelAllowance',
      'foreignOrDomestic',
      'receiptType',
      'custom4',
    ]);
    expect(standardSpec(field('fromLocation'))).toEqual({ wire: 'startLocation', kind: 'text' });
    expect(standardSpec(field('aftCode'))).toBeUndefined();
  });

  it.each([
    ['vendorName', 'Use the `vendor` argument for "Vendor".'],
    ['businessPurpose', 'Use the `businessPurpose` argument'],
    ['comment', 'Use the `comment` argument'],
    ['vatTaxTotal', 'Concur computes "Tax Posted Amount"'],
    ['hasVat', 'Concur computes "Has VAT"'],
    ['isPaperReceiptReceived', 'Only an approver or expense processor sets "Paper Receipt Received".'],
    ['companyTaxId', 'its wire shape is not proven'],
    ['aftCode', 'picks from a lookup this form does not carry'],
    ['invoiceId', '"Invoice" is read-only on this form'],
    ['exchangeRate', 'Use the `exchangeRate` argument'],
  ])('explains why %s cannot be set', (id, why) => {
    expect(whyNotSettable(field(id))).toContain(why);
  });

  it('explains the expense type and the named-argument fields', () => {
    expect(whyNotSettable({ id: 'expenseType', label: 'Expense Type' })).toContain('delete the expense and create a new one');
    expect(whyNotSettable({ id: 'transactionDate', label: 'Date' })).toContain('`date`');
    expect(whyNotSettable({ id: 'isPersonalExpense', label: 'Personal' })).toContain('`personal`');
  });

  it.each([
    [{ id: 'ticketNumber', maximumLength: 32 }, 32],
    [{ id: 'ticketNumber', maximumLength: 0 }, undefined],
    [{ id: 'ticketNumber', maximumLength: null }, undefined],
    [{ id: 'ticketNumber' }, undefined],
    [{ id: 'custom4', maximumLength: 255 }, 48],
    [{ id: 'custom4', maximumLength: 0 }, 48],
    [{ id: 'orgUnit2', maximumLength: 20 }, 20],
    [{ id: 'custom4', maximumLength: null }, undefined],
  ])('max length of %j is %s (custom fields cap at 48, as the web app’s input does)', (f, max) => {
    expect(maxLengthOf(f as FormField)).toBe(max);
  });

  it('checkLength allows the limit and refuses one more', () => {
    const f: FormField = { id: 'businessPurpose', label: 'Business Purpose', maximumLength: 64 };
    expect(() => checkLength(f, 'x'.repeat(64))).not.toThrow();
    expect(() => checkLength(f, 'x'.repeat(65))).toThrow(/"Business Purpose" is 65 characters; this expense form allows at most 64\./);
    expect(() => checkLength(undefined, 'x'.repeat(5000))).not.toThrow();
  });

  it.each([
    ['date', '2026-10-01', '2026-10-01'],
    ['integer', ' 3 ', 3],
    ['boolean', 'Yes', true],
    ['boolean', 'false', false],
    ['boolean', '0', false],
    ['taxLocation', 'foreign', 'FOREIGN'],
    ['taxLocation', 'Domestic', 'HOME'],
    ['taxLocation', 'out of province', 'OUT_OF_PROVINCE'],
    ['text', ' as typed ', ' as typed '],
  ] as const)('converts %s %j to %j', (kind, text, wire) => {
    expect(standardWire(field('foreignOrDomestic'), kind, text)).toEqual(wire);
  });

  it('reads a foreign/domestic value without options as the key itself', () => {
    expect(standardWire({ id: 'foreignOrDomestic', label: 'F/D' }, 'taxLocation', 'Foreign')).toBe('FOREIGN');
  });

  it.each([
    ['date', '10/01/2026', 'a date as YYYY-MM-DD'],
    ['date', '2026-13-45', 'a date as YYYY-MM-DD'],
    ['integer', '2.5', 'a whole number'],
    ['boolean', 'maybe', '"true" or "false"'],
    ['taxLocation', 'Mars', 'one of HOME, FOREIGN, OUT_OF_PROVINCE'],
  ] as const)('refuses %s %j', (kind, text, hint) => {
    expect(() => standardWire(field('foreignOrDomestic'), kind, text)).toThrow(/is not a valid value for "Foreign\/Domestic"/);
    try {
      standardWire(field('foreignOrDomestic'), kind, text);
    } catch (err) {
      expect(String((err as { hint?: string }).hint)).toContain(hint);
    }
  });
});

// ── create ────────────────────────────────────────────────────────────────

describe('concur_create_expense — standard fields', () => {
  it('sets Ticket Number (a required standard text field) by label and clears it from missingRequired', async () => {
    const missing = await preview('concur_create_expense', base, [header(), newForm()]);
    expect(missing.parsed().preview.missingRequired).toEqual([{ label: 'Ticket Number', field: 'ticketNumber' }]);

    const { preview: p, sent } = await confirmed('concur_create_expense', { ...base, fields: { 'ticket number': 'TKT-0001' } }, [
      header(),
      newForm(),
      header(),
      newForm(),
      { createExpense: { id: E1 } },
      expenseData(E1),
    ]);
    expect(p.preview.willSend.fields.ticketNumber).toBe('TKT-0001');
    expect(p.preview.missingRequired).toBeUndefined();
    expect(p.preview.fields).toEqual(expect.arrayContaining([{ label: 'Ticket Number', field: 'ticketNumber', value: 'TKT-0001' }]));
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, CREATE_EXPENSE, GET_EXPENSE]);
    expect((sent[2]!.variables.fields as Record<string, unknown>).ticketNumber).toBe('TKT-0001');
  });

  it('sends every supported kind in the web app’s wire shape, renaming as its serializer does', async () => {
    const fields = {
      'From Location': 'Boston',
      toLocation: 'New York',
      'Check-in Date': '2026-10-01',
      'Rental Days': '3',
      Billable: 'yes',
      'Part of Travel Allowance': 'true',
      'Foreign/Domestic': 'Foreign',
      'Receipt Status': 'tax receipt',
      Notes: 'free text',
    };
    const { parsed } = await preview('concur_create_expense', { ...base, fields }, [header(), newForm()]);
    const sent = parsed().preview.willSend.fields;
    expect(sent).toMatchObject({
      startLocation: 'Boston',
      endLocation: 'New York',
      hotelCheckinDate: '2026-10-01',
      carRentalDays: 3,
      isExpenseBillable: true,
      isExpensePartOfTravelAllowance: true,
      taxRateLocation: 'FOREIGN',
      receiptTypeId: 'T',
      custom4: { value: 'free text' },
    });
    expect(sent).not.toHaveProperty('fromLocation');
    expect(sent).not.toHaveProperty('toLocation');
    expect(sent).not.toHaveProperty('receiptType');
    expect(parsed().preview.fields).toEqual(
      expect.arrayContaining([
        { label: 'Receipt Status', field: 'receiptTypeId', value: 'Tax Receipt' },
        { label: 'Foreign/Domestic', field: 'taxRateLocation', value: 'FOREIGN' },
      ]),
    );
  });

  it('keeps the captured defaults for taxRateLocation and the travel-allowance flag when not asked', async () => {
    const { parsed } = await preview('concur_create_expense', { ...base, fields: { 'Ticket Number': '1' } }, [header(), newForm()]);
    expect(parsed().preview.willSend.fields).toMatchObject({ taxRateLocation: 'HOME', isExpensePartOfTravelAllowance: false, receiptTypeId: '' });
  });

  it.each([
    [{ Vendor: 'Amtrak' }, 'The "Vendor" field cannot be set through `fields`.', 'Use the `vendor` argument'],
    [{ 'Tax Posted Amount': '1' }, 'The "Tax Posted Amount" field cannot be set', 'Concur computes'],
    [{ 'Paper Receipt Received': 'true' }, 'cannot be set', 'Only an approver'],
    [{ Invoice: 'X' }, 'cannot be set', 'read-only'],
    [{ 'Airline Fee Type': 'Bag' }, 'cannot be set', 'lookup this form does not carry'],
    [{ Nope: 'x' }, 'This expense form has no field "Nope".', 'Settable fields: Ticket Number; From Location;'],
  ])('refuses %j with the reason and the settable list', async (fields, message, hint) => {
    const { text } = await preview('concur_create_expense', { ...base, fields }, [header(), newForm()]);
    expect(text).toContain(message);
    expect(text).toContain(hint);
  });

  it.each([
    [{ 'Ticket Number': 'x'.repeat(33) }, '"Ticket Number" is 33 characters; this expense form allows at most 32.'],
    [{ Notes: 'x'.repeat(49) }, '"Notes" is 49 characters; this expense form allows at most 48.'],
    [{ 'Rental Days': 'three' }, '"three" is not a valid value for "Rental Days".'],
    [{ 'Receipt Status': 'shoebox' }, '"shoebox" is not an item of the "Receipt Status" list.'],
  ])('validates %j before sending anything', async (fields, message) => {
    const { text, sent } = await preview('concur_create_expense', { ...base, fields }, [header(), newForm()]);
    expect(text).toContain(message);
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM]);
  });

  it('refuses a business purpose longer than the form’s maximumLength (the bare-400 bug)', async () => {
    const purpose = 'x'.repeat(82);
    const { text, sent } = await preview('concur_create_expense', { ...base, businessPurpose: purpose }, [header(), newForm()]);
    expect(text).toContain('"Business Purpose" is 82 characters; this expense form allows at most 64.');
    expect(text).toContain('Shorten it to 64 characters or fewer');
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM]);
    const ok = await preview('concur_create_expense', { ...base, businessPurpose: 'x'.repeat(64) }, [header(), newForm()]);
    expect(ok.parsed().status).toBe('confirmation-required');
  });

  it('checks vendor and comment against their form limits too', async () => {
    const vendor = await preview('concur_create_expense', { ...base, vendor: 'v'.repeat(41) }, [header(), newForm()]);
    expect(vendor.text).toContain('"Vendor" is 41 characters; this expense form allows at most 40.');
    const comment = await preview('concur_create_expense', { ...base, comment: 'c'.repeat(501) }, [header(), newForm()]);
    expect(comment.text).toContain('"Comment" is 501 characters; this expense form allows at most 500.');
  });
});

// ── create: foreign currency ──────────────────────────────────────────────

describe('concur_create_expense — foreign currency', () => {
  it('fetches Concur’s rate for the transaction date (as the web app does) and sends it', async () => {
    const { preview: p, sent } = await confirmed('concur_create_expense', { ...base, currency: 'gbp' }, [
      header(),
      newForm(),
      rate(1.3316393774),
      header(),
      newForm(),
      rate(1.3316393774),
      { createExpense: { id: E1 } },
      expenseData(E1),
    ]);
    expect(p.preview.willSend.fields).toMatchObject({
      transactionAmount: { value: 42, currencyCode: 'GBP' },
      exchangeRate: { operation: 'MULTIPLY', value: 1.3316393774 },
    });
    expect(p.preview.exchangeRate).toBe('1 GBP = 1.3316393774 USD (Concur’s rate for 2026-10-02)');
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, EXCHANGE_RATE, CREATE_EXPENSE, GET_EXPENSE]);
    expect(sent[2]!.variables).toEqual({ baseCurrency: 'GBP', quoteCurrency: 'USD', date: '2026-10-02' });
  });

  it('inverts the rate when the form’s exchange-rate operation is DIVIDE', async () => {
    const form = RAIL.map((f) => (f.id === 'exchangeRate' ? { ...f, value: { value: 1, operation: 'DIVIDE' } } : f));
    const { parsed } = await preview('concur_create_expense', { ...base, currency: 'EUR' }, [header(), newForm(form), rate(1.25)]);
    expect(parsed().preview.willSend.fields.exchangeRate).toEqual({ operation: 'DIVIDE', value: 0.8 });
  });

  it('uses an explicit exchangeRate without asking Concur', async () => {
    const { parsed, sent } = await preview('concur_create_expense', { ...base, currency: 'EUR', exchangeRate: 1.1 }, [header(), newForm()]);
    expect(parsed().preview.willSend.fields.exchangeRate).toEqual({ operation: 'MULTIPLY', value: 1.1 });
    expect(parsed().preview.exchangeRate).toBe('1 EUR = 1.1 USD (given)');
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM]);
  });

  it.each([
    [rate(null), 'SAP Concur has no EUR → USD exchange rate for 2026-10-02.'],
    [rate(0), 'SAP Concur has no EUR → USD exchange rate for 2026-10-02.'],
    [{ exchangeRate: { rate: null, date: null } }, 'SAP Concur has no EUR → USD exchange rate for 2026-10-02.'],
  ])('asks for exchangeRate when Concur has no rate (%#)', async (answer, message) => {
    const { text } = await preview('concur_create_expense', { ...base, currency: 'EUR' }, [header(), newForm(), answer]);
    expect(text).toContain(message);
    expect(text).toContain('Pass `exchangeRate`');
  });

  it('asks for exchangeRate when the rate lookup itself fails', async () => {
    const failed = new Response(JSON.stringify({ data: null, errors: [{ message: 'boom', path: ['exchangeRate'] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { text } = await preview('concur_create_expense', { ...base, currency: 'EUR' }, [header(), newForm(), failed]);
    expect(text).toContain('Could not get the EUR → USD exchange rate from SAP Concur');
    expect(text).toContain('Pass `exchangeRate`');
  });

  it('refuses an exchangeRate for a same-currency expense', async () => {
    const { text } = await preview('concur_create_expense', { ...base, exchangeRate: 2 }, [header(), newForm()]);
    expect(text).toContain('`exchangeRate` only applies when `currency` differs from the report currency (USD).');
  });

  it('looks the rate up after the payment type, as the only extra read', async () => {
    const { sent } = await preview('concur_create_expense', { ...base, currency: 'EUR', paymentType: 'Cash' }, [
      header(),
      newForm(),
      { paymentTypes: [{ paymentTypeId: 'CASH', paymentTypeName: 'Cash' }] },
      rate(1.1),
    ]);
    expect(sent.map((s) => s.query)).toEqual([NEW_EXPENSE_FORM, NEW_EXPENSE_FORM, LIST_PAYMENT_TYPES, EXCHANGE_RATE]);
  });
});

// ── update ────────────────────────────────────────────────────────────────

describe('concur_update_expense — standard fields and currency', () => {
  const existing = (over: { amount?: { value: number; currencyCode: string }; date?: string | null; fields?: FormField[] } = {}) => ({
    employee: {
      userId: SUB,
      expenseReport: {
        reportId: RID,
        reportDetails: { id: RID, name: 'October travel', currencyCode: 'USD', policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' } },
        entry: {
          id: E1,
          transactionDate: over.date === undefined ? '2026-10-02' : over.date,
          paymentType: { id: 'CASH', name: 'Cash' },
          transactionAmount: over.amount ?? { value: 42, currencyCode: 'USD' },
          isPersonalExpense: false,
        },
      },
    },
    existingExpenseForm: {
      expenseId: E1,
      expenseTypeId: 'TRAIN',
      mainForm: { isFormEditable: true, fields: over.fields ?? RAIL },
    },
  });
  const ids = { reportId: RID, expenseId: E1 };

  it('sets Ticket Number on an existing rail expense, sending only that field', async () => {
    const { preview: p, sent } = await confirmed('concur_update_expense', { ...ids, fields: { 'Ticket Number': 'TKT-0001' } }, [
      existing(),
      existing(),
      { updateExpense: { id: E1 } },
      expenseData(E1),
    ]);
    expect(p.preview.willSend.fields).toEqual({ ticketNumber: 'TKT-0001' });
    expect(p.preview.changes).toEqual([{ label: 'Ticket Number', field: 'ticketNumber', from: null, to: 'TKT-0001' }]);
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM, UPDATE_EXPENSE, GET_EXPENSE]);
  });

  it('compares against the current value: unchanged standard fields are not sent', async () => {
    const fields = RAIL.map((f) => {
      if (f.id === 'ticketNumber') return { ...f, value: { stringValue: 'TKT-0001' } };
      if (f.id === 'isExpenseBillable') return { ...f, value: { booleanValue: true } };
      if (f.id === 'carRentalDays') return { ...f, value: { integerValue: 3 } };
      if (f.id === 'receiptType') return { ...f, value: { id: 'T', code: 'T', listItemValue: 'Tax Receipt' } };
      if (f.id === 'foreignOrDomestic') return { ...f, value: { stringValue: 'FOREIGN' } };
      if (f.id === 'hotelCheckinDate') return { ...f, value: { dateValue: '2026-10-01' } };
      return f;
    });
    const same = { 'Ticket Number': 'TKT-0001', Billable: 'true', 'Rental Days': '3', 'Receipt Status': 'T', 'Foreign/Domestic': 'foreign', 'Check-in Date': '2026-10-01' };
    const { text } = await preview('concur_update_expense', { ...ids, fields: same }, [existing({ fields })]);
    expect(text).toContain('Nothing to change');

    const { parsed } = await preview('concur_update_expense', { ...ids, fields: { Billable: 'no', 'Receipt Status': 'No Receipt' } }, [existing({ fields })]);
    expect(parsed().preview.willSend.fields).toEqual({ isExpenseBillable: false, receiptTypeId: 'N' });
    expect(parsed().preview.changes).toEqual([
      { label: 'Billable', field: 'isExpenseBillable', from: true, to: false },
      { label: 'Receipt Status', field: 'receiptTypeId', from: 'Tax Receipt', to: 'No Receipt' },
    ]);
  });

  it('refuses a too-long business purpose on update', async () => {
    const { text } = await preview('concur_update_expense', { ...ids, businessPurpose: 'x'.repeat(65) }, [existing()]);
    expect(text).toContain('"Business Purpose" is 65 characters; this expense form allows at most 64.');
  });

  it('changing to a foreign currency fetches the rate and sends it with the amount', async () => {
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, currency: 'GBP' }, [existing(), rate(1.33)]);
    expect(parsed().preview.willSend.fields).toEqual({
      transactionAmount: { value: 42, currencyCode: 'GBP' },
      exchangeRate: { operation: 'MULTIPLY', value: 1.33 },
    });
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM, EXCHANGE_RATE]);
    expect(sent[1]!.variables).toEqual({ baseCurrency: 'GBP', quoteCurrency: 'USD', date: '2026-10-02' });
  });

  it('changing the date of a foreign-currency expense refreshes the rate for the new date', async () => {
    const fields = RAIL.map((f) => (f.id === 'exchangeRate' ? { ...f, value: { value: 1.3316393774, operation: 'MULTIPLY' } } : f));
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, date: '2026-10-05' }, [
      existing({ amount: { value: 42, currencyCode: 'GBP' }, fields }),
      rate(1.34),
    ]);
    expect(parsed().preview.willSend.fields).toEqual({ transactionDate: '2026-10-05', exchangeRate: { operation: 'MULTIPLY', value: 1.34 } });
    expect(parsed().preview.changes).toEqual(
      expect.arrayContaining([{ label: 'Exchange Rate', field: 'exchangeRate', from: '1.3316393774 (MULTIPLY)', to: '1.34 (MULTIPLY)' }]),
    );
    expect(sent[1]!.variables).toEqual({ baseCurrency: 'GBP', quoteCurrency: 'USD', date: '2026-10-05' });
  });

  it('changing back to the report currency resets the rate to 1 without a lookup', async () => {
    const fields = RAIL.map((f) => (f.id === 'exchangeRate' ? { ...f, value: { value: 1.33, operation: 'MULTIPLY' } } : f));
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, currency: 'USD' }, [
      existing({ amount: { value: 42, currencyCode: 'GBP' }, fields }),
    ]);
    expect(parsed().preview.willSend.fields).toEqual({
      transactionAmount: { value: 42, currencyCode: 'USD' },
      exchangeRate: { operation: 'MULTIPLY', value: 1 },
    });
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM]);
  });

  it('an explicit exchangeRate on a foreign-currency expense changes only the rate', async () => {
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, exchangeRate: 1.5 }, [
      existing({ amount: { value: 42, currencyCode: 'GBP' } }),
    ]);
    expect(parsed().preview.willSend.fields).toEqual({ exchangeRate: { operation: 'MULTIPLY', value: 1.5 } });
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM]);
  });

  it('needs an exchangeRate when a foreign-currency expense has no date to look one up for', async () => {
    const { text, sent } = await preview('concur_update_expense', { ...ids, currency: 'EUR' }, [
      existing({ amount: { value: 42, currencyCode: 'GBP' }, date: null }),
    ]);
    expect(text).toContain('The expense has no transaction date to look up an exchange rate for.');
    expect(text).toContain('Pass `exchangeRate`');
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM]);
  });

  it('compares a current value the caller could not have typed as text', async () => {
    const fields = RAIL.map((f) => (f.id === 'carRentalDays' ? { ...f, value: { integerValue: -1 } } : f));
    const { parsed } = await preview('concur_update_expense', { ...ids, fields: { 'Rental Days': '3' } }, [existing({ fields })]);
    expect(parsed().preview.changes).toEqual([{ label: 'Rental Days', field: 'carRentalDays', from: '-1', to: 3 }]);
  });

  it('reads a stored rate without a direction as MULTIPLY', async () => {
    const fields = RAIL.map((f) => (f.id === 'exchangeRate' ? { ...f, value: { value: 1.2, operation: null } } : f));
    const { parsed } = await preview('concur_update_expense', { ...ids, exchangeRate: 1.5 }, [
      existing({ amount: { value: 42, currencyCode: 'GBP' }, fields }),
    ]);
    expect(parsed().preview.changes).toEqual([{ label: 'Exchange Rate', field: 'exchangeRate', from: '1.2 (MULTIPLY)', to: '1.5 (MULTIPLY)' }]);
  });

  it('refuses an exchangeRate on a report-currency expense', async () => {
    const { text } = await preview('concur_update_expense', { ...ids, exchangeRate: 1.5 }, [existing()]);
    expect(text).toContain('`exchangeRate` only applies when `currency` differs from the report currency (USD).');
  });

  it('leaves the rate alone when the report has no currency to compare with', async () => {
    const data = existing({ amount: { value: 42, currencyCode: 'GBP' } });
    data.employee.expenseReport.reportDetails.currencyCode = null as never;
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, currency: 'EUR' }, [data]);
    expect(parsed().preview.willSend.fields).toEqual({ transactionAmount: { value: 42, currencyCode: 'EUR' } });
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM]);
  });

  it('a same-currency date change does not look up a rate', async () => {
    const { parsed, sent } = await preview('concur_update_expense', { ...ids, date: '2026-10-05' }, [existing()]);
    expect(parsed().preview.willSend.fields).toEqual({ transactionDate: '2026-10-05' });
    expect(sent.map((s) => s.query)).toEqual([EXPENSE_FORM]);
  });

  it('answers success with the re-read after the update', async () => {
    const { text } = await confirmed('concur_update_expense', { ...ids, fields: { 'From Location': 'Boston' } }, [
      existing(),
      existing(),
      { updateExpense: { id: E1 } },
      expenseData(E1),
    ]);
    expect(untrustedPayload(text)).toMatchObject({ updated: true, changedFields: ['From Location'] });
  });
});
