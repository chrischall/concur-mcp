import { afterEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import { GET_REPORT, GET_REPORT_TIMELINE, LIST_REPORTS } from '../src/graphql/reports.js';
import { registerReportTools } from '../src/tools/reports.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload as payloadOf } from './helpers.js';

const RID = '0123456789ABCDEF0123';
const EID = '0123456789abcdef0123456789abcdef';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function call(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerReportTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent, jwt: t.jwt };
}


const usd = (value: number) => ({ value, currencyCode: 'USD' });

const listRow = {
  reportId: RID,
  name: 'October travel',
  reportNumber: 'ABC123',
  reportDate: '2026-10-01',
  startDate: '2026-10-01',
  endDate: '2026-10-05',
  submitDate: null,
  paidDate: null,
  sentBackDate: null,
  approvalStatus: 'Not Submitted',
  approvalStatusId: 'A_NOTF',
  paymentStatus: 'Not Paid',
  exceptionLevel: 0,
  reportType: 'REGULAR',
  wasSentForPayment: false,
  reportTotal: usd(42.5),
  claimedAmount: usd(42.5),
  approvedAmount: usd(0),
  totalAmountDueEmployee: { value: null, currencyCode: null },
  approver: null,
  meta: { canAddExpense: true, isSubmitted: false },
};

const listData = (list: unknown[] | null = [listRow]) => ({
  employee: {
    userId: SUB,
    reportsForUser: { list, pagination: { number: 1, size: 50, totalElements: 1, totalPages: 1 } },
  },
});

describe('concur_list_reports', () => {
  it('lists with the real userId, ALL by default, page 1 size 50, no date range', async () => {
    const { text, sent } = await call('concur_list_reports', {}, [listData()]);
    expect(sent[0]!.query).toBe(LIST_REPORTS);
    expect(sent[0]!.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/graphql');
    expect(sent[0]!.variables).toEqual({
      userId: SUB,
      contextRole: 'TRAVELER',
      filterByStatus: 'ALL',
      dateRange: null,
      paging: { page: 1, size: 50 },
    });
    expect(JSON.parse(text)).toEqual({
      reports: [
        {
          reportId: RID,
          name: 'October travel',
          reportNumber: 'ABC123',
          reportDate: '2026-10-01',
          startDate: '2026-10-01',
          endDate: '2026-10-05',
          approvalStatus: 'Not Submitted',
          paymentStatus: 'Not Paid',
          exceptionLevel: 0,
          total: '42.5 USD',
          claimed: '42.5 USD',
          approved: '0 USD',
        },
      ],
      pagination: { number: 1, size: 50, totalElements: 1, totalPages: 1 },
    });
  });

  it('passes status, date range and paging through; names the approver', async () => {
    const row = { ...listRow, approver: { firstName: 'Ann', lastName: 'Lee', preferredName: null } };
    const { text, sent } = await call(
      'concur_list_reports',
      { status: 'UNSUBMITTED', from: '2026-01-01', to: '2026-12-31', page: 2, size: 100 },
      [listData([row])],
    );
    expect(sent[0]!.variables).toMatchObject({
      filterByStatus: 'UNSUBMITTED',
      dateRange: { start: '2026-01-01', end: '2026-12-31' },
      paging: { page: 2, size: 100 },
    });
    expect((JSON.parse(text) as { reports: { approver: string }[] }).reports[0]!.approver).toBe('Ann Lee');
  });

  it('full returns every selected field, unwrapped; raw is the GraphQL data', async () => {
    const full = await call('concur_list_reports', { view: 'full' }, [listData()]);
    expect(JSON.parse(full.text)).toEqual({ reports: [listRow], pagination: listData().employee.reportsForUser.pagination });
    await harness?.close();
    const raw = await call('concur_list_reports', { view: 'raw' }, [listData()]);
    expect(JSON.parse(raw.text)).toEqual(listData());
  });

  it('a null list is an empty page', async () => {
    const { text } = await call('concur_list_reports', {}, [listData(null)]);
    expect(JSON.parse(text).reports).toEqual([]);
  });

  it('refuses a half-open date range before calling Concur', async () => {
    const { result, sent } = await call('concur_list_reports', { from: '2026-01-01' }, []);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/both `from` and `to`/);
    expect(sent).toHaveLength(0);
  });

  it('rejects an unknown status and a malformed date at the schema', async () => {
    const bad = await call('concur_list_reports', { status: 'PAID' }, []);
    expect(bad.result.isError).toBe(true);
    await harness?.close();
    const badDate = await call('concur_list_reports', { from: '10/01/2026', to: '2026-12-31' }, []);
    expect(badDate.result.isError).toBe(true);
  });

  it('a sub-field error does not sink the list: the rows come back with `warnings` (compact and raw)', async () => {
    const err = fieldError(['employee', 'reportsForUser', 'list', 0, 'approver'], 'corr-77');
    const { text } = await call('concur_list_reports', {}, [gqlPartial(listData(), err)]);
    const out = JSON.parse(text) as { reports: unknown[]; warnings: unknown[] };
    expect(out.reports).toHaveLength(1);
    expect(out.warnings).toEqual([
      { path: 'employee.reportsForUser.list.0.approver', message: 'An error occurred', correlationId: 'corr-77' },
    ]);
    await harness?.close();
    const raw = await call('concur_list_reports', { view: 'raw' }, [gqlPartial(listData(), err)]);
    expect(JSON.parse(raw.text)).toEqual({ ...listData(), warnings: out.warnings });
  });

  it('a null report list beside errors[] is the mapped Concur error (with its correlationId)', async () => {
    const { result } = await call('concur_list_reports', {}, [
      gqlPartial({ employee: { userId: SUB, reportsForUser: null } }, fieldError(['employee', 'reportsForUser'], 'corr-9')),
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/correlationId=corr-9/);
  });

  it('no report list for the user is an error, not an empty page', async () => {
    const { result } = await call('concur_list_reports', {}, [{ employee: null }]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no report list/);
  });

  it('is annotated read-only', async () => {
    const t = await toolHarness(registerReportTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'concur_get_report',
      'concur_get_report_timeline',
      'concur_list_reports',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBeUndefined();
    }
    const untrusted = tools.filter((tool) => /untrusted/.test(tool.description ?? '')).map((tool) => tool.name);
    expect(untrusted.sort()).toEqual(['concur_get_report', 'concur_get_report_timeline']);
  });
});

const summary = {
  id: EID,
  transactionDate: '2026-10-02',
  isPersonalExpense: false,
  isImageRequired: true,
  isPaperReceiptRequired: false,
  receiptImageId: 'IMG1',
  eReceiptImageId: null,
  parentExpenseId: null,
  allocationState: 'N',
  attendeeCount: 0,
  expenseType: { id: 'DUESX', code: 'DUESX', name: 'Dues' },
  paymentType: { id: 'CASH', code: 'CASH', name: 'Cash' },
  vendor: { id: null, description: 'Acme Club', name: null },
  location: { id: 'L1', name: 'Toronto, Ontario', city: 'Toronto', countryCode: 'CA', countrySubDivisionCode: 'CA-ON' },
  transactionAmount: { value: 50, currencyCode: 'CAD' },
  postedAmount: usd(36.5),
  approvedAmount: usd(36.5),
  claimedAmount: usd(36.5),
  meta: { hasReceiptImage: true, hasExceptions: true, canDelete: true, hasComments: false },
};

const missingFieldsException = {
  exceptionCode: 'MISSREQ',
  expenseId: EID,
  parentExpenseId: null,
  isBlocking: true,
  message: 'Missing required information',
  parameters: { missingFields: { fields: ['Business Purpose'], fieldIds: ['custom5'] } },
};

const reportData = (overrides: Record<string, unknown> = {}) => ({
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: {
        id: RID,
        name: 'October travel',
        reportNumber: 'ABC123',
        reportType: 'REGULAR',
        policyId: 'POL1',
        currencyCode: 'USD',
        countryCode: 'US',
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        submitDate: null,
        approvalStatus: 'Not Submitted',
        paymentStatus: 'Not Paid',
        reportOwnerUserId: SUB,
        employee: { firstName: 'Chris', lastName: 'Hall', preferredName: null },
        claimedAmount: usd(36.5),
        approvedAmount: usd(0),
        reportTotal: usd(36.5),
        meta: { hasExpenses: true, canAddExpense: true, isSubmitted: false },
        policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' },
      },
    },
  },
  reportEntriesDetails: { reportId: RID, entries: [{ expenseId: EID, summary }] },
  reportExceptions: {
    reportId: RID,
    countOfExceptions: 2,
    hasBlockingExceptions: true,
    reportExceptions: [
      {
        exceptionCode: 'RPTX',
        expenseId: null,
        parentExpenseId: null,
        isBlocking: false,
        message: 'Report is over 30 days old',
        parameters: null,
      },
    ],
    entryExceptions: [{ expenseId: EID, countOfExceptions: 1, hasBlockingExceptions: true, entryExceptions: [missingFieldsException] }],
  },
  ...overrides,
});

describe('concur_get_report', () => {
  it('reads header + entries + exceptions with the real userId and projects compactly', async () => {
    const { text, sent, jwt } = await call('concur_get_report', { reportId: RID }, [reportData()]);
    expect(sent[0]!.query).toBe(GET_REPORT);
    expect(sent[0]!.variables).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER' });
    expect(text).not.toContain(jwt);
    expect(text).toMatch(/untrusted/i);
    expect(payloadOf(text)).toEqual({
      report: {
        reportId: RID,
        name: 'October travel',
        reportNumber: 'ABC123',
        owner: 'Chris Hall',
        approvalStatus: 'Not Submitted',
        paymentStatus: 'Not Paid',
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        currency: 'USD',
        total: '36.5 USD',
        claimed: '36.5 USD',
        approved: '0 USD',
        policyId: 'POL1',
        expenseListDetailFormId: 'FORM1',
        flags: ['hasExpenses', 'canAddExpense'],
      },
      entries: [
        {
          expenseId: EID,
          date: '2026-10-02',
          expenseType: 'Dues',
          expenseTypeId: 'DUESX',
          vendor: 'Acme Club',
          paymentType: 'Cash',
          amount: '50 CAD',
          posted: '36.5 USD',
          approved: '36.5 USD',
          location: 'Toronto, Ontario',
          receiptImageId: 'IMG1',
          flags: ['hasReceiptImage', 'hasExceptions', 'canDelete'],
        },
      ],
      exceptions: [
        { message: 'Report is over 30 days old', code: 'RPTX' },
        {
          expenseId: EID,
          message: 'Missing required information',
          blocking: true,
          code: 'MISSREQ',
          missingFields: ['Business Purpose'],
        },
      ],
    });
  });

  it('falls back to vendor.name, header policyId, and tolerates absent entries/exceptions', async () => {
    const data = reportData({ reportEntriesDetails: null, reportExceptions: null });
    const details = data.employee.expenseReport.reportDetails as Record<string, unknown>;
    details.policy = null;
    const { text } = await call('concur_get_report', { reportId: RID }, [data]);
    const body = payloadOf(text) as { report: Record<string, unknown>; entries: unknown[]; exceptions: unknown[] };
    expect(body.report.policyId).toBe('POL1');
    expect(body.report.expenseListDetailFormId).toBeUndefined();
    expect(body.entries).toEqual([]);
    expect(body.exceptions).toEqual([]);
  });

  it('entry edge cases: vendor in name, personal expense, null summary, null exception lists', async () => {
    const data = reportData({
      reportEntriesDetails: {
        reportId: RID,
        entries: [
          { expenseId: EID, summary: { ...summary, vendor: { id: null, description: '', name: 'Named Vendor' }, isPersonalExpense: true } },
          { expenseId: 'E2', summary: { ...summary, vendor: null } },
          { expenseId: 'E3', summary: null },
        ],
      },
      reportExceptions: { reportExceptions: null, entryExceptions: [{ expenseId: EID, entryExceptions: null }] },
    });
    const { text } = await call('concur_get_report', { reportId: RID }, [data]);
    const body = payloadOf(text) as { entries: Record<string, unknown>[]; exceptions: unknown[] };
    expect(body.entries[0]).toMatchObject({ vendor: 'Named Vendor', personal: true });
    expect(body.entries[1]!.vendor).toBeUndefined();
    expect(body.entries[2]).toEqual({ expenseId: 'E3' });
    expect(body.exceptions).toEqual([]);
  });

  it('full returns the report, entries and exceptions as selected', async () => {
    const data = reportData();
    const { text } = await call('concur_get_report', { reportId: RID, view: 'full' }, [data]);
    expect(payloadOf(text)).toEqual({
      report: data.employee.expenseReport,
      entries: data.reportEntriesDetails.entries,
      exceptions: data.reportExceptions,
    });
  });

  it('full with no entries gives an empty list', async () => {
    const { text } = await call('concur_get_report', { reportId: RID, view: 'full' }, [reportData({ reportEntriesDetails: null })]);
    expect((payloadOf(text) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('a failed sub-field (exceptions) still returns the report, with `warnings`', async () => {
    const { text } = await call('concur_get_report', { reportId: RID }, [
      gqlPartial(reportData({ reportExceptions: null }), fieldError(['reportExceptions'], 'corr-5')),
    ]);
    const out = payloadOf(text) as { report: { name: string }; exceptions: unknown[]; warnings: unknown[] };
    expect(out.report.name).toBe('October travel');
    expect(out.exceptions).toEqual([]);
    expect(out.warnings).toEqual([{ path: 'reportExceptions', message: 'An error occurred', correlationId: 'corr-5' }]);
  });

  it('a null report header beside errors[] is the mapped Concur error', async () => {
    const { result } = await call('concur_get_report', { reportId: RID }, [
      gqlPartial(reportData({ employee: { userId: SUB, expenseReport: null } }), fieldError(['employee', 'expenseReport'], 'corr-6')),
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/correlationId=corr-6/);
  });

  it('an unknown report is an actionable error', async () => {
    const { result } = await call('concur_get_report', { reportId: RID }, [{ employee: { expenseReport: null } }]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no report with that id[\s\S]*concur_list_reports/);
  });

  it('rejects a report id that is not a plain token', async () => {
    const { result, sent } = await call('concur_get_report', { reportId: '../x' }, []);
    expect(result.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

/** One `timelineSummary` day, in the live shape (verified 2026-10-08). */
const summaryDay = (date: string, items: Array<Record<string, unknown>>) => ({ summaryDate: date, summaryItems: items });
const commentItem = (comment: string, over: Record<string, unknown> = {}) => ({
  id: 'e290d7d9-0000-0000-0000-000000000001',
  action: null,
  authorName: 'Chris Hall',
  createdForEmployeeName: null,
  comment,
  commentSource: null,
  commentType: 'report',
  creationDate: '2026-10-08T18:50:11.580Z',
  expenseType: null,
  isDelegateSubmission: null,
  transactionDate: null,
  transactionAmount: null,
  viewLink: null,
  ...over,
});

const timelineData = (overrides: Record<string, unknown> = {}) => ({
  employee: {
    userId: SUB,
    expenseReport: { reportId: RID, reportDetails: { id: RID, name: 'October travel' } },
  },
  timelineSummary: [
    summaryDay('2026-10-08T18:50:11.580Z', [commentItem('claude raw comment test')]),
    summaryDay('2026-10-06T09:00:00.000Z', [
      commentItem('', {
        id: 'e2',
        comment: null,
        commentType: null,
        action: 'Submitted',
        authorName: 'Ann Lee',
        creationDate: '2026-10-06T09:00:00.000Z',
        expenseType: 'Airfare',
        transactionAmount: { value: 412.5, currencyCode: 'USD' },
      }),
    ]),
  ],
  auditTrails: {
    report: [
      {
        action: 'Submitted',
        date: '2026-10-06',
        description: 'Report submitted',
        authorName: 'Chris Hall',
        author: { fullName: 'Chris Hall' },
        externalUpdate: false,
        auditUpdatedBy: null,
      },
    ],
    expense: [
      { action: 'Changed', date: '2026-10-05', description: 'Amount changed', authorName: 'C. Hall', author: null, externalUpdate: false, auditUpdatedBy: null },
    ],
  },
  ...overrides,
});

describe('concur_get_report_timeline', () => {
  it('reads comments from the top-level timelineSummary, not reportDetails.comments', () => {
    expect(GET_REPORT_TIMELINE).toMatch(/timelineSummary\(userId: \$userId, reportId: \$reportId, contextRole: \$contextRole\)/);
    expect(GET_REPORT_TIMELINE).toContain('summaryItems {');
    expect(GET_REPORT_TIMELINE).not.toMatch(/\bcomments\b/);
    expect(GET_REPORT_TIMELINE).toContain('auditTrails(');
  });

  it('reads the timeline + audit trail and projects them compactly (untrusted)', async () => {
    const { text, sent } = await call('concur_get_report_timeline', { reportId: RID }, [timelineData()]);
    expect(sent[0]!.query).toBe(GET_REPORT_TIMELINE);
    expect(sent[0]!.variables).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER' });
    expect(text).toMatch(/untrusted/i);
    expect(payloadOf(text)).toEqual({
      reportId: RID,
      name: 'October travel',
      timeline: [
        {
          date: '2026-10-08T18:50:11.580Z',
          items: [{ at: '2026-10-08T18:50:11.580Z', by: 'Chris Hall', type: 'report', comment: 'claude raw comment test' }],
        },
        {
          date: '2026-10-06T09:00:00.000Z',
          items: [
            { at: '2026-10-06T09:00:00.000Z', by: 'Ann Lee', action: 'Submitted', expenseType: 'Airfare', amount: '412.5 USD' },
          ],
        },
      ],
      reportAudit: [{ date: '2026-10-06', action: 'Submitted', description: 'Report submitted', by: 'Chris Hall' }],
      expenseAudit: [{ date: '2026-10-05', action: 'Changed', description: 'Amount changed', by: 'C. Hall' }],
    });
  });

  it('tolerates an empty timeline and absent audit trails', async () => {
    const data = timelineData({ timelineSummary: [], auditTrails: null });
    const { text } = await call('concur_get_report_timeline', { reportId: RID }, [data]);
    expect(payloadOf(text)).toEqual({ reportId: RID, name: 'October travel', timeline: [], reportAudit: [], expenseAudit: [] });
  });

  it('tolerates a day with no items', async () => {
    const data = timelineData({ timelineSummary: [{ summaryDate: null, summaryItems: null }] });
    const { text } = await call('concur_get_report_timeline', { reportId: RID }, [data]);
    expect((payloadOf(text) as { timeline: unknown[] }).timeline).toEqual([{ items: [] }]);
  });

  it('a failed timelineSummary is a warning, not a failure', async () => {
    const data = timelineData({ timelineSummary: null });
    const { result, text } = await call('concur_get_report_timeline', { reportId: RID }, [
      gqlPartial(data, fieldError(['timelineSummary'], 'corr-tl')),
    ]);
    expect(result.isError).toBeFalsy();
    const out = payloadOf(text) as { timeline: unknown[]; reportAudit: unknown[]; warnings: Array<{ path: string }> };
    expect(out.timeline).toEqual([]);
    expect(out.reportAudit).toHaveLength(1);
    expect(out.warnings[0]!.path).toBe('timelineSummary');
  });

  it('full keeps the selected shapes', async () => {
    const data = timelineData();
    const { text } = await call('concur_get_report_timeline', { reportId: RID, view: 'full' }, [data]);
    expect(payloadOf(text)).toEqual({
      reportId: RID,
      name: 'October travel',
      timelineSummary: data.timelineSummary,
      auditTrails: data.auditTrails,
    });
  });

  it('full with no timeline gives an empty list', async () => {
    const data = timelineData({ timelineSummary: null });
    const { text } = await call('concur_get_report_timeline', { reportId: RID, view: 'full' }, [data]);
    expect((payloadOf(text) as { timelineSummary: unknown[] }).timelineSummary).toEqual([]);
  });

  it('an unknown report is an actionable error', async () => {
    const { result } = await call('concur_get_report_timeline', { reportId: RID }, [{ employee: null, timelineSummary: null, auditTrails: null }]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no report with that id/);
  });
});
