import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { GET_REPORT_OWNER, SAVE_EXPENSE_ATTENDEES, SEARCH_ATTENDEES } from '../src/graphql/attendees.js';
import { GET_EXPENSE } from '../src/graphql/expenses.js';
import { registerAttendeeTools, splitEvenly } from '../src/tools/attendees.js';
import { SUB, fieldError, textOf, toolHarness, untrustedPayload } from './helpers.js';

// Invented people and keys only — never a real name, email or atnKey.

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
  preview: Record<string, unknown> & { action: string };
}

const isMutation = (q: string) => /^\s*mutation\b/.test(q);

async function call(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerAttendeeTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent };
}

async function confirmed(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerAttendeeTools, script);
  harness = t.harness;
  const first = parseToolResult<Preview>(await t.harness.callTool(name, args));
  expect(first.status).toBe('confirmation-required');
  expect(t.sent.filter((s) => isMutation(s.query))).toEqual([]);
  const phase1 = t.sent.length;
  const result = await t.harness.callTool(name, { ...args, confirmToken: first.confirmToken });
  return { preview: first, result, text: textOf(result), sent: t.sent.slice(phase1), phase1: t.sent.slice(0, phase1) };
}

// ── fixtures ──────────────────────────────────────────────────────────────

const person = (key: string, first: string, last: string, email: string, over: Record<string, unknown> = {}) => ({
  __typename: 'CompactAttendee',
  atnKey: key,
  atnTypeKey: 1,
  atnTypeId: 'SYSEMP',
  atnTypeName: 'Employee',
  atnTypeCode: 'SYSEMP',
  id: `id-${key}`,
  firstName: first,
  lastName: last,
  mi: null,
  preferredName: null,
  emailAddress: email,
  company: 'Example Co',
  title: null,
  suffix: null,
  isFavorite: false,
  versionNumber: 1,
  ...over,
});

const ME = person('frTESTKEYME==', 'Sam', 'Sample', 'sam.sample@example.com');
const PAT = person('frTESTKEYPAT==', 'Pat', 'Example', 'pat.example@example.com');
const PAT2 = person('frTESTKEYPAT2==', 'Patricia', 'Example', 'patricia.example@example.com');
const LEE = person('frTESTKEYLEE==', 'Lee', 'Placeholder', 'lee.placeholder@example.com', { versionNumber: 3 });
const GROUP = { __typename: 'AttendeeGroup', id: 'GRP1', name: 'Example team', category: 'TEAM' };

const found = (...attendees: unknown[]) => ({ attendeesByPredictiveSearch: { attendees } });

const owner = (first = 'Sam', last = 'Sample', preferred: string | null = null) => ({
  employee: {
    userId: SUB,
    expenseReport: { reportId: RID, reportDetails: { id: RID, employee: { firstName: first, lastName: last, preferredName: preferred } } },
  },
});

const expense = (value: number, over: Record<string, unknown> = {}, exceptions: unknown[] = []) => ({
  entryExceptions: { entryExceptions: exceptions, itemizationsExceptions: [] },
  employee: {
    userId: SUB,
    expenseReport: {
      reportId: RID,
      reportDetails: { id: RID, name: 'October travel', currencyCode: 'USD', policy: { id: 'POL1', expenseListDetailFormId: 'FORM1' } },
      entry: {
        id: E1,
        transactionDate: '2026-10-02',
        expenseType: { id: 'GRPML', name: 'Group Meals' },
        vendor: { description: 'Example Bistro' },
        transactionAmount: { value, currencyCode: 'USD' },
        attendeeCount: 0,
        meta: { hasAttendees: false, hasExceptions: true },
        ...over,
      },
    },
  },
  existingExpenseForm: { expenseTypeId: 'GRPML', mainForm: { isFormEditable: true, fields: [] } },
});

const GROUP_MEAL_EXCEPTION = { exceptionCode: 'ATTN', expenseId: E1, isBlocking: true, message: 'Group meals need attendees.' };

const saved = (status: unknown = 'SUCCESS!') => ({ employee: { saveAttendeesLegacy: { status } } });

const failedReRead = () =>
  new Response(JSON.stringify({ data: null, errors: [fieldError(['employee', 'expenseReport'], 'corr-reread')] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ── split ─────────────────────────────────────────────────────────────────

describe('splitEvenly', () => {
  it('splits to the cent with the remainder on the last row (the captured 77.83 → 38.91 + 38.92)', () => {
    expect(splitEvenly(77.83, 2)).toEqual([38.91, 38.92]);
    expect(splitEvenly(100, 3)).toEqual([33.33, 33.33, 33.34]);
    expect(splitEvenly(10, 1)).toEqual([10]);
    expect(splitEvenly(0.1, 4)).toEqual([0.02, 0.02, 0.02, 0.04]);
  });
});

// ── search ────────────────────────────────────────────────────────────────

describe('concur_search_attendees', () => {
  it('is a read-only tool', async () => {
    const t = await toolHarness(registerAttendeeTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const search = tools.find((x) => x.name === 'concur_search_attendees')!;
    expect(search.annotations?.readOnlyHint).toBe(true);
  });

  it('sends the web app variables and answers compact, untrusted-framed attendees and groups', async () => {
    const { text, sent } = await call('concur_search_attendees', { query: 'Example' }, [found(PAT, PAT2, GROUP)]);
    expect(sent.map((s) => s.query)).toEqual([SEARCH_ATTENDEES]);
    expect(sent[0]!.variables).toEqual({
      searchTerms: 'Example',
      includeInactiveEmp: false,
      includeAtnTypeKeys: [1, 2001],
      excludeKeys: [],
    });
    const out = untrustedPayload(text);
    expect(out.attendees).toEqual([
      {
        atnKey: 'frTESTKEYPAT==',
        name: 'Pat Example',
        email: 'pat.example@example.com',
        company: 'Example Co',
        type: 'Employee',
        typeCode: 'SYSEMP',
        versionNumber: 1,
      },
      {
        atnKey: 'frTESTKEYPAT2==',
        name: 'Patricia Example',
        email: 'patricia.example@example.com',
        company: 'Example Co',
        type: 'Employee',
        typeCode: 'SYSEMP',
        versionNumber: 1,
      },
    ]);
    expect(out.groups).toEqual([{ id: 'GRP1', name: 'Example team', category: 'TEAM' }]);
  });

  it('passes attendee type keys and inactive-employee choice through', async () => {
    const { sent } = await call('concur_search_attendees', { query: 'pat', attendeeTypeKeys: [1], includeInactive: true }, [found()]);
    expect(sent[0]!.variables).toMatchObject({ includeInactiveEmp: true, includeAtnTypeKeys: [1] });
  });

  it('answers no attendees when the search returns a null list', async () => {
    const { text } = await call('concur_search_attendees', { query: 'pat' }, [{ attendeesByPredictiveSearch: { attendees: null } }]);
    expect(untrustedPayload(text)).toMatchObject({ attendees: [] });
    expect(untrustedPayload(text).groups).toBeUndefined();
  });

  it('full keeps every selected field', async () => {
    const { text } = await call('concur_search_attendees', { query: 'pat', view: 'full' }, [found(PAT)]);
    expect(untrustedPayload(text).attendees).toEqual([PAT]);
  });
});

// ── set ───────────────────────────────────────────────────────────────────

describe('concur_set_attendees', () => {
  it('is a confirm-gated write, destructive (it replaces a list no tool can read back)', async () => {
    const t = await toolHarness(registerAttendeeTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const set = tools.find((x) => x.name === 'concur_set_attendees')!;
    expect(set.annotations?.readOnlyHint).toBe(false);
    expect(set.annotations?.destructiveHint).toBe(true);
    expect(Object.keys((set.inputSchema as { properties: object }).properties)).toContain('confirmToken');
    expect(set.description).toMatch(/confirmToken/);
    expect(set.description).toMatch(/REPLACES/);
  });

  // Per phase: expense, report owner, search me, search each term.
  const reads = [expense(77.83), owner(), found(ME), found(PAT, PAT2)];

  it('resolves me + an email, splits the amount, saves, and re-reads (the captured shape)', async () => {
    const after = expense(77.83, { attendeeCount: 2, meta: { hasAttendees: true, hasExceptions: false } });
    const { preview: p, phase1, sent, text } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: ['pat.example@example.com'] },
      [...reads, ...reads, saved(), after],
    );
    expect(phase1.map((s) => s.query)).toEqual([GET_EXPENSE, GET_REPORT_OWNER, SEARCH_ATTENDEES, SEARCH_ATTENDEES]);
    expect(phase1[2]!.variables).toMatchObject({ searchTerms: 'Sample' });
    expect(phase1[3]!.variables).toMatchObject({ searchTerms: 'pat.example@example.com' });

    expect(p.preview.action).toMatch(/REPLACES/);
    expect(p.preview.attendees).toEqual([
      { name: 'Sam Sample', email: 'sam.sample@example.com', typeCode: 'SYSEMP', atnKey: 'frTESTKEYME==', amount: '38.91 USD', me: true },
      { name: 'Pat Example', email: 'pat.example@example.com', typeCode: 'SYSEMP', atnKey: 'frTESTKEYPAT==', amount: '38.92 USD' },
    ]);
    expect(p.preview.expense).toMatchObject({ expenseId: E1, expenseType: 'Group Meals', amount: '77.83 USD' });
    expect(p.preview.currentAttendeeCount).toBe(0);

    expect(sent.map((s) => s.query)).toEqual([GET_EXPENSE, GET_REPORT_OWNER, SEARCH_ATTENDEES, SEARCH_ATTENDEES, SAVE_EXPENSE_ATTENDEES, GET_EXPENSE]);
    expect(sent[4]!.variables).toEqual({
      userId: SUB,
      contextRole: 'TRAVELER',
      params: {
        reportId: RID,
        entryId: E1,
        attendees: [
          { atnKey: 'frTESTKEYME==', atnTypeCode: 'SYSEMP', versionNumber: 1, instanceCount: 1, isAmtEdited: 'N', transactionAmount: 38.91 },
          { atnKey: 'frTESTKEYPAT==', atnTypeCode: 'SYSEMP', versionNumber: 1, instanceCount: 1, isAmtEdited: 'N', transactionAmount: 38.92 },
        ],
      },
    });
    const out = untrustedPayload(text);
    expect(out).toMatchObject({
      saved: true,
      reportId: RID,
      expenseId: E1,
      attendeeKeys: ['frTESTKEYME==', 'frTESTKEYPAT=='],
      response: { status: 'SUCCESS!' },
      verified: { attendeeCount: 2, hasAttendees: true, exceptions: [] },
    });
  });

  it('includeMe: false sends only the named attendees, the whole amount split among them', async () => {
    const r = [expense(30), found(PAT), found(LEE)];
    const { sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: ['pat.example@example.com', 'Placeholder'], includeMe: false },
      [...r, ...r, saved(), expense(30, { attendeeCount: 2 })],
    );
    expect(sent.map((s) => s.query)).not.toContain(GET_REPORT_OWNER);
    const params = sent.find((s) => s.query === SAVE_EXPENSE_ATTENDEES)!.variables.params as { attendees: Array<Record<string, unknown>> };
    expect(params.attendees.map((a) => [a.atnKey, a.transactionAmount, a.versionNumber])).toEqual([
      ['frTESTKEYPAT==', 15, 1],
      ['frTESTKEYLEE==', 15, 3],
    ]);
  });

  it('does not list me twice when I am also named', async () => {
    const r = [expense(20), owner(), found(ME), found(ME)];
    const { sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: ['sam.sample@example.com'] },
      [...r, ...r, saved(), expense(20)],
    );
    const params = sent.find((s) => s.query === SAVE_EXPENSE_ATTENDEES)!.variables.params as { attendees: Array<Record<string, unknown>> };
    expect(params.attendees.map((a) => [a.atnKey, a.transactionAmount])).toEqual([['frTESTKEYME==', 20]]);
  });

  it('matches me by preferred name too', async () => {
    const meAsPreferred = person('frTESTKEYME==', 'Samuel', 'Sample', 'sam.sample@example.com', { preferredName: 'Sam' });
    const other = person('frTESTKEYOTHER==', 'Alex', 'Sample', 'alex.sample@example.com');
    const { result } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      expense(10),
      owner('Samuel', 'Sample', 'Sam'),
      found(other, meAsPreferred),
    ]);
    const p = parseToolResult<Preview>(result);
    expect(p.status).toBe('confirmation-required');
    expect((p.preview.attendees as Array<{ atnKey: string }>).map((a) => a.atnKey)).toEqual(['frTESTKEYME==']);
  });

  it('refuses a term that matches several people, listing the candidates', async () => {
    const { result, text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['Example'] }, [
      expense(10),
      owner(),
      found(ME),
      found(PAT, PAT2),
    ]);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('"Example" matches 2 attendees');
    expect(text).toContain('pat.example@example.com');
    expect(text).toContain('patricia.example@example.com');
  });

  it('prefers the exact email match among several results', async () => {
    const { result } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['PAT.EXAMPLE@example.com'] }, [
      expense(10),
      owner(),
      found(ME),
      found(PAT, PAT2),
    ]);
    const p = parseToolResult<Preview>(result);
    expect((p.preview.attendees as Array<{ atnKey: string }>).map((a) => a.atnKey)).toEqual(['frTESTKEYME==', 'frTESTKEYPAT==']);
  });

  it('refuses a term that matches nobody', async () => {
    const { text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['nobody@example.com'] }, [
      expense(10),
      owner(),
      found(ME),
      found(GROUP),
    ]);
    expect(text).toContain('No attendee matches "nobody@example.com"');
  });

  it('refuses when it cannot tell which employee record is me', async () => {
    const { text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['pat.example@example.com'] }, [
      expense(10),
      owner(),
      found(PAT),
    ]);
    expect(text).toContain('Could not identify you');
    expect(text).toContain('includeMe: false');
  });

  it('refuses an empty attendee list', async () => {
    const { text, sent } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [], includeMe: false }, []);
    expect(text).toContain('at least one attendee');
    expect(sent).toEqual([]);
  });

  it('refuses an expense with no amount', async () => {
    const { text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [], includeMe: true }, [
      expense(10, { transactionAmount: null }),
    ]);
    expect(text).toContain('no transaction amount');
  });

  it('reports remaining exceptions after saving', async () => {
    const r = [expense(10, {}, [GROUP_MEAL_EXCEPTION]), owner(), found(ME)];
    const { text } = await confirmed('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      ...r,
      ...r,
      saved(),
      expense(10, { attendeeCount: 1, meta: { hasAttendees: true } }, [GROUP_MEAL_EXCEPTION]),
    ]);
    const out = untrustedPayload(text);
    expect(out.verified).toMatchObject({
      attendeeCount: 1,
      hasAttendees: true,
      exceptions: [{ expenseId: E1, message: 'Group meals need attendees.', blocking: true, code: 'ATTN' }],
    });
    expect((out.verified as Record<string, unknown>).observedExceptions).toMatch(/1 exception/);
  });

  it('a save whose re-read fails is still a success', async () => {
    const r = [expense(10), owner(), found(ME)];
    const { result, text } = await confirmed('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      ...r,
      ...r,
      saved(),
      failedReRead(),
    ]);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const out = untrustedPayload(text);
    expect(out).toMatchObject({ saved: true, attendeeKeys: ['frTESTKEYME=='] });
    expect(out.verified).toBeUndefined();
    expect(out.verificationError).toMatch(/The change was made, but re-reading it failed: .*correlationId=corr-reread/);
  });

  it('searches every resolution with the given attendeeTypeKeys (issue #12)', async () => {
    const r = [expense(20), owner(), found(ME), found(PAT)];
    const { phase1, sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: ['pat.example@example.com'], attendeeTypeKeys: [7, 42] },
      [...r, ...r, saved(), expense(20)],
    );
    const searches = [...phase1, ...sent].filter((s) => s.query === SEARCH_ATTENDEES);
    expect(searches).toHaveLength(4);
    for (const s of searches) expect(s.variables).toMatchObject({ includeAtnTypeKeys: [7, 42] });
  });

  it('defaults resolution searches to the same type keys as concur_search_attendees', async () => {
    const { sent } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['pat.example@example.com'] }, [
      expense(20),
      owner(),
      found(ME),
      found(PAT),
    ]);
    const searches = sent.filter((s) => s.query === SEARCH_ATTENDEES);
    expect(searches.map((s) => s.variables.includeAtnTypeKeys)).toEqual([
      [1, 2001],
      [1, 2001],
    ]);
  });

  it('takes an attendee as an exact {atnKey, typeCode, versionNumber} from concur_search_attendees, with no search (issue #12)', async () => {
    const guest = { atnKey: 'frTESTKEYGUEST==', typeCode: 'BUSGUEST', versionNumber: 4 };
    const r = [expense(30), owner(), found(ME)];
    const { preview: p, phase1, sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: [guest, 'pat.example@example.com'] },
      [...r, found(PAT), ...r, found(PAT), saved(), expense(30)],
    );
    expect(phase1.map((s) => s.query)).toEqual([GET_EXPENSE, GET_REPORT_OWNER, SEARCH_ATTENDEES, SEARCH_ATTENDEES]);
    expect(phase1[3]!.variables).toMatchObject({ searchTerms: 'pat.example@example.com' });
    expect(p.preview.attendees).toEqual([
      expect.objectContaining({ atnKey: 'frTESTKEYME==', me: true }),
      { typeCode: 'BUSGUEST', atnKey: 'frTESTKEYGUEST==', amount: '10 USD' },
      expect.objectContaining({ atnKey: 'frTESTKEYPAT==' }),
    ]);
    const params = sent.find((s) => s.query === SAVE_EXPENSE_ATTENDEES)!.variables.params as { attendees: Array<Record<string, unknown>> };
    expect(params.attendees[1]).toEqual({
      atnKey: 'frTESTKEYGUEST==',
      atnTypeCode: 'BUSGUEST',
      versionNumber: 4,
      instanceCount: 1,
      isAmtEdited: 'N',
      transactionAmount: 10,
    });
  });

  it('does not list an exact-key attendee twice when it is also me', async () => {
    const r = [expense(20), owner(), found(ME)];
    const { sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: [{ atnKey: 'frTESTKEYME==', typeCode: 'SYSEMP', versionNumber: 1 }] },
      [...r, ...r, saved(), expense(20)],
    );
    const params = sent.find((s) => s.query === SAVE_EXPENSE_ATTENDEES)!.variables.params as { attendees: Array<Record<string, unknown>> };
    expect(params.attendees.map((a) => a.atnKey)).toEqual(['frTESTKEYME==']);
  });

  it('rejects an exact-key attendee missing its type code or version', async () => {
    const { result, sent } = await call(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: [{ atnKey: 'frTESTKEYGUEST==' }] },
      [],
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('defaults a search row with no type code or version to an employee, version 1', async () => {
    const bare = person('frTESTKEYBARE==', 'Robin', 'Example', 'robin.example@example.com', { atnTypeCode: null, versionNumber: null });
    const r = [expense(10), found(bare)];
    const { sent } = await confirmed(
      'concur_set_attendees',
      { reportId: RID, expenseId: E1, attendees: ['robin.example@example.com'], includeMe: false },
      [...r, ...r, saved(), expense(10)],
    );
    const params = sent.find((s) => s.query === SAVE_EXPENSE_ATTENDEES)!.variables.params as { attendees: Array<Record<string, unknown>> };
    expect(params.attendees[0]).toMatchObject({ atnKey: 'frTESTKEYBARE==', atnTypeCode: 'SYSEMP', versionNumber: 1 });
  });

  it('lists nameless candidates by type code when a term is ambiguous', async () => {
    const anon = (key: string) =>
      person(key, '', '', '', { firstName: null, lastName: null, emailAddress: null, atnTypeName: null, atnTypeCode: 'BUSGUEST' });
    const { text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: ['guest'], includeMe: false }, [
      expense(10),
      found(anon('frTESTKEYA=='), anon('frTESTKEYB==')),
    ]);
    expect(text).toContain('"guest" matches 2 attendees');
    expect(text).toContain('(no name) · BUSGUEST · frTESTKEYA==');
  });

  it('refuses to guess me when the report owner has no last name', async () => {
    const { text, sent } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      expense(10),
      owner('Sam', ''),
    ]);
    expect(text).toContain('the report has no owner name');
    expect(sent.map((s) => s.query)).not.toContain(SEARCH_ATTENDEES);
  });

  it('names the owner by last name alone when it has no first name', async () => {
    const { text } = await call('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      expense(10),
      owner('', 'Sample'),
      found(),
    ]);
    expect(text).toContain('0 employee records match "Sample"');
  });

  it('previews and saves an expense with no currency, type, attendee count or meta', async () => {
    const bare = expense(10, { transactionAmount: { value: 10, currencyCode: null }, expenseType: null, attendeeCount: null, meta: null });
    const r = [bare, owner(), found(ME)];
    const { preview: p, text } = await confirmed('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      ...r,
      ...r,
      saved(),
      bare,
    ]);
    expect(p.preview.action).toContain(`expense ${E1} (expense, 10)`);
    expect(p.preview.currentAttendeeCount).toBeUndefined();
    expect((p.preview.attendees as Array<{ amount: string }>)[0]!.amount).toBe('10');
    const out = untrustedPayload(text);
    expect(out.verified).toEqual({ hasAttendees: false, exceptions: [] });
  });

  it('reports a save with no status as unconfirmed', async () => {
    const r = [expense(10), owner(), found(ME)];
    const { text } = await confirmed('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      ...r,
      ...r,
      { employee: { saveAttendeesLegacy: null } },
    ]);
    expect(text).toContain('did not confirm saving the attendees (status: null)');
  });

  it('reports an unconfirmed save', async () => {
    const r = [expense(10), owner(), found(ME)];
    const { text } = await confirmed('concur_set_attendees', { reportId: RID, expenseId: E1, attendees: [] }, [
      ...r,
      ...r,
      saved('FAILED'),
    ]);
    expect(text).toContain('did not confirm saving the attendees');
    expect(text).toContain('FAILED');
  });
});
