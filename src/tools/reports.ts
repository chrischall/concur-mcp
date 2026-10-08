// Expense report reads: list, one report (header + entries + exceptions), and
// a report's timeline (comments + workflow events + audit trail).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { IsoDate, McpToolError, UNTRUSTED_DESCRIPTION_SUFFIX, toolAnnotations } from '@chrischall/mcp-utils';
import type { ConcurClient } from '../client.js';
import { GET_REPORT, GET_REPORT_TIMELINE, LIST_REPORTS } from '../graphql/reports.js';
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

/** What a report read cannot do without: a partial answer missing it is an error. */
export const REPORT_ESSENTIAL = { essential: ['employee.expenseReport.reportDetails'] } as const;

export const REPORT_STATUSES = ['ALL', 'ACTIVE', 'UNSUBMITTED', 'SENT_FOR_PAYMENT'] as const;

/** Report ids are 20-char uppercase hex; accept any plain token so a new shape is not refused. */
export const reportIdParam = z
  .string()
  .regex(/^[A-Za-z0-9]{1,64}$/, 'a Concur report id (e.g. 20 hex characters)')
  .describe('Report id (`reportId` from concur_list_reports).');

type Rec = Record<string, unknown>;

interface Pagination {
  number?: number;
  size?: number;
  totalElements?: number;
  totalPages?: number;
}

interface ReportListRow {
  reportId?: string;
  name?: string;
  reportNumber?: string;
  reportDate?: string;
  startDate?: string;
  endDate?: string;
  submitDate?: string | null;
  paidDate?: string | null;
  approvalStatus?: string;
  paymentStatus?: string;
  exceptionLevel?: unknown;
  reportTotal?: Money | null;
  claimedAmount?: Money | null;
  approvedAmount?: Money | null;
  totalAmountDueEmployee?: Money | null;
  approver?: PersonName | null;
  [key: string]: unknown;
}

interface ListReportsData {
  employee: { reportsForUser: { list: ReportListRow[] | null; pagination: Pagination | null } | null } | null;
}

function reportsOf(data: ListReportsData) {
  const page = data.employee?.reportsForUser;
  if (!page) throw new McpToolError('SAP Concur returned no report list for the signed-in user.');
  return { reports: page.list ?? [], pagination: page.pagination };
}

function compactReportRow(r: ReportListRow) {
  return prune({
    reportId: r.reportId,
    name: r.name,
    reportNumber: r.reportNumber,
    reportDate: r.reportDate,
    startDate: r.startDate,
    endDate: r.endDate,
    submitDate: r.submitDate,
    paidDate: r.paidDate,
    approvalStatus: r.approvalStatus,
    paymentStatus: r.paymentStatus,
    exceptionLevel: r.exceptionLevel,
    total: money(r.reportTotal),
    claimed: money(r.claimedAmount),
    approved: money(r.approvedAmount),
    dueEmployee: money(r.totalAmountDueEmployee),
    approver: personName(r.approver),
  });
}

// ── get_report ────────────────────────────────────────────────────────────

export interface EntrySummary {
  id?: string;
  transactionDate?: string | null;
  isPersonalExpense?: boolean | null;
  receiptImageId?: string | null;
  expenseType?: { id?: string; name?: string } | null;
  paymentType?: { id?: string; name?: string } | null;
  vendor?: { description?: string | null; name?: string | null } | null;
  location?: { id?: string | null; name?: string | null } | null;
  transactionAmount?: Money | null;
  postedAmount?: Money | null;
  approvedAmount?: Money | null;
  meta?: Rec | null;
  [key: string]: unknown;
}

interface ConcurException {
  exceptionCode?: string | null;
  expenseId?: string | null;
  isBlocking?: boolean | null;
  message?: string | null;
  parameters?: { missingFields?: { fields?: string[] | null } | null } | null;
  [key: string]: unknown;
}

export interface ReportPageData {
  employee: {
    expenseReport: { reportId?: string; reportDetails: Rec | null } | null;
  } | null;
  reportEntriesDetails: { entries: Array<{ expenseId: string; summary: EntrySummary | null }> | null } | null;
  reportExceptions: {
    countOfExceptions?: number;
    hasBlockingExceptions?: boolean;
    reportExceptions?: ConcurException[] | null;
    entryExceptions?: Array<{ expenseId?: string; entryExceptions?: ConcurException[] | null }> | null;
  } | null;
}

/** The vendor as the UI shows it: `description` is where Concur usually puts it. */
export function vendorOf(summary: EntrySummary): string | undefined {
  return summary.vendor?.description || summary.vendor?.name || undefined;
}

/** One entry, compact: what a person reads off the report's expense list. */
export function compactEntry(expenseId: string | undefined, s: EntrySummary) {
  return prune({
    expenseId,
    date: s.transactionDate,
    expenseType: s.expenseType?.name,
    expenseTypeId: s.expenseType?.id,
    vendor: vendorOf(s),
    paymentType: s.paymentType?.name,
    amount: money(s.transactionAmount),
    posted: money(s.postedAmount),
    approved: money(s.approvedAmount),
    location: s.location?.name,
    personal: s.isPersonalExpense || undefined,
    receiptImageId: s.receiptImageId,
    flags: trueFlags(s.meta),
  });
}

/** An exception, compact: the message, whether it blocks submission, and what is missing. */
export function compactException(e: ConcurException) {
  return prune({
    expenseId: e.expenseId,
    message: e.message,
    blocking: e.isBlocking || undefined,
    code: e.exceptionCode,
    missingFields: e.parameters?.missingFields?.fields ?? undefined,
  });
}

export function requireReport(data: ReportPageData) {
  const report = data.employee?.expenseReport;
  if (!report?.reportDetails) {
    throw new McpToolError('SAP Concur returned no report with that id for the signed-in user.', {
      hint: 'Check the id with concur_list_reports.',
    });
  }
  return { report, details: report.reportDetails };
}

function allExceptions(data: ReportPageData): ConcurException[] {
  const ex = data.reportExceptions;
  return [...(ex?.reportExceptions ?? []), ...(ex?.entryExceptions ?? []).flatMap((e) => e.entryExceptions ?? [])];
}

export function compactReport(data: ReportPageData) {
  const { report, details } = requireReport(data);
  const d = details as Rec & {
    reportTotal?: Money;
    claimedAmount?: Money;
    approvedAmount?: Money;
    employee?: PersonName;
    policy?: { id?: string; expenseListDetailFormId?: string } | null;
    meta?: Rec;
  };
  const entries = (data.reportEntriesDetails?.entries ?? []).map((e) => compactEntry(e.expenseId, e.summary ?? {}));
  const exceptions = allExceptions(data).map(compactException);
  return {
    report: prune({
      reportId: report.reportId,
      name: d.name,
      reportNumber: d.reportNumber,
      owner: personName(d.employee),
      approvalStatus: d.approvalStatus,
      paymentStatus: d.paymentStatus,
      startDate: d.startDate,
      endDate: d.endDate,
      submitDate: d.submitDate,
      currency: d.currencyCode,
      total: money(d.reportTotal),
      claimed: money(d.claimedAmount),
      approved: money(d.approvedAmount),
      policyId: d.policy?.id ?? d.policyId,
      expenseListDetailFormId: d.policy?.expenseListDetailFormId,
      flags: trueFlags(d.meta),
    }),
    entries,
    exceptions,
  };
}

function fullReport(data: ReportPageData) {
  const { report } = requireReport(data);
  return {
    report,
    entries: data.reportEntriesDetails?.entries ?? [],
    exceptions: data.reportExceptions,
  };
}

// ── get_report_timeline ───────────────────────────────────────────────────

interface AuditRow {
  action?: string | null;
  date?: string | null;
  description?: string | null;
  authorName?: string | null;
  author?: { fullName?: string | null } | null;
  [key: string]: unknown;
}

/** One `timelineSummary` item: a comment (`comment` + `commentType`) or a workflow event (`action`). */
export interface TimelineItem {
  id?: string | null;
  action?: string | null;
  authorName?: string | null;
  comment?: string | null;
  commentType?: string | null;
  creationDate?: string | null;
  expenseType?: string | null;
  transactionAmount?: Money | null;
  [key: string]: unknown;
}

/** One day of `timelineSummary`. */
export interface TimelineDay {
  summaryDate?: string | null;
  summaryItems?: TimelineItem[] | null;
}

export interface TimelineData {
  employee: {
    expenseReport: {
      reportId?: string;
      reportDetails: { name?: string } | null;
    } | null;
  } | null;
  /** Non-essential: null (or errored, kept as a warning) reads as an empty timeline. */
  timelineSummary?: TimelineDay[] | null;
  auditTrails: { report?: AuditRow[] | null; expense?: AuditRow[] | null } | null;
}

/** Every timeline item that carries a comment, in timeline order. */
export function timelineComments(days: readonly TimelineDay[] | null | undefined): TimelineItem[] {
  return (days ?? []).flatMap((d) => d.summaryItems ?? []).filter((i) => typeof i.comment === 'string' && i.comment !== '');
}

export function requireTimeline(data: TimelineData) {
  const report = data.employee?.expenseReport;
  if (!report?.reportDetails) {
    throw new McpToolError('SAP Concur returned no report with that id for the signed-in user.', {
      hint: 'Check the id with concur_list_reports.',
    });
  }
  return { report, details: report.reportDetails };
}

const compactAudit = (a: AuditRow) =>
  prune({ date: a.date, action: a.action, description: a.description, by: a.author?.fullName || a.authorName });

const compactTimelineItem = (i: TimelineItem) =>
  prune({
    at: i.creationDate,
    by: i.authorName,
    type: i.commentType,
    action: i.action,
    comment: i.comment,
    expenseType: i.expenseType,
    amount: money(i.transactionAmount),
  });

function compactTimeline(data: TimelineData) {
  const { report, details } = requireTimeline(data);
  return {
    reportId: report.reportId,
    name: details.name,
    timeline: (data.timelineSummary ?? []).map((d) =>
      prune({ date: d.summaryDate, items: (d.summaryItems ?? []).map(compactTimelineItem) }),
    ),
    reportAudit: (data.auditTrails?.report ?? []).map(compactAudit),
    expenseAudit: (data.auditTrails?.expense ?? []).map(compactAudit),
  };
}

function fullTimeline(data: TimelineData) {
  const { report, details } = requireTimeline(data);
  return {
    reportId: report.reportId,
    name: details.name,
    timelineSummary: data.timelineSummary ?? [],
    auditTrails: data.auditTrails,
  };
}

// ── registration ──────────────────────────────────────────────────────────

export function registerReportTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_list_reports',
    {
      description:
        'List your SAP Concur expense reports (name, number, dates, approval and payment status, totals, approver). ' +
        'Filter by status (ALL, ACTIVE, UNSUBMITTED, SENT_FOR_PAYMENT) and an optional report-date range; paged. ' +
        'Use the returned reportId with concur_get_report.',
      annotations: toolAnnotations({ title: 'List Concur expense reports', readOnly: true }),
      inputSchema: z.object({
        status: z.enum(REPORT_STATUSES).default('ALL').describe('Which reports (default ALL).'),
        from: IsoDate.optional().describe('Range start, YYYY-MM-DD (needs `to`).'),
        to: IsoDate.optional().describe('Range end, YYYY-MM-DD (needs `from`).'),
        page: pageParam,
        size: sizeParam,
        view: concurView('compact flattens amounts to "12.5 USD" strings and drops status ids, meta flags and report type.'),
      }),
    },
    async ({ status, from, to, page, size, view }) => {
      if ((from === undefined) !== (to === undefined)) {
        throw new McpToolError('Pass both `from` and `to` for a date range, or neither.');
      }
      const data = await client.spend<ListReportsData>(LIST_REPORTS, {
        userId: await client.userId(),
        contextRole: CONTEXT_ROLE,
        filterByStatus: status,
        dateRange: from && to ? { start: from, end: to } : null,
        paging: { page, size },
      }, { essential: ['employee.reportsForUser'] });
      reportsOf(data); // a missing list is an error, not something to project around
      return respond(
        view,
        data,
        {
          compact: (d) => {
            const { reports, pagination } = reportsOf(d);
            return { reports: reports.map(compactReportRow), pagination };
          },
          full: reportsOf,
        },
        { context: 'GetReportsForUser' },
      );
    },
  );

  server.registerTool(
    'concur_get_report',
    {
      description:
        'Get one SAP Concur expense report: the header (status, totals, policy), every expense entry on it ' +
        '(date, type, vendor, payment type, amounts, receipt, flags) and its exceptions (missing fields, policy ' +
        'violations — `blocking` ones prevent submission). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Concur expense report', readOnly: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        view: concurView(
          'compact flattens amounts, joins the vendor/owner names, lists true meta flags by name and merges report- and entry-level exceptions into one list.',
        ),
      }),
    },
    async ({ reportId, view }) => {
      const data = await client.spend<ReportPageData>(
        GET_REPORT,
        { userId: await client.userId(), reportId, contextRole: CONTEXT_ROLE },
        REPORT_ESSENTIAL,
      );
      requireReport(data);
      return respond(view, data, { compact: compactReport, full: fullReport }, { context: 'GetReportPageData', untrusted: true });
    },
  );

  server.registerTool(
    'concur_get_report_timeline',
    {
      description:
        "Get an SAP Concur report's history: its timeline — the comments on it (yours and approvers') and its " +
        'workflow events (submitted, approved, sent back…), grouped by day — plus its audit trail (who changed ' +
        'what, and when, at report and expense level). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Get a Concur report timeline', readOnly: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        view: concurView(
          'compact gives each timeline item as {at, by, type, action, comment, expenseType, amount} with empty fields dropped, folds audit author objects into a `by` name and drops externalUpdate / auditUpdatedBy.',
        ),
      }),
    },
    async ({ reportId, view }) => {
      const data = await client.spend<TimelineData>(
        GET_REPORT_TIMELINE,
        { userId: await client.userId(), reportId, contextRole: CONTEXT_ROLE },
        REPORT_ESSENTIAL,
      );
      requireTimeline(data);
      return respond(
        view,
        data,
        { compact: compactTimeline, full: fullTimeline },
        { context: 'GetReportTimeline', untrusted: true },
      );
    },
  );
}
