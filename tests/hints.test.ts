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
import { briefLine, oneLine } from '../src/tools/hints.js';
import { briefTrip, registerTravelTools } from '../src/tools/travel.js';
import { SUB, textOf, toolHarness } from './helpers.js';

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
    const lines = textOf(result).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Coffee Co (4.5 USD) — 2026-10-04 — not on a report');
    expect(lines[1]).toBe('(receipt being read) — no date — receipt being read');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(BRIEF_LINE);
    }
    expect(lines[2]).toMatch(/^A very long/);
  });

  it('answers an empty list as no lines', async () => {
    const t = await toolHarness(registerExpenseTools, [
      { employee: { availableExpensesWithPagination: { availableExpenses: [], pagination: null } } },
    ]);
    harness = t.harness;
    expect(textOf(await harness.callTool('concur_list_available_expenses', { view: 'brief' }))).toBe('');
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
    const lines = textOf(result).split('\n');
    expect(lines).toEqual([
      'Client visit — 2026-11-10 — Confirmed',
      'ABC123 — no date — HELD',
      '(unnamed trip) — no date — no status',
    ]);
    expect(t.sent[0]!.variables.filter).toMatchObject({ fromDate: '2026-11-01', toDate: '2026-11-30' });
    for (const line of lines) expect(line).toMatch(BRIEF_LINE);
  });
});

describe('brief line helpers', () => {
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
  it('answers a list that carries no trips array as no lines', async () => {
    const t = await toolHarness(registerTravelTools, [{ travel: { trips: { list: { meta: null, trips: null } } } }]);
    harness = t.harness;
    expect(textOf(await harness.callTool('concur_list_trips', { view: 'brief' }))).toBe('');
  });
});
