// Attendees: search the attendee directory, and set an expense's attendee list
// (SaveExpenseAttendees — the list REPLACES whatever the expense had). The
// write is confirm-gated and re-reads the expense afterwards.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { warningsField, type ConcurClient } from '../client.js';
import { GET_REPORT_OWNER, SAVE_EXPENSE_ATTENDEES, SEARCH_ATTENDEES } from '../graphql/attendees.js';
import { readExpense } from './expense-writes.js';
import { compactExpense, expenseIdParam, requireExpense, type ExpenseData } from './expenses.js';
import { reportIdParam } from './reports.js';
import { CONTEXT_ROLE, concurView, personName, prune, respond, verify, type PersonName } from './shared.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;

/**
 * The attendee type keys the web app searched on a Group Meals expense
 * (captured live 2026-10-11). Employees come back as `atnTypeCode: "SYSEMP"`.
 * Type keys are tenant/expense-type specific, so callers may override them.
 */
export const DEFAULT_ATTENDEE_TYPE_KEYS = [1, 2001] as const;

const EMPLOYEE_TYPE_CODE = 'SYSEMP';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

// ── shapes ────────────────────────────────────────────────────────────────

export interface CompactAttendee extends PersonName {
  __typename?: string;
  atnKey?: string | null;
  atnTypeKey?: number | null;
  atnTypeId?: string | null;
  atnTypeName?: string | null;
  atnTypeCode?: string | null;
  id?: string | null;
  mi?: string | null;
  company?: string | null;
  emailAddress?: string | null;
  title?: string | null;
  suffix?: string | null;
  isFavorite?: boolean | null;
  versionNumber?: number | null;
}

interface AttendeeGroup {
  __typename?: string;
  id?: string | null;
  name?: string | null;
  category?: string | null;
}

type SearchRow = CompactAttendee & AttendeeGroup;

interface SearchData {
  attendeesByPredictiveSearch: { attendees: SearchRow[] | null } | null;
}

interface OwnerData {
  employee: { expenseReport: { reportDetails: { employee?: PersonName | null } | null } | null } | null;
}

/** A person (not a group) — groups carry no `atnKey`. */
const isPerson = (a: SearchRow): a is CompactAttendee & { atnKey: string } => typeof a.atnKey === 'string' && a.atnKey !== '';

export function compactAttendee(a: CompactAttendee) {
  return prune({
    atnKey: a.atnKey,
    name: personName(a),
    email: a.emailAddress,
    company: a.company,
    title: a.title,
    type: a.atnTypeName,
    typeCode: a.atnTypeCode,
    versionNumber: a.versionNumber,
  });
}

function rowsOf(data: SearchData): SearchRow[] {
  return data.attendeesByPredictiveSearch?.attendees ?? [];
}

// ── split ─────────────────────────────────────────────────────────────────

/** `total` split evenly into `n` 2-decimal shares; the rounding remainder goes on the last one. */
export function splitEvenly(total: number, n: number): number[] {
  const cents = Math.round(total * 100);
  const share = Math.trunc(cents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? cents - share * (n - 1) : share) / 100);
}

// ── reads ─────────────────────────────────────────────────────────────────

const SEARCH_ESSENTIAL = { essential: ['attendeesByPredictiveSearch'] } as const;

async function search(
  client: ConcurClient,
  searchTerms: string,
  typeKeys: readonly number[],
  includeInactive = false,
): Promise<SearchData> {
  return client.spend<SearchData>(
    SEARCH_ATTENDEES,
    { searchTerms, includeInactiveEmp: includeInactive, includeAtnTypeKeys: [...typeKeys], excludeKeys: [] },
    SEARCH_ESSENTIAL,
  );
}

const describeCandidate = (a: CompactAttendee) =>
  [personName(a) ?? '(no name)', a.emailAddress, a.atnTypeName ?? a.atnTypeCode, a.atnKey].filter(Boolean).join(' · ');

/** The one attendee `term` names: an exact email match, else the only result. */
async function resolveTerm(
  client: ConcurClient,
  term: string,
  typeKeys: readonly number[],
): Promise<CompactAttendee & { atnKey: string }> {
  const people = rowsOf(await search(client, term, typeKeys)).filter(isPerson);
  const byEmail = people.filter((a) => norm(a.emailAddress) !== '' && norm(a.emailAddress) === norm(term));
  if (byEmail.length === 1) return byEmail[0]!;
  if (people.length === 1) return people[0]!;
  if (people.length === 0) {
    throw new McpToolError(`No attendee matches "${term}".`, {
      hint: 'Try an email address or a last name with concur_search_attendees.',
    });
  }
  throw new McpToolError(`"${term}" matches ${people.length} attendees — it must name exactly one.`, {
    hint: `Pass the email address of one of: ${people.slice(0, 15).map(describeCandidate).join('; ')}.`,
  });
}

/** The signed-in employee's own attendee record, found by the report owner's name. */
async function resolveMe(
  client: ConcurClient,
  userId: string,
  reportId: string,
  typeKeys: readonly number[],
): Promise<CompactAttendee & { atnKey: string }> {
  const data = await client.spend<OwnerData>(
    GET_REPORT_OWNER,
    { userId, reportId, contextRole: CONTEXT_ROLE },
    { essential: ['employee.expenseReport.reportDetails'] },
  );
  const me = data.employee?.expenseReport?.reportDetails?.employee;
  const hint =
    'Pass includeMe: false and add your own email address to `attendees` (find it with concur_search_attendees).';
  if (!me?.lastName) throw new McpToolError('Could not identify you as an attendee: the report has no owner name.', { hint });
  const firstNames = new Set([norm(me.firstName), norm(me.preferredName)].filter(Boolean));
  const matches = rowsOf(await search(client, me.lastName, typeKeys))
    .filter(isPerson)
    .filter(
      (a) =>
        a.atnTypeCode === EMPLOYEE_TYPE_CODE &&
        norm(a.lastName) === norm(me.lastName) &&
        (firstNames.has(norm(a.firstName)) || firstNames.has(norm(a.preferredName))),
    );
  if (matches.length === 1) return matches[0]!;
  throw new McpToolError(
    `Could not identify you as an attendee: ${matches.length} employee records match "${personName(me)}".`,
    { hint },
  );
}

/** The re-read's attendee view of the expense. */
function attendeeState(data: ExpenseData) {
  const expense = compactExpense(data);
  const { entry } = requireExpense(data);
  const meta = (entry.meta ?? {}) as Record<string, unknown>;
  const n = expense.exceptions.length;
  return {
    attendeeCount: typeof entry.attendeeCount === 'number' ? entry.attendeeCount : undefined,
    hasAttendees: meta.hasAttendees === true,
    exceptions: expense.exceptions,
    ...(n > 0 ? { observedExceptions: `The expense still has ${n} exception(s) — see \`exceptions\`.` } : {}),
    ...warningsField(data),
  };
}

// ── registration ──────────────────────────────────────────────────────────

const attendeeTypeKeysParam = (use = '') =>
  z
    .array(z.number().int())
    .min(1)
    .max(20)
    .optional()
    .describe(
      `Attendee type keys to search (default ${JSON.stringify(DEFAULT_ATTENDEE_TYPE_KEYS)}, what the web app sent for a meal expense). Tenant-specific.${use && ` ${use}`}`,
    );

/** An attendee given exactly, as a concur_search_attendees row names it — no search needed. */
const exactAttendee = z.object({
  atnKey: z.string().trim().min(1).max(200).describe('The `atnKey` concur_search_attendees answered.'),
  typeCode: z.string().trim().min(1).max(40).describe('That row’s `typeCode` (e.g. SYSEMP).'),
  versionNumber: z.number().int().min(0).describe('That row’s `versionNumber`.'),
});

export function registerAttendeeTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_search_attendees',
    {
      description:
        'Search the SAP Concur attendee directory (colleagues and saved business guests) by name or email text, as ' +
        'the expense Attendees dialog does. Answers each person’s attendee key (`atnKey`), name, email, company and ' +
        'attendee type (employees are type code SYSEMP), plus any matching attendee groups. Use it to check who a ' +
        'name or email resolves to before concur_set_attendees. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Search Concur attendees', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100).describe('Name or email text to search for, e.g. "pat.example@example.com" or "Example".'),
        attendeeTypeKeys: attendeeTypeKeysParam(),
        includeInactive: z.boolean().default(false).describe('Include inactive employees (default false).'),
        view: concurView('compact keeps key, name, email, company, title and type; full adds ids, middle initial, suffix and favorite.'),
      }),
    },
    async ({ query, attendeeTypeKeys, includeInactive, view }) => {
      const data = await search(client, query, attendeeTypeKeys ?? DEFAULT_ATTENDEE_TYPE_KEYS, includeInactive);
      return respond(
        view,
        data,
        {
          compact: (d) => {
            const rows = rowsOf(d);
            const groups = rows.filter((a) => !isPerson(a)).map((g) => prune({ id: g.id, name: g.name, category: g.category }));
            return { attendees: rows.filter(isPerson).map(compactAttendee), ...(groups.length > 0 ? { groups } : {}) };
          },
          full: (d) => ({ attendees: rowsOf(d).filter(isPerson), groups: rowsOf(d).filter((a) => !isPerson(a)) }),
        },
        { context: 'GetAttendeesByPredictiveSearch', untrusted: true },
      );
    },
  );

  server.registerTool(
    'concur_set_attendees',
    {
      description:
        'Set the attendees on an expense in an unsubmitted SAP Concur report (e.g. a group meal). This REPLACES the ' +
        'expense’s whole attendee list. Each entry of `attendees` is an email address or name that must resolve to ' +
        'exactly one person (an exact email match wins; otherwise the candidates are listed), or an exact ' +
        '{atnKey, typeCode, versionNumber} copied from a concur_search_attendees row (used as given, no search). ' +
        'Names are searched with attendeeTypeKeys (same default as concur_search_attendees). With includeMe ' +
        '(default true) you are added first. The expense amount is split evenly across everyone (to the cent, the ' +
        'remainder on the last person). The preview lists each attendee and amount; afterwards the expense is ' +
        're-read for its attendee count and any remaining exceptions. ' +
        GATE,
      annotations: toolAnnotations({ title: 'Set Concur expense attendees', readOnly: false, destructive: true, openWorld: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        expenseId: expenseIdParam,
        attendees: z
          .array(z.union([z.string().trim().min(1).max(100), exactAttendee]))
          .max(50)
          .describe(
            'One per attendee, NOT including yourself when includeMe is true: an email address (preferred) or name, or ' +
              'an exact {atnKey, typeCode, versionNumber} from concur_search_attendees.',
          ),
        includeMe: z.boolean().default(true).describe('Put the signed-in employee first on the list (default true).'),
        attendeeTypeKeys: attendeeTypeKeysParam('Used for every name/email lookup, including finding you.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ reportId, expenseId, attendees, includeMe, attendeeTypeKeys, confirmToken }, ctx) => {
      if (attendees.length === 0 && !includeMe) {
        throw new McpToolError('An expense needs at least one attendee.', {
          hint: 'Name someone in `attendees`, or leave includeMe true.',
        });
      }
      const userId = await client.userId();
      const data = await readExpense(client, userId, reportId, expenseId);
      const before = compactExpense(data);
      const { entry } = requireExpense(data);
      const total = entry.transactionAmount as { value?: number | null; currencyCode?: string | null } | null | undefined;
      if (typeof total?.value !== 'number') {
        throw new McpToolError('This expense has no transaction amount to split across attendees.', {
          hint: 'Set its amount first with concur_update_expense.',
        });
      }
      const currency = total.currencyCode ?? '';

      // Resolve everyone (me first), dropping repeats of the same attendee.
      const chosen: Array<CompactAttendee & { atnKey: string; me?: true }> = [];
      const add = (a: CompactAttendee & { atnKey: string }, me = false) => {
        if (!chosen.some((c) => c.atnKey === a.atnKey)) chosen.push(me ? { ...a, me: true } : a);
      };
      const typeKeys = attendeeTypeKeys ?? DEFAULT_ATTENDEE_TYPE_KEYS;
      if (includeMe) add(await resolveMe(client, userId, reportId, typeKeys), true);
      for (const term of attendees) {
        add(
          typeof term === 'string'
            ? await resolveTerm(client, term, typeKeys)
            : { atnKey: term.atnKey, atnTypeCode: term.typeCode, versionNumber: term.versionNumber },
        );
      }

      const shares = splitEvenly(total.value, chosen.length);
      const rows = chosen.map((a, i) => ({
        atnKey: a.atnKey,
        atnTypeCode: a.atnTypeCode ?? EMPLOYEE_TYPE_CODE,
        versionNumber: a.versionNumber ?? 1,
        instanceCount: 1,
        isAmtEdited: 'N',
        transactionAmount: shares[i]!,
      }));
      const variables = { userId, contextRole: CONTEXT_ROLE, params: { reportId, entryId: expenseId, attendees: rows } };
      const show = (n: number) => (currency ? `${n} ${currency}` : String(n));

      const gate = await confirmWrite(ctx, {
        tool: 'concur_set_attendees',
        action: 'concur.expense.attendees.set',
        summary:
          `REPLACES the attendee list of expense ${expenseId} (${String(before.expense.expenseType ?? 'expense')}, ` +
          `${show(total.value)}) with ${rows.length} attendee(s), the amount split evenly`,
        account: userId,
        target: expenseId,
        payload: variables,
        preview: {
          expense: prune({
            expenseId,
            date: before.expense.date,
            expenseType: before.expense.expenseType,
            vendor: before.expense.vendor,
            amount: before.expense.amount,
          }),
          currentAttendeeCount: typeof entry.attendeeCount === 'number' ? entry.attendeeCount : undefined,
          attendees: chosen.map((a, i) =>
            prune({
              name: personName(a),
              email: a.emailAddress,
              typeCode: a.atnTypeCode,
              atnKey: a.atnKey,
              amount: show(shares[i]!),
              me: a.me,
            }),
          ),
        },
        confirmToken,
      });
      if (gate) return gate;

      const res = await client.spend<{ employee: { saveAttendeesLegacy: { status?: string | null } | null } | null }>(
        SAVE_EXPENSE_ATTENDEES,
        variables,
      );
      const status = res.employee?.saveAttendeesLegacy?.status;
      if (typeof status !== 'string' || !/^success/i.test(status.trim())) {
        throw new McpToolError(`SAP Concur did not confirm saving the attendees (status: ${JSON.stringify(status ?? null)}).`, {
          hint: 'Re-read the expense with concur_get_expense to see what actually changed before retrying.',
        });
      }
      return untrustedResult({
        saved: true,
        reportId,
        expenseId,
        attendeeKeys: rows.map((r) => r.atnKey),
        response: res.employee?.saveAttendeesLegacy,
        ...warningsField(res),
        ...(await verify(async () => attendeeState(await readExpense(client, userId, reportId, expenseId)))),
      });
    },
  );
}
