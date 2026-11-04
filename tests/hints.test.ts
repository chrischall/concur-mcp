/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off what a host sees: the served `tools/list`. Every tool except the
 * mcp-utils healthcheck carries `domain: 'work'` and an intent; the canonical
 * reads answer `view: 'brief'` one line per item.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { ConcurClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/index.js';
import { briefAvailable, registerExpenseTools } from '../src/tools/expenses.js';
import { briefLine, errorNotes, oneLine } from '../src/tools/hints.js';
import { briefTrip, registerTravelTools } from '../src/tools/travel.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload } from './helpers.js';

type Mint = {
  domain?: string;
  intent?: string;
  canonical?: boolean;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
};
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Mint };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  concur_whoami: 'lookup',
  concur_list_expense_types: 'lookup',
  concur_list_payment_types: 'lookup',
  concur_list_currencies: 'lookup',
  concur_search_locations: 'lookup',
  concur_list_reports: 'lookup',
  concur_get_report: 'lookup',
  concur_get_report_timeline: 'lookup',
  concur_get_expense: 'lookup',
  concur_list_available_expenses: 'whats-due',
  concur_create_report: 'change',
  concur_update_report: 'change',
  concur_delete_report: 'change',
  concur_add_report_comment: 'send',
  concur_submit_report: 'send',
  concur_recall_report: 'change',
  concur_create_expense: 'change',
  concur_update_expense: 'change',
  concur_delete_expenses: 'change',
  concur_copy_expense: 'change',
  concur_move_available_expenses_to_report: 'change',
  concur_delete_available_expenses: 'change',
  concur_search_attendees: 'lookup',
  concur_set_attendees: 'change',
  concur_list_available_receipts: 'lookup',
  concur_get_receipt: 'lookup',
  concur_upload_receipt: 'change',
  concur_attach_receipt: 'change',
  concur_append_receipt: 'change',
  concur_detach_receipt: 'change',
  concur_delete_receipt: 'change',
  concur_add_missing_receipt_declaration: 'change',
  concur_list_trips: 'whats-on',
  concur_get_trip: 'lookup',
  concur_get_trip_history: 'lookup',
  concur_send_itinerary: 'send',
  concur_graphql_query: 'other',
  concur_graphql_mutation: 'other',
  concur_list_operations: 'lookup',
};

async function served(): Promise<Listed[]> {
  const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT: 'unused' }) });
  const harness = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
  const { tools } = await harness.client.listTools();
  await harness.close?.();
  return tools as Listed[];
}

const hinted = async () => (await served()).filter((t) => t.name !== 'concur_healthcheck');

describe('_meta.mint on every served tool', () => {
  it('names every served tool, so a new tool cannot skip the decision', async () => {
    expect((await hinted()).map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves only the mcp-utils healthcheck unhinted', async () => {
    const unhinted = (await served()).filter((t) => !t._meta?.mint).map((t) => t.name);
    expect(unhinted).toEqual(['concur_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the work domain with intent %s', async (name, intent) => {
    const mint = (await hinted()).find((t) => t.name === name)?._meta?.mint;
    expect(mint?.domain).toBe('work');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await hinted()) {
      const m = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) expect(m.canonical, t.name).toBe(true);
      if (m.subject !== undefined) expect(props, t.name).toHaveProperty(m.subject);
      if (m.when !== undefined) {
        expect(Object.keys(m.when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(m.when.start);
        expect(props, t.name).toHaveProperty(m.when.end);
      }
      if (m.aliases !== undefined) {
        expect(m.aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of m.aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^concur_/); // words a person says, not tool names
        }
      }
    }
  });

  it('is canonical only on read-only whats-new/due/on reads, at most one per intent', async () => {
    const canonical = (await hinted()).filter((t) => t._meta!.mint!.canonical === true);
    for (const t of canonical) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
    }
    const intents = canonical.map((t) => t._meta!.mint!.intent);
    expect(new Set(intents).size).toBe(intents.length);
    expect(canonical.map((t) => [t.name, t._meta!.mint!.intent]).sort()).toEqual([
      ['concur_list_available_expenses', 'whats-due'],
      ['concur_list_trips', 'whats-on'],
    ]);
  });

  it('declares no subject anywhere: the signed-in user is the only subject Concur has', async () => {
    expect((await hinted()).filter((t) => t._meta!.mint!.subject !== undefined).map((t) => t.name)).toEqual([]);
  });

  it('the trips read names its range arguments; available expenses take no range', async () => {
    const tools = await hinted();
    expect(tools.find((t) => t.name === 'concur_list_trips')?._meta?.mint).toEqual({
      domain: 'work',
      intent: 'whats-on',
      canonical: true,
      when: { start: 'from', end: 'to' },
      aliases: ['trip', 'trips', 'travel', 'business trip', 'flight', 'hotel', 'itinerary'],
    });
    expect(tools.find((t) => t.name === 'concur_list_available_expenses')?._meta?.mint).toEqual({
      domain: 'work',
      intent: 'whats-due',
      canonical: true,
      aliases: ['expenses', 'receipts', 'card charges', 'expense report', 'reimbursement', 'concur'],
    });
  });

  it('every canonical read offers view: brief', async () => {
    for (const t of (await hinted()).filter((x) => x._meta!.mint!.canonical === true)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

// ── brief views ─────────────────────────────────────────────────────────────

const BRIEF_LINE = /^.+ — (\d{4}-\d{2}-\d{2}\S*|no date) — \S.*$/;
let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const usd = (value: number) => ({ value, currencyCode: 'USD' });

/** A brief answer's lines, after checking it is the minified untrusted-data envelope. */
function briefOf(result: unknown): { note: string; lines: string[] } {
  const text = textOf(result);
  expect(text).toBe(JSON.stringify(JSON.parse(text))); // minified
  const parsed = JSON.parse(text) as { note: string };
  expect(Object.keys(parsed)).toEqual(['untrusted_content', 'note', 'data']); // the marker and note come first
  const { data } = untrustedPayload(text) as { data: unknown };
  expect(Array.isArray(data)).toBe(true);
  return { note: parsed.note, lines: data as string[] };
}

const available = (availableExpenses: unknown[], pagination: unknown) => ({
  employee: { userId: SUB, availableExpensesWithPagination: { availableExpenses, pagination } },
});
const trips = (list: unknown) => ({ travel: { trips: { list } } });

describe('concur_list_available_expenses view: brief', () => {
  it('answers one line per expense: title — date — status, each ≤ 120 chars', async () => {
    const t = await toolHarness(registerExpenseTools, [
      {
        employee: {
          userId: SUB,
          availableExpensesWithPagination: {
            availableExpenses: [
              { id: 'AV1', transactionDate: '2026-10-04', vendor: 'Coffee Co', transactionAmount: usd(4.5), meta: { missingData: [] } },
              { id: 'AV2', transactionDate: null, vendor: null, receiptImageId: 'IMG2', meta: { missingData: ['vendor'] } },
              { id: 'AV3', transactionDate: '2026-10-05', vendor: `A\nvery ${'long '.repeat(40)}vendor`, expenseType: { name: 'Taxi' } },
            ],
            pagination: { number: 1, size: 50, totalElements: 3, totalPages: 1 },
          },
        },
      },
    ]);
    harness = t.harness;
    const result = await harness.callTool('concur_list_available_expenses', { view: 'brief' });
    const { note, lines } = briefOf(result);
    expect(note).toMatch(/merchants/);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Coffee Co (4.5 USD) — 2026-10-04 — not on a report');
    expect(lines[1]).toBe('(receipt being read) — no date — receipt being read');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(BRIEF_LINE);
    }
    expect(lines[2]).toMatch(/^A very long/);
  });

  it('answers an empty list as the single note line `-- none`', async () => {
    const t = await toolHarness(registerExpenseTools, [
      { employee: { availableExpensesWithPagination: { availableExpenses: [], pagination: null } } },
    ]);
    harness = t.harness;
    expect(briefOf(await harness.callTool('concur_list_available_expenses', { view: 'brief' })).lines).toEqual(['-- none']);
  });

  it('says how many of the total a partial page shows', async () => {
    const row = { transactionDate: '2026-10-04', vendor: 'Cab', transactionAmount: usd(9) };
    const t = await toolHarness(registerExpenseTools, [
      available([row, row], { number: 1, size: 2, totalElements: 5, totalPages: 3 }),
      available([row], { number: 3, size: 2, totalElements: 5, totalPages: 3 }),
      available([row, row], { number: 1, size: 2, totalPages: 3 }),
      available([row], { number: 1, size: 2, totalPages: 1 }),
    ]);
    harness = t.harness;
    const call = (page: number) =>
      harness!.callTool('concur_list_available_expenses', { view: 'brief', page, size: 2 }).then((r) => briefOf(r).lines);
    expect(await call(1)).toEqual(['Cab (9 USD) — 2026-10-04 — not on a report', 'Cab (9 USD) — 2026-10-04 — not on a report', '-- 2 of 5 shown']);
    expect(await call(3)).toEqual(['Cab (9 USD) — 2026-10-04 — not on a report']); // the last page: nothing more
    expect(await call(1)).toEqual([
      'Cab (9 USD) — 2026-10-04 — not on a report',
      'Cab (9 USD) — 2026-10-04 — not on a report',
      '-- more',
    ]); // no total, but more pages
    expect(await call(1)).toEqual(['Cab (9 USD) — 2026-10-04 — not on a report']);
  });

  it("carries Concur's partial errors as `-- error:` notes rather than dropping them", async () => {
    const t = await toolHarness(registerExpenseTools, [
      gqlPartial(
        available([], null),
        fieldError(['employee', 'availableExpensesWithPagination', 'availableExpenses', 0, 'location']),
      ),
    ]);
    harness = t.harness;
    const { lines } = briefOf(await harness.callTool('concur_list_available_expenses', { view: 'brief' }));
    expect(lines[0]).toBe('-- none');
    expect(lines[1]).toMatch(/^-- error: Concur could not read employee\.availableExpensesWithPagination\.availableExpenses\.0\.location/);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });
});

describe('concur_list_trips view: brief', () => {
  it('answers one line per trip: name — start date — status', async () => {
    const t = await toolHarness(registerTravelTools, [
      {
        travel: {
          trips: {
            list: {
              meta: { nextToken: null },
              trips: [
                { id: 'T1', name: 'Client visit', startDate: '2026-11-10', endDate: '2026-11-12', displayStatus: 'Confirmed' },
                { id: 'T2', name: null, recordLocator: 'ABC123', startDate: null, status: 'HELD' },
                { id: 'T3' },
              ],
            },
          },
        },
      },
    ]);
    harness = t.harness;
    const result = await harness.callTool('concur_list_trips', { view: 'brief', from: '2026-11-01', to: '2026-11-30' });
    const { note, lines } = briefOf(result);
    expect(note).toMatch(/Trip names/);
    expect(lines).toEqual([
      'Client visit — 2026-11-10 — Confirmed',
      'ABC123 — no date — HELD',
      '(unnamed trip) — no date — no status',
    ]);
    expect(t.sent[0]!.variables.filter).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-30' });
    for (const line of lines) expect(line).toMatch(BRIEF_LINE);
  });

  it('says `-- more` when Concur hands back a next-page token', async () => {
    const t = await toolHarness(registerTravelTools, [
      trips({ meta: { nextToken: 'tok' }, trips: [{ name: 'Offsite', startDate: '2026-11-10', status: 'CONFIRMED' }] }),
    ]);
    harness = t.harness;
    expect(briefOf(await harness.callTool('concur_list_trips', { view: 'brief' })).lines).toEqual([
      'Offsite — 2026-11-10 — CONFIRMED',
      '-- more',
    ]);
  });

  it("carries Concur's partial errors as `-- error:` notes", async () => {
    const t = await toolHarness(registerTravelTools, [
      gqlPartial(
        trips({ meta: null, trips: [{ name: 'Offsite', startDate: '2026-11-10', status: 'CONFIRMED' }] }),
        { message: 'x'.repeat(300), path: ['travel', 'trips', 'list', 'trips', 0, 'bookings'] },
      ),
    ]);
    harness = t.harness;
    const { lines } = briefOf(await harness.callTool('concur_list_trips', { view: 'brief' }));
    expect(lines[0]).toBe('Offsite — 2026-11-10 — CONFIRMED');
    expect(lines[1]).toMatch(/^-- error: Concur could not read travel\.trips\.list\.trips\.0\.bookings: x+…$/);
    expect(lines[1]!.length).toBeLessThanOrEqual(120);
  });
});

describe('brief line helpers', () => {
  it('escapes a title that would read as a note, or that starts with a backslash, with one backslash', () => {
    expect(briefLine('-- none', '2026-11-04', 'CONFIRMED')).toBe('\\-- none — 2026-11-04 — CONFIRMED');
    expect(briefLine('\\x', 'no date', 'HELD')).toBe('\\\\x — no date — HELD');
    expect(briefLine('--none', 'no date', 'HELD')).toBe('--none — no date — HELD');
    expect(briefAvailable({ vendor: '-- more' })).toBe('\\-- more — no date — not on a report');
  });

  it('an error note says so even when Concur names no path or reason', () => {
    expect(errorNotes([{ path: '', message: ' ' }])).toEqual([
      '-- error: Concur could not read part of the answer: no reason given',
    ]);
    expect(errorNotes([])).toEqual([]);
  });

  it('an escaped long title is still cut to 120 as a whole line', () => {
    const line = briefLine(`-- ${'y'.repeat(200)}`, '2026-11-04', 'not on a report');
    expect(line).toHaveLength(120);
    expect(line.startsWith('\\-- y')).toBe(true);
    expect(line.endsWith('… — 2026-11-04 — not on a report')).toBe(true);
  });

  it('oneLine folds control characters and whitespace, and treats blank as absent', () => {
    expect(oneLine('a\n\tb\u2028c')).toBe('a b c');
    expect(oneLine('  ')).toBeUndefined();
    expect(oneLine(null)).toBeUndefined();
  });

  it('briefLine shortens the title, never the date or status', () => {
    const line = briefLine('x'.repeat(200), '2026-11-04', 'not on a report');
    expect(line).toHaveLength(120);
    expect(line.endsWith('… — 2026-11-04 — not on a report')).toBe(true);
  });

  it('an available expense falls back to its type, then a placeholder, and to the posted or estimated amount', () => {
    expect(briefAvailable({ vendor: ' ', expenseType: { name: 'Taxi' }, postedAmount: usd(12) })).toBe(
      'Taxi (12 USD) — no date — not on a report',
    );
    expect(briefAvailable({ estimatedAmount: usd(3) })).toBe('(unnamed expense) (3 USD) — no date — not on a report');
    expect(briefAvailable({})).toBe('(unnamed expense) — no date — not on a report');
  });

  it('a trip falls back to its record locator, then a placeholder', () => {
    expect(briefTrip({ recordLocator: 'XYZ9', startDate: '2026-12-01', status: 'CONFIRMED' })).toBe(
      'XYZ9 — 2026-12-01 — CONFIRMED',
    );
  });
});

describe('concur_list_trips view: brief with no trips', () => {
  it('answers a list that carries no trips array as the single note line `-- none`', async () => {
    const t = await toolHarness(registerTravelTools, [{ travel: { trips: { list: { meta: null, trips: null } } } }]);
    harness = t.harness;
    expect(briefOf(await harness.callTool('concur_list_trips', { view: 'brief' })).lines).toEqual(['-- none']);
  });
});
