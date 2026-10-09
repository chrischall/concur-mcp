import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { LIST_ITEMS } from '../src/graphql/forms.js';
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
} from '../src/graphql/report-writes.js';
import { GET_REPORT, GET_REPORT_TIMELINE } from '../src/graphql/reports.js';
import type { FormField } from '../src/tools/forms.js';
import { localIsoDate, registerReportWriteTools } from '../src/tools/report-writes.js';
import { NOW, SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload } from './helpers.js';

const RID = '0123456789ABCDEF0123';
const E1 = '0123456789abcdef0123456789abcdef';
const E2 = 'fedcba9876543210fedcba9876543210';
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = localDate(new Date(NOW * 1000));

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string; willSend: Record<string, unknown> };
}

const isMutation = (q: string) => /^\s*mutation\b/.test(q);

/** Phase 1 only: the preview, and proof nothing was written. */
async function preview(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerReportWriteTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  return { result, text: textOf(result), sent: t.sent };
}

/** Both phases: preview (no writes), then the same args + token. */
async function confirmed(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerReportWriteTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1), jwt: t.jwt };
}

async function once(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerReportWriteTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent };
}

const errorsResponse = (errors: unknown[]) =>
  new Response(JSON.stringify({ data: null, errors }), { status: 200, headers: { 'content-type': 'application/json' } });

/** The live failure: the post-write re-read answered only errors[] (e.g. a legacy field like rptKey). */
const failedReRead = () => errorsResponse([fieldError(['employee', 'expenseReport'], 'corr-reread')]);

/** A success result whose re-read failed: no error flag, and a verificationError instead of `verified`. */
function expectUnverifiedSuccess(result: unknown, text: string) {
  expect((result as { isError?: boolean }).isError).toBeFalsy();
  const out = untrustedPayload(text);
  expect(out.verified).toBeUndefined();
  expect(out.verificationError).toMatch(/The change was made, but re-reading it failed: .*correlationId=corr-reread/);
  expect(out.verificationError).toMatch(/Do not repeat the write/);
  return out;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const usd = (value: number) => ({ value, currencyCode: 'USD' });

const newForm = (over: Record<string, unknown> = {}): { newReportForm: { fields: FormField[]; policyId: string | null } } => ({
  newReportForm: {
    policyId: 'POL1',
    fields: [
      { id: 'name', label: 'Report Name', accessMode: 'READ_WRITE', isRequired: true, value: { stringValue: null } },
      {
        id: 'reportDate',
        label: 'Report Date',
        accessMode: 'READ_WRITE',
        isRequired: true,
        value: null,
        defaultValue: { value: '2026-10-08', code: null, listItemId: null },
      },
      // `policy` travels as the top-level policyId, never as a field.
      { id: 'policy', label: 'Policy', isRequired: true, value: { code: 'P', id: 'POLX', listItemValue: 'US Policy' } },
      { id: 'country', label: 'Country', value: { code: 'US', id: 'CTRY_US', listItemValue: 'United States' } },
      {
        id: 'orgUnit1',
        label: 'Division',
        accessMode: 'READ_WRITE',
        list: { id: 'LST_ORG', level: 1, defaultSearchBy: 'TEXT' },
        value: null,
        defaultValue: { value: 'Engineering', code: 'ENG', listItemId: 'ORG1' },
      },
      { id: 'orgUnit2', label: 'Department', accessMode: 'READ_WRITE', list: { id: 'LST_ORG', level: 2, defaultSearchBy: 'TEXT' }, value: null },
      {
        id: 'custom5',
        label: 'Business Purpose',
        accessMode: 'READ_WRITE',
        isRequired: true,
        list: { id: 'LST_BP', level: 1, defaultSearchBy: 'TEXT' },
        value: null,
        defaultValue: null,
      },
      { id: 'custom7', label: 'Project Code', accessMode: 'READ_WRITE', value: { stringValue: '' } },
      {
        id: 'custom9',
        label: 'Billable',
        accessMode: 'READ_WRITE',
        options: [
          { id: 'Y', code: 'Y', value: 'Yes' },
          { id: 'N', code: 'N', value: 'No' },
        ],
        value: null,
      },
      { id: 'custom16', label: 'Cost Center', accessMode: 'RO', value: { stringValue: '012345' } },
      { id: 'startDate', label: 'Start Date', accessMode: 'READ_WRITE', value: { dateValue: '2026-10-01' } },
    ],
    ...over,
  },
});

const bpItems = { CDS_spend: { list: { items: [{ id: 'BP_CV', code: 'CV', value: 'Client visit' }] } } };
const divItems = { CDS_spend: { list: { items: [{ id: 'ORG_OPS', code: 'OPS', value: 'Operations' }] } } };
const deptItems = { CDS_spend: { list: { items: [{ id: 'DEPT_QA', code: 'QA', value: 'Quality' }] } } };

const entry = (expenseId: string) => ({
  expenseId,
  summary: {
    id: expenseId,
    transactionDate: '2026-10-02',
    expenseType: { id: 'DUESX', code: 'DUESX', name: 'Dues' },
    vendor: { id: null, description: 'Acme Club', name: null },
    transactionAmount: usd(12.5),
  },
});

const reportData = (opts: { meta?: Record<string, unknown> | null; entries?: unknown[]; exceptions?: unknown[]; name?: string | null } = {}) => ({
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: {
        id: RID,
        name: opts.name === undefined ? 'October travel' : opts.name,
        reportNumber: 'ABC123',
        approvalStatus: 'Not Submitted',
        reportTotal: usd(25),
        meta: opts.meta === undefined ? { isSubmitted: false } : opts.meta,
        policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' },
      },
    },
  },
  reportEntriesDetails: { reportId: RID, entries: opts.entries ?? [] },
  reportExceptions: { reportId: RID, reportExceptions: opts.exceptions ?? [], entryExceptions: [] },
});

// ── annotations ───────────────────────────────────────────────────────────

describe('report write tools', () => {
  it('are all confirm-gated writes with truthful destructive hints', async () => {
    const t = await toolHarness(registerReportWriteTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.destructiveHint]));
    expect(hints).toEqual({
      concur_create_report: false,
      concur_update_report: false,
      concur_delete_report: true,
      concur_add_report_comment: true,
      concur_submit_report: true,
      concur_recall_report: false,
    });
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('confirmToken');
      expect(tool.description).toMatch(/confirmToken/);
    }
    expect(tools.find((x) => x.name === 'concur_submit_report')!.description).toMatch(/approver/);
  });
});

// ── create ────────────────────────────────────────────────────────────────

describe('concur_create_report', () => {
  // Lower list level first on purpose: the top level must still resolve first.
  const args = { name: 'Q4 client trip', fields: { department: 'QA', Division: 'ops', 'Business Purpose': 'client visit', billable: 'no' } };

  it('builds the header from the form defaults + overlays, previews every field, creates, then re-reads', async () => {
    const { preview: p, text, sent, jwt } = await confirmed('concur_create_report', args, [
      newForm(),
      divItems,
      bpItems,
      deptItems,
      newForm(),
      divItems,
      bpItems,
      deptItems,
      { createReport: { reportId: RID } },
      reportData(),
    ]);

    const fields = {
      policyId: 'POL1',
      reportSource: 'WEB',
      name: 'Q4 client trip',
      reportDate: TODAY,
      countryCode: 'US',
      orgUnit1: { value: 'ORG_OPS' },
      orgUnit2: { value: 'DEPT_QA' },
      custom5: { value: 'BP_CV' },
      custom7: { value: '' },
      custom9: { value: 'N' },
      custom16: { value: '012345' },
      businessPurpose: '',
      comment: '',
    };
    expect(p.preview.willSend).toEqual({ userId: SUB, contextRole: 'TRAVELER', fields });
    expect(p.preview.action).toContain('Create the expense report "Q4 client trip"');
    expect(p.preview.missingRequired).toBeUndefined();
    expect(p.preview.fields).toEqual(
      expect.arrayContaining([
        { label: 'Business Purpose', field: 'custom5', value: 'Client visit' },
        { label: 'Department', field: 'orgUnit2', value: 'Quality' },
        { label: 'Division', field: 'orgUnit1', value: 'Operations' },
        { label: 'Billable', field: 'custom9', value: 'No' },
        { label: 'Country', field: 'countryCode', value: 'United States' },
        { label: 'Report Date', field: 'reportDate', value: TODAY },
        { label: 'businessPurpose', field: 'businessPurpose', value: '' },
      ]),
    );

    expect(sent.map((s) => s.query)).toEqual([NEW_REPORT_FORM, LIST_ITEMS, LIST_ITEMS, LIST_ITEMS, CREATE_REPORT, GET_REPORT]);
    expect(sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', policyId: null });
    // The top list level resolves first, so the lower level searches under the NEW item, not the default.
    expect(sent[1]!.variables.listInformation).toEqual({ id: 'LST_ORG', parentListItemId: null, searchBy: 'TEXT', searchByCriteria: 'ops' });
    expect(sent[2]!.variables.listInformation).toEqual({ id: 'LST_BP', parentListItemId: null, searchBy: 'TEXT', searchByCriteria: 'client visit' });
    expect(sent[3]!.variables.listInformation).toEqual({ id: 'LST_ORG', parentListItemId: 'ORG_OPS', searchBy: 'TEXT', searchByCriteria: 'QA' });
    expect(sent[4]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', fields });
    expect(sent[5]!.variables).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER' });

    expect(text).not.toContain(jwt);
    const out = untrustedPayload(text);
    expect(out.created).toBe(true);
    expect(out.reportId).toBe(RID);
    expect(out.response).toEqual({ reportId: RID });
    expect((out.verified as { report: { name: string } }).report.name).toBe('October travel');
  });

  it('a create whose re-read fails is STILL a success, with the new reportId (never an orphan)', async () => {
    const { result, text, sent } = await confirmed('concur_create_report', { name: 'Trip' }, [
      newForm(),
      newForm(),
      { createReport: { reportId: RID } },
      failedReRead(),
    ]);
    expect(sent.map((s) => s.query)).toEqual([NEW_REPORT_FORM, CREATE_REPORT, GET_REPORT]);
    const out = expectUnverifiedSuccess(result, text);
    expect(out).toMatchObject({ created: true, reportId: RID, response: { reportId: RID } });
  });

  it('a create answered with the id plus a sub-field error succeeds, carrying the warning', async () => {
    const { text } = await confirmed('concur_create_report', { name: 'Trip' }, [
      newForm(),
      newForm(),
      gqlPartial({ createReport: { reportId: RID } }, fieldError(['createReport', 'extra'], 'corr-c')),
      reportData(),
    ]);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ created: true, reportId: RID });
    expect(out.warnings).toEqual([{ path: 'createReport.extra', message: 'An error occurred', correlationId: 'corr-c' }]);
  });

  it('passes a chosen policy and named header values; free-text businessPurpose when the form has no dropdown', async () => {
    const form = newForm({ policyId: null });
    form.newReportForm.fields = form.newReportForm.fields.filter((x) => x.id !== 'custom5');
    const { text, sent } = await preview(
      'concur_create_report',
      { name: 'Trip', reportDate: '2026-10-01', businessPurpose: 'Offsite', comment: 'Hi', policyId: 'POL9' },
      [form],
    );
    expect(sent[0]!.variables.policyId).toBe('POL9');
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({
      policyId: 'POL9',
      reportDate: '2026-10-01',
      businessPurpose: 'Offsite',
      comment: 'Hi',
    });
    expect(p.preview.missingRequired).toBeUndefined();
  });

  it('lists REQUIRED editable fields that will be sent empty as {label, field}, skipping read-only ones', async () => {
    const form = newForm();
    form.newReportForm.fields = form.newReportForm.fields.map((x) =>
      x.id === 'custom16' ? { ...x, isRequired: true, value: { stringValue: '' } } : x,
    );
    // Required, read-only, computed: never "missing".
    form.newReportForm.fields.push({ id: 'reportTotal', label: 'Report Total', dataType: 'AMOUNT', isRequired: true, accessMode: 'RO', value: null });
    const { text } = await preview('concur_create_report', { name: 'Trip' }, [form]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.status).toBe('confirmation-required');
    expect(p.preview.missingRequired).toEqual([{ label: 'Business Purpose', field: 'custom5' }]);
    expect(p.preview.caveat).toMatch(/sent empty.*still creates the report but flags an exception/);
  });

  it('sends a country by its code, else by its item id', async () => {
    const form = newForm();
    form.newReportForm.fields = form.newReportForm.fields.map((field) =>
      field.id === 'country' ? { ...field, value: { code: null, id: 'CTRY_US', listItemValue: 'United States' } } : field,
    );
    const { text } = await preview('concur_create_report', { name: 'Trip' }, [form]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({ countryCode: 'CTRY_US' });
  });

  it('refuses when the form has no default policy and none was given', async () => {
    const { text } = await preview('concur_create_report', { name: 'Trip' }, [newForm({ policyId: null })]);
    expect(text).toContain('no default expense policy');
  });

  it('refuses when Concur returns no form', async () => {
    const { text } = await preview('concur_create_report', { name: 'Trip' }, [{ newReportForm: null }]);
    expect(text).toContain('no report header form');
  });

  it.each([
    ['Nope', 'This report form has no field "Nope".'],
    ['Cost Center', 'The "Cost Center" field cannot be set by this tool.'],
    ['Start Date', 'The "Start Date" field cannot be set by this tool.'],
  ])('refuses field %s, listing the settable ones', async (label, message) => {
    const { text } = await preview('concur_create_report', { name: 'Trip', fields: { [label]: 'x' } }, [newForm()]);
    expect(text).toContain(message);
    expect(text).toContain('Settable fields: Report Name; Report Date; Country; Division; Department; Business Purpose; Project Code; Billable.');
  });

  it('reports a create that returned no id instead of claiming success', async () => {
    const { text, sent } = await confirmed('concur_create_report', { name: 'Trip' }, [
      newForm(),
      newForm(),
      { createReport: null },
    ]);
    expect(sent.map((s) => s.query)).toEqual([NEW_REPORT_FORM, CREATE_REPORT]);
    expect(text).toContain('returned no report id');
  });
});

// ── the live tenant's duplicate "Business Purpose" ────────────────────────

describe('"Business Purpose" on the live new-report form', () => {
  // Verbatim shapes from the real form: a free-text field AND the required
  // dropdown the web app shows (it sends businessPurpose: "" and custom5).
  const liveForm = () => {
    const form = newForm();
    form.newReportForm.fields = [
      { id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', isRequired: false, accessMode: 'READ_WRITE', value: null },
      ...form.newReportForm.fields.map((x) => (x.id === 'custom5' ? { ...x, dataType: 'LIST' } : x)),
      { id: 'reportTotal', label: 'Report Total', dataType: 'AMOUNT', isRequired: true, accessMode: 'RO', value: null },
      { id: 'approvalStatus', label: 'Approval Status', dataType: 'STRING', isRequired: true, accessMode: 'RO', value: null },
    ];
    return form;
  };
  const meetings = { CDS_spend: { list: { items: [{ id: 'BP_IME', code: 'IME', value: 'Internal Meetings/Expenses' }] } } };

  it('the businessPurpose argument goes to the required dropdown (custom5), resolved by item text', async () => {
    const args = { name: 'Q4 offsite', businessPurpose: 'Internal Meetings/Expenses' };
    const { preview: p, sent } = await confirmed('concur_create_report', args, [
      liveForm(),
      meetings,
      liveForm(),
      meetings,
      { createReport: { reportId: RID } },
      reportData(),
    ]);
    expect(p.preview.willSend.fields).toMatchObject({ custom5: { value: 'BP_IME' }, businessPurpose: '' });
    expect(p.preview.missingRequired).toBeUndefined();
    expect(p.preview.fields).toEqual(expect.arrayContaining([{ label: 'Business Purpose', field: 'custom5', value: 'Internal Meetings/Expenses' }]));
    expect(sent[1]!.variables.listInformation).toMatchObject({ id: 'LST_BP', searchByCriteria: 'Internal Meetings/Expenses' });
    expect(sent.map((s) => s.query)).toEqual([NEW_REPORT_FORM, LIST_ITEMS, CREATE_REPORT, GET_REPORT]);
  });

  it('fields: {"Business Purpose": …} also picks the dropdown, not the free-text twin', async () => {
    const { text } = await preview('concur_create_report', { name: 'Trip', fields: { 'Business Purpose': 'internal meetings/expenses' } }, [
      liveForm(),
      meetings,
    ]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({ custom5: { value: 'BP_IME' }, businessPurpose: '' });
  });

  it('without a purpose, the preview flags only the dropdown as missing (not the read-only computed fields)', async () => {
    const { text } = await preview('concur_create_report', { name: 'Trip' }, [liveForm()]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.missingRequired).toEqual([{ label: 'Business Purpose', field: 'custom5' }]);
  });

  it('an item the dropdown does not have is refused before any write', async () => {
    const { text } = await preview('concur_create_report', { name: 'Trip', businessPurpose: 'Golf' }, [
      liveForm(),
      { CDS_spend: { list: { items: [] } } },
    ]);
    expect(text).toContain('"Golf" is not an item of the "Business Purpose" list.');
  });

  it('same-label twins with no required one: the list the text resolves in wins, resolved ONCE', async () => {
    const form = newForm();
    form.newReportForm.fields.push(
      { id: 'custom11', label: 'Region', accessMode: 'READ_WRITE', value: null },
      { id: 'custom12', label: 'Region', accessMode: 'READ_WRITE', list: { id: 'LST_REG', level: 1, defaultSearchBy: 'TEXT' }, value: null },
    );
    const east = { CDS_spend: { list: { items: [{ id: 'REG_E', code: 'E', value: 'East' }] } } };
    const { text, sent } = await preview('concur_create_report', { name: 'Trip', fields: { Region: 'east' } }, [form, east]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({ custom12: { value: 'REG_E' } });
    expect(p.preview.willSend.fields).not.toHaveProperty('custom11.value', 'east');
    expect(sent.filter((s) => s.query === LIST_ITEMS)).toHaveLength(1);
  });

  it('a pick-list twin (options, no searchable list) resolves locally', async () => {
    const form = newForm();
    form.newReportForm.fields.push(
      { id: 'custom11', label: 'Tier', accessMode: 'READ_WRITE', value: null },
      { id: 'custom12', label: 'Tier', accessMode: 'READ_WRITE', options: [{ id: 'T_G', code: 'G', value: 'Gold' }], value: null },
    );
    const { text, sent } = await preview('concur_create_report', { name: 'Trip', fields: { Tier: 'gold' } }, [form]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({ custom12: { value: 'T_G' } });
    expect(sent).toHaveLength(1);
  });

  it('a lower connected-list twin is re-resolved under the parent the overlays choose', async () => {
    const form = newForm();
    form.newReportForm.fields.push(
      { id: 'custom11', label: 'Team', accessMode: 'READ_WRITE', value: null },
      { id: 'orgUnit3', label: 'Team', accessMode: 'READ_WRITE', list: { id: 'LST_ORG', level: 2, defaultSearchBy: 'TEXT' }, value: null },
    );
    const qa = { CDS_spend: { list: { items: [{ id: 'T_QA', code: 'QA', value: 'QA' }] } } };
    const { text, sent } = await preview('concur_create_report', { name: 'Trip', fields: { Team: 'qa' } }, [form, qa, qa]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toMatchObject({ orgUnit3: { value: 'T_QA' } });
    const lookups = sent.filter((s) => s.query === LIST_ITEMS);
    expect(lookups).toHaveLength(2);
    expect(lookups[0]!.variables.listInformation).toMatchObject({ parentListItemId: 'ORG1' });
  });

  it('concur_update_report routes businessPurpose to the dropdown too', async () => {
    const existing = {
      existingReportForm: {
        policyId: 'POL1',
        fields: [
          { id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', accessMode: 'READ_WRITE', value: { stringValue: '' } },
          {
            id: 'custom5',
            label: 'Business Purpose',
            dataType: 'LIST',
            isRequired: true,
            accessMode: 'READ_WRITE',
            list: { id: 'LST_BP', level: 1, defaultSearchBy: 'TEXT' },
            value: null,
          },
        ] as FormField[],
      },
    };
    const { text } = await preview('concur_update_report', { reportId: RID, businessPurpose: 'Internal Meetings/Expenses' }, [existing, meetings]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.willSend.fields).toEqual({ custom5: { value: 'BP_IME' } });
    expect(p.preview.missingRequired).toBeUndefined();
  });

  it('an update that leaves the required dropdown empty says so in the preview', async () => {
    const existing = {
      existingReportForm: {
        policyId: 'POL1',
        fields: [
          { id: 'name', label: 'Report Name', accessMode: 'READ_WRITE', value: { stringValue: 'Old' } },
          { id: 'custom5', label: 'Business Purpose', isRequired: true, list: { id: 'LST_BP', level: 1 }, value: null },
        ] as FormField[],
      },
    };
    const { text } = await preview('concur_update_report', { reportId: RID, name: 'New' }, [existing]);
    const p = parseToolResult<Preview>({ content: [{ type: 'text', text }] } as never);
    expect(p.preview.missingRequired).toEqual([{ label: 'Business Purpose', field: 'custom5' }]);
    expect(p.preview.caveat).toMatch(/still empty/);
  });
});

// ── update ────────────────────────────────────────────────────────────────

describe('concur_update_report', () => {
  const existing = () => ({
    existingReportForm: {
      policyId: 'POL1',
      fields: [
        { id: 'name', label: 'Report Name', accessMode: 'READ_WRITE', value: { stringValue: 'Old name' } },
        { id: 'reportDate', label: 'Report Date', accessMode: 'READ_WRITE', value: { dateValue: '2026-10-01' } },
        {
          id: 'custom5',
          label: 'Business Purpose',
          accessMode: 'READ_WRITE',
          list: { id: 'LST_BP', level: 1, defaultSearchBy: 'TEXT' },
          value: { code: 'OP', id: 'BP_OLD', listItemValue: 'Old purpose' },
        },
      ] as FormField[],
    },
  });

  it('sends only the fields that change and previews each from → to', async () => {
    const args = { reportId: RID, name: 'New name', reportDate: '2026-10-01', comment: 'note', fields: { 'Business Purpose': 'Client visit' } };
    const { preview: p, text, sent } = await confirmed('concur_update_report', args, [
      existing(),
      bpItems,
      existing(),
      bpItems,
      { updateReport: { reportId: RID } },
      reportData(),
    ]);
    const variables = {
      userId: SUB,
      contextRole: 'TRAVELER',
      reportId: RID,
      fields: { name: 'New name', comment: 'note', custom5: { value: 'BP_CV' } },
    };
    expect(p.preview.willSend).toEqual(variables);
    expect(p.preview.changes).toEqual([
      { label: 'Report Name', field: 'name', from: 'Old name', to: 'New name' },
      { label: 'Business Purpose', field: 'custom5', from: 'Old purpose', to: 'Client visit' },
      { label: 'comment', field: 'comment', from: null, to: 'note' },
    ]);
    expect(sent.map((s) => s.query)).toEqual([REPORT_FORM, LIST_ITEMS, UPDATE_REPORT, GET_REPORT]);
    expect(sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID });
    expect(sent[2]!.variables).toEqual(variables);
    const out = untrustedPayload(text);
    expect(out.updated).toBe(true);
    expect(out.reportId).toBe(RID);
    expect(out.response).toEqual({ reportId: RID });
    expect(out.changedFields).toEqual(['Report Name', 'Business Purpose', 'comment']);
    expect((out.verified as { report: unknown }).report).toBeDefined();
  });

  it('an update whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed('concur_update_report', { reportId: RID, name: 'New name' }, [
      existing(),
      existing(),
      { updateReport: { reportId: RID } },
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ updated: true, reportId: RID, changedFields: ['Report Name'] });
  });

  it('refuses when nothing would change, without writing', async () => {
    const { text } = await preview('concur_update_report', { reportId: RID, name: 'Old name' }, [existing()]);
    expect(text).toContain('Nothing to change');
  });

  it('refuses when Concur returns no form', async () => {
    const { text } = await preview('concur_update_report', { reportId: RID, name: 'x' }, [{ existingReportForm: { fields: null } }]);
    expect(text).toContain('no report header form');
  });
});

// ── delete ────────────────────────────────────────────────────────────────

describe('concur_delete_report', () => {
  const ok = { status: { success: true } };
  const delEntries = (status: unknown = ok.status) => ({ employee: { expenseReport: { deleteExpenseEntries: { status } } } });
  const delReport = (status: unknown = ok.status) => ({ employee: { expenseReport: { deleteReport: { status } } } });

  it('previews the expenses, deletes them then the report, and verifies it is gone', async () => {
    const full = reportData({ entries: [entry(E1), entry(E2)] });
    const { preview: p, text, sent } = await confirmed('concur_delete_report', { reportId: RID }, [
      full,
      full,
      delEntries(),
      delReport(),
      { employee: { expenseReport: null }, reportEntriesDetails: null, reportExceptions: null },
    ]);
    expect(p.preview.action).toContain('Permanently delete report "October travel" and its 2 expense(s)');
    expect(p.preview.expensesToDelete).toEqual([
      { date: '2026-10-02', expenseType: 'Dues', vendor: 'Acme Club', amount: '12.5 USD' },
      { date: '2026-10-02', expenseType: 'Dues', vendor: 'Acme Club', amount: '12.5 USD' },
    ]);
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, DELETE_EXPENSE_ENTRIES, DELETE_REPORT, GET_REPORT]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID, expenseIds: [E1, E2] });
    expect(sent[2]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER', reportId: RID });
    expect(untrustedPayload(text)).toEqual({
      deleted: true,
      reportId: RID,
      deletedExpenses: 2,
      response: { status: { success: true } },
      verified: { observed: 'the report is no longer readable' },
    });
  });

  it('a pre-read with a failed sub-field (the live rptKey case) still previews and deletes', async () => {
    const partial = () =>
      gqlPartial(reportData({ entries: [entry(E1)] }), fieldError(['employee', 'expenseReport', 'rptKey'], 'corr-k'));
    const { preview: p, text } = await confirmed('concur_delete_report', { reportId: RID }, [
      partial(),
      partial(),
      delEntries(),
      delReport(),
      { employee: { expenseReport: null }, reportEntriesDetails: null, reportExceptions: null },
    ]);
    expect(p.preview.expensesToDelete).toHaveLength(1);
    expect(untrustedPayload(text)).toMatchObject({ deleted: true, deletedExpenses: 1 });
  });

  it('refuses to preview when the expense list came back partial — it could understate what is deleted', async () => {
    const partial = gqlPartial(
      reportData({ entries: [entry(E1)] }),
      fieldError(['reportEntriesDetails', 'entries', 1, 'summary'], 'corr-p'),
    );
    const { result, text, sent } = await once('concur_delete_report', { reportId: RID }, [partial]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain("could not read all of report");
    expect(text).toContain('correlationId=corr-p');
    expect(sent.filter((x) => isMutation(x.query))).toEqual([]);
  });

  it('names the failed part even when Concur gives no correlationId', async () => {
    const partial = gqlPartial(reportData({ entries: [entry(E1)] }), {
      message: 'An error occurred',
      path: ['reportEntriesDetails'],
      // Not empty: empty extensions is the stale-session signature, which re-lifts and replays.
      extensions: { dataSource: 'ExpenseReportService', response: { status: 500 } },
    });
    const { result, text } = await once('concur_delete_report', { reportId: RID }, [partial]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain(`could not read all of report ${RID} (reportEntriesDetails)`);
  });

  it('an empty report whose delete fails surfaces Concur’s error as-is (nothing else was deleted)', async () => {
    const { result, text } = await confirmed('concur_delete_report', { reportId: RID }, [
      reportData(),
      reportData(),
      errorsResponse([fieldError(['employee', 'expenseReport', 'deleteReport'], 'corr-e')]),
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).not.toContain('WERE deleted');
    expect(text).toContain('correlationId=corr-e');
  });

  it('says plainly that the expenses were deleted when deleting the report itself then fails', async () => {
    const full = reportData({ entries: [entry(E1)] });
    const { result, text } = await confirmed('concur_delete_report', { reportId: RID }, [
      full,
      full,
      delEntries(),
      errorsResponse([fieldError(['employee', 'expenseReport', 'deleteReport'], 'corr-d')]),
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain("The report's 1 expense(s) WERE deleted, but deleting the report itself failed");
    expect(text).toContain('correlationId=corr-d');
  });

  it('skips the entry delete for an empty report, and treats an errors[] re-read as gone', async () => {
    const { text, sent } = await confirmed('concur_delete_report', { reportId: RID }, [
      reportData({ name: null }),
      reportData({ name: null }),
      delReport(),
      errorsResponse([{ message: 'An error occurred' }]),
    ]);
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, DELETE_REPORT, GET_REPORT]);
    expect(untrustedPayload(text)).toMatchObject({ deleted: true, deletedExpenses: 0 });
  });

  it('says so when the report can still be read after a "successful" delete', async () => {
    const { text } = await confirmed('concur_delete_report', { reportId: RID }, [reportData(), reportData(), delReport(), reportData()]);
    expect(untrustedPayload(text)).toMatchObject({
      deleted: true,
      verified: { observed: 'Concur reported success but the report can still be read' },
    });
  });

  it('a re-read that fails for a non-GraphQL reason is a verificationError on a success', async () => {
    const { text, result } = await confirmed('concur_delete_report', { reportId: RID }, [reportData(), reportData(), delReport()]);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ deleted: true, reportId: RID, deletedExpenses: 0 });
    expect(out.verificationError).toMatch(/re-reading it failed/);
  });

  it('stops before deleting the report when the expense delete is not confirmed', async () => {
    const full = reportData({ entries: [entry(E1)] });
    const { text, sent } = await confirmed('concur_delete_report', { reportId: RID }, [full, full, delEntries({ success: false })]);
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, DELETE_EXPENSE_ENTRIES]);
    expect(text).toContain("did not confirm deleting the report's expenses (the report was NOT deleted)");
  });

  it('reports an unconfirmed report delete', async () => {
    const { text } = await confirmed('concur_delete_report', { reportId: RID }, [
      reportData(),
      reportData(),
      { employee: { expenseReport: { deleteReport: null } } },
    ]);
    expect(text).toContain('did not confirm deleting the report');
  });
});

// ── comment ───────────────────────────────────────────────────────────────

describe('concur_add_report_comment', () => {
  /** A `timelineSummary` comment item, in the live shape (verified 2026-10-08). */
  const item = (comment: string) => ({
    id: `id-${comment}`,
    action: null,
    authorName: 'Chris Hall',
    comment,
    commentSource: null,
    commentType: 'report',
    creationDate: '2026-10-08T18:50:11.580Z',
  });
  const days = (comments: string[]) =>
    comments.length === 0 ? [] : [{ summaryDate: '2026-10-08T18:50:11.580Z', summaryItems: comments.map(item) }];
  const timeline = (comments: string[] | null, name: string | null = 'October travel') => ({
    employee: { userId: SUB, expenseReport: { reportId: RID, reportDetails: { id: RID, name } } },
    timelineSummary: comments === null ? null : days(comments),
    auditTrails: { report: [], expense: [] },
  });
  const created = (success: boolean, after: string[] | null = null) => ({
    createNewReportComment: { status: { success }, timelineSummary: after === null ? null : days(after) },
  });

  it('selects the timeline summary on the mutation itself', () => {
    expect(CREATE_REPORT_COMMENT).toMatch(/timelineSummary \{ summaryItems \{ id comment commentType authorName creationDate \} \}/);
  });

  it('confirms the comment from the mutation response, without a re-read', async () => {
    const { preview: p, text, sent } = await confirmed('concur_add_report_comment', { reportId: RID, comment: ' Receipts attached ' }, [
      timeline(['earlier']),
      timeline(['earlier']),
      created(true, ['earlier', 'Receipts attached']),
    ]);
    expect(p.preview.action).toContain('Add a comment to report "October travel" (visible to approvers; cannot be deleted)');
    expect(p.preview.willSend).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER', comment: 'Receipts attached' });
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT_TIMELINE, CREATE_REPORT_COMMENT]);
    expect(sent[1]!.variables).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER', comment: 'Receipts attached' });
    expect(untrustedPayload(text)).toEqual({
      commented: true,
      reportId: RID,
      response: { status: { success: true } },
      verified: {
        onTimeline: true,
        via: 'mutation response',
        observed: 'the comment is on the report timeline',
        comments: ['earlier', 'Receipts attached'],
      },
    });
  });

  it('falls back to re-reading the timeline when the mutation response does not show it', async () => {
    const { text, sent } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'Receipts attached' }, [
      timeline([]),
      timeline([]),
      created(true, null),
      // The live answer right after the comment.
      {
        employee: { userId: SUB, expenseReport: { reportId: RID, reportDetails: { id: RID, name: 'October travel' } } },
        timelineSummary: [
          {
            summaryDate: '2026-10-08T18:50:11.580Z',
            summaryItems: [
              {
                id: 'e290d7d9-0000-0000-0000-000000000001',
                action: null,
                authorName: 'Chris Hall',
                comment: 'Receipts attached',
                commentSource: null,
                commentType: 'report',
                creationDate: '2026-10-08T18:50:11.580Z',
              },
            ],
          },
        ],
        auditTrails: { report: [], expense: [] },
      },
    ]);
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT_TIMELINE, CREATE_REPORT_COMMENT, GET_REPORT_TIMELINE]);
    expect(untrustedPayload(text)).toEqual({
      commented: true,
      reportId: RID,
      response: { status: { success: true } },
      verified: {
        onTimeline: true,
        via: 're-read',
        observed: 'the comment is on the report timeline',
        comments: ['Receipts attached'],
      },
    });
  });

  it('a mutation whose timelineSummary errored still succeeds and re-reads', async () => {
    const { result, text } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'hello' }, [
      timeline([]),
      timeline([]),
      gqlPartial(created(true, null), fieldError(['createNewReportComment', 'timelineSummary'], 'corr-m')),
      timeline(['hello']),
    ]);
    expect(result.isError).toBeFalsy();
    expect(untrustedPayload(text)).toMatchObject({ commented: true, verified: { onTimeline: true, via: 're-read' } });
  });

  it('a comment whose timeline re-read fails is still a success', async () => {
    const { result, text } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'hello' }, [
      timeline([]),
      timeline([]),
      created(true),
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ commented: true, reportId: RID });
  });

  it('does not claim a comment the timeline does not show', async () => {
    const { text, preview: p } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'hello' }, [
      timeline(null, null),
      timeline(null, null),
      created(true, []),
      timeline(null, null),
    ]);
    expect(p.preview.action).toContain(`report "${RID}"`);
    expect(untrustedPayload(text)).toMatchObject({ commented: true, verified: { onTimeline: false, via: 're-read', comments: [] } });
    expect((untrustedPayload(text).verified as { observed: string }).observed).toContain('0 comment(s), 0 before');
  });

  it('counts only items that carry a comment', async () => {
    const { text } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'hello' }, [
      timeline(['a']),
      timeline(['a']),
      created(true),
      {
        ...timeline(['a']),
        timelineSummary: [{ summaryDate: null, summaryItems: [item('a'), { ...item('x'), comment: null, action: 'Submitted' }] }, { summaryDate: null, summaryItems: null }],
      },
    ]);
    expect((untrustedPayload(text).verified as { observed: string; comments: string[] }).comments).toEqual(['a']);
    expect((untrustedPayload(text).verified as { observed: string }).observed).toContain('1 comment(s), 1 before');
  });

  it('reports an unconfirmed comment', async () => {
    const { text } = await confirmed('concur_add_report_comment', { reportId: RID, comment: 'hello' }, [
      timeline([]),
      timeline([]),
      { createNewReportComment: null },
    ]);
    expect(text).toContain('did not confirm adding the comment');
  });
});

// ── submit ────────────────────────────────────────────────────────────────

describe('concur_submit_report', () => {
  const submitted = reportData({ meta: { isSubmitted: true } });
  const submitOk = (status: unknown) => ({ CDS_expense: { report: { submit: { status } } } });

  it('refuses when the exception list came back partial — a blocking exception could be hidden', async () => {
    const partial = gqlPartial(reportData({ entries: [entry(E1)] }), fieldError(['reportExceptions'], 'corr-x'));
    const { result, text, sent } = await once('concur_submit_report', { reportId: RID }, [partial]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain("could not read all of report");
    expect(text).toContain('correlationId=corr-x');
    expect(sent.filter((x) => isMutation(x.query))).toEqual([]);
  });

  it('validates + submits on the spend endpoint with the CDS shape, then reads back the submitted state', async () => {
    const warn = { exceptionCode: 'OLD', isBlocking: false, message: null, expenseId: null };
    const before = reportData({ entries: [entry(E1)], exceptions: [warn] });
    const { preview: p, text, sent } = await confirmed('concur_submit_report', { reportId: RID }, [
      before,
      before,
      submitOk('STATUS_COMPLETED'),
      submitted,
    ]);
    const variables = {
      contextRole: 'TRAVELER',
      reportId: RID,
      userId: SUB,
      reportSource: 'WEB',
      validate: true,
      approverValidated: false,
    };
    expect(p.preview.willSend).toEqual(variables);
    expect(p.preview.warnings).toEqual(['OLD']);
    expect(p.preview.action).toContain('Submit report "October travel" to your approver');
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, SUBMIT_REPORT, GET_REPORT]);
    expect(sent[1]!.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/graphql');
    expect(sent[1]!.variables).toEqual(variables);
    expect(untrustedPayload(text)).toMatchObject({
      submitted: true,
      reportId: RID,
      status: 'STATUS_COMPLETED',
      verified: { submitted: true, observed: 'the report is submitted' },
    });
  });

  it('a submit whose re-read fails is not an error: it reports Concur’s status and says to check', async () => {
    const { result, text } = await confirmed('concur_submit_report', { reportId: RID }, [
      reportData(),
      reportData(),
      { CDS_expense: { report: { submit: { status: 'STATUS_COMPLETED' } } } },
      failedReRead(),
    ]);
    const out = expectUnverifiedSuccess(result, text);
    expect(out).toMatchObject({ reportId: RID, status: 'STATUS_COMPLETED' });
    expect(out.submitted).toBeUndefined();
    expect(out.observed).toMatch(/could not be re-read — check it with concur_get_report/);
  });

  it('a refused submit whose re-read also fails still reports the refusal', async () => {
    const { text } = await confirmed('concur_submit_report', { reportId: RID }, [
      reportData(),
      reportData(),
      errorsResponse([{ message: 'An error occurred', extensions: { exception: { key: 'K', data: { errorMessage: 'No approver' } } } }]),
      failedReRead(),
    ]);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ refusal: { key: 'K', message: 'No approver' }, observed: 'Concur refused the submit — see `refusal`' });
    expect(out.verificationError).toBeDefined();
  });

  it('refuses a report with blocking exceptions before any preview or write', async () => {
    const blocking = { exceptionCode: 'MISSREQ', isBlocking: true, message: 'Missing required information', expenseId: E1 };
    const { text, sent } = await preview('concur_submit_report', { reportId: RID }, [reportData({ exceptions: [blocking] })]);
    expect(sent).toHaveLength(1);
    expect(text).toContain('has 1 blocking exception(s) and cannot be submitted: Missing required information');
  });

  it('reports Concur’s refusal (errors[].extensions.exception) and the observed unsubmitted state', async () => {
    const { text, sent } = await confirmed('concur_submit_report', { reportId: RID, acknowledgeWarnings: true }, [
      reportData({ name: null }),
      reportData({ name: null }),
      errorsResponse([{ message: 'An error occurred', extensions: { exception: { key: 'ERROR_SUBMIT', data: { errorMessage: 'Approver missing' } } } }]),
      reportData({ meta: null }),
    ]);
    expect(sent[1]!.variables.validate).toBe(false);
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ submitted: false, refusal: { key: 'ERROR_SUBMIT', message: 'Approver missing' } });
    expect(out.status).toBeUndefined();
    expect((out.verified as { observed: string }).observed).toContain('NOT submitted');
  });

  it('falls back to the error message when the refusal has no exception detail', async () => {
    const { text } = await confirmed('concur_submit_report', { reportId: RID }, [
      reportData(),
      reportData(),
      errorsResponse([{ message: 'An error occurred' }]),
      reportData(),
    ]);
    expect((untrustedPayload(text).refusal as { message: string }).message).toContain('An error occurred');
  });

  it('keeps a submit that answered a non-completed status honest', async () => {
    const { text } = await confirmed('concur_submit_report', { reportId: RID }, [
      reportData(),
      reportData(),
      { CDS_expense: null },
      reportData(),
    ]);
    expect(untrustedPayload(text)).toMatchObject({ submitted: false });
  });

  it('surfaces a transport failure on the submit itself', async () => {
    const { result } = await confirmed('concur_submit_report', { reportId: RID }, [reportData(), reportData()]);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

// ── recall ────────────────────────────────────────────────────────────────

describe('concur_recall_report', () => {
  const submitted = reportData({ meta: { isSubmitted: true, canRecall: true } });

  it('recalls and reads back the unsubmitted state', async () => {
    const { preview: p, text, sent } = await confirmed('concur_recall_report', { reportId: RID }, [
      submitted,
      submitted,
      { recallReport: { id: RID, approvalStatus: 'Not Submitted' } },
      reportData(),
    ]);
    expect(p.preview.willSend).toEqual({ contextRole: 'TRAVELER', reportId: RID, userId: SUB });
    expect(p.preview.action).toContain('Recall report "October travel" from your approver');
    expect(sent.map((s) => s.query)).toEqual([GET_REPORT, RECALL_REPORT, GET_REPORT]);
    expect(untrustedPayload(text)).toMatchObject({
      recalled: true,
      reportId: RID,
      response: { id: RID, approvalStatus: 'Not Submitted' },
      verified: { unsubmitted: true, observed: 'the report is back with you, unsubmitted' },
    });
  });

  it('says so when the report still shows as submitted', async () => {
    const { text } = await confirmed('concur_recall_report', { reportId: RID }, [submitted, submitted, { recallReport: null }, submitted]);
    expect(untrustedPayload(text)).toMatchObject({
      recalled: true,
      verified: { unsubmitted: false, observed: 'Concur accepted the recall but the report still shows as submitted' },
    });
  });

  it('a recall whose re-read fails is still a success', async () => {
    const { result, text } = await confirmed('concur_recall_report', { reportId: RID }, [
      submitted,
      submitted,
      { recallReport: { id: RID, approvalStatus: 'Not Submitted' } },
      failedReRead(),
    ]);
    expect(expectUnverifiedSuccess(result, text)).toMatchObject({ recalled: true, reportId: RID });
  });

  it('refuses a report Concur says cannot be recalled', async () => {
    const { text } = await preview('concur_recall_report', { reportId: RID }, [reportData({ meta: { canRecall: false } })]);
    expect(text).toContain(`Report ${RID} cannot be recalled (status: Not Submitted).`);
  });
});

describe('localIsoDate', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });

  it('formats the LOCAL calendar date, not the UTC one', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 02:00 UTC on 9 Oct is still the evening of 8 Oct in California.
    expect(localIsoDate(Date.UTC(2026, 9, 9, 2, 0))).toBe('2026-10-08');
    process.env.TZ = 'Asia/Tokyo';
    expect(localIsoDate(Date.UTC(2026, 9, 8, 20, 0))).toBe('2026-10-09');
  });
});
