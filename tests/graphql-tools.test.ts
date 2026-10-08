import { afterEach, describe, expect, it } from 'vitest';
import { parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { DENIED_MUTATIONS } from '../src/graphql-guard.js';
import { SUBMIT_REPORT } from '../src/graphql/report-writes.js';
import { registerGraphqlTools } from '../src/tools/graphql.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness, untrustedPayload } from './helpers.js';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function call(name: string, args: Record<string, unknown>, script: unknown[] = []) {
  const t = await toolHarness(registerGraphqlTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent, isError: (result as { isError?: boolean }).isError === true };
}

interface Preview {
  status: string;
  confirmToken: string;
  preview: Record<string, unknown> & { action: string; willSend: Record<string, unknown> };
}

const SPEND_URL = 'https://www-us2.api.concursolutions.com/spend-graphql/graphql';
const CDS_URL = 'https://www-us2.api.concursolutions.com/cds/graphql';

const READ = 'query Me($userId: String!) { employee(userId: $userId, contextRole: TRAVELER) { userId } }';
const WRITE = `mutation DeleteExpenseEntries($userId: String!, $contextRole: ContextRoleType!, $reportId: String!, $expenseIds: [String!]) {
  employee(userId: $userId, contextRole: $contextRole) {
    expenseReport(reportId: $reportId) { deleteExpenseEntries(expenseIds: $expenseIds) { status { success } } }
  }
}`;

// ── registration ──────────────────────────────────────────────────────────

describe('graphql escape-hatch registration', () => {
  it('registers the three tools with truthful annotations', async () => {
    const t = await toolHarness(registerGraphqlTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual(['concur_graphql_mutation', 'concur_graphql_query', 'concur_list_operations']);

    for (const name of ['concur_graphql_query', 'concur_list_operations']) {
      expect(byName[name]!.annotations?.readOnlyHint).toBe(true);
      expect(byName[name]!.annotations?.destructiveHint).not.toBe(true);
    }
    const mutation = byName.concur_graphql_mutation!;
    expect(mutation.annotations?.readOnlyHint).toBe(false);
    expect(mutation.annotations?.destructiveHint).toBe(true);
    expect(Object.keys((mutation.inputSchema as { properties: object }).properties)).toContain('confirmToken');
    expect(mutation.description).toMatch(/confirmToken/);
  });

  it('points the descriptions at the operation index and docs/api', async () => {
    const t = await toolHarness(registerGraphqlTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    for (const tool of tools.filter((x) => x.name !== 'concur_list_operations')) {
      expect(tool.description).toMatch(/concur_list_operations/);
      expect(tool.description).toMatch(/docs\/api/);
    }
  });
});

// ── query ─────────────────────────────────────────────────────────────────

describe('concur_graphql_query', () => {
  it('runs a read on the spend endpoint with the variables and frames the data as untrusted', async () => {
    const { text, sent } = await call(
      'concur_graphql_query',
      { endpoint: 'spend', query: READ, variables: { userId: SUB } },
      [{ employee: { userId: SUB } }],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(SPEND_URL);
    expect(sent[0]!.query).toBe(READ);
    expect(sent[0]!.variables).toEqual({ userId: SUB });
    expect(untrustedPayload(text)).toEqual({ endpoint: 'spend', data: { employee: { userId: SUB } } });
  });

  it('runs on the CDS endpoint when asked, with no variables', async () => {
    const { sent } = await call('concur_graphql_query', { endpoint: 'cds', query: '{ travel { trips { tripPlanEligible } } }' }, [
      { travel: { trips: { tripPlanEligible: true } } },
    ]);
    expect(sent[0]!.url).toBe(CDS_URL);
    expect(sent[0]!.variables).toEqual({});
  });

  it('returns partial data with the failed fields as `warnings`', async () => {
    const data = { employee: { userId: SUB, rptKey: null } };
    const { text } = await call('concur_graphql_query', { query: READ, variables: { userId: SUB } }, [
      gqlPartial(data, fieldError(['employee', 'rptKey'], 'corr-g')),
    ]);
    expect(untrustedPayload(text)).toEqual({
      endpoint: 'spend',
      data,
      warnings: [{ path: 'employee.rptKey', message: 'An error occurred', correlationId: 'corr-g' }],
    });
  });

  it('defaults to the spend endpoint', async () => {
    const { sent } = await call('concur_graphql_query', { query: READ, variables: { userId: SUB } }, [{ employee: null }]);
    expect(sent[0]!.url).toBe(SPEND_URL);
  });

  it.each([
    ['a mutation', WRITE],
    ['a mutation after a query', `${READ}\n${WRITE}`],
    ['a subscription', 'subscription { x { y } }'],
    ['a malformed document', 'query { employee { userId }'],
  ])('refuses %s without sending anything', async (_label, query) => {
    const { isError, text, sent } = await call('concur_graphql_query', { query });
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only|concur_graphql_mutation/);
    expect(sent).toEqual([]);
  });

  it('refuses a document with more than one operation (no operationName is sent)', async () => {
    const { isError, text, sent } = await call('concur_graphql_query', { query: `${READ}\nquery Two { x }` });
    expect(isError).toBe(true);
    expect(text).toMatch(/exactly one operation/);
    expect(sent).toEqual([]);
  });
});

// ── mutation ──────────────────────────────────────────────────────────────

describe('concur_graphql_mutation', () => {
  it('previews the full document and variables, sending nothing, then runs exactly that on confirm', async () => {
    const variables = { userId: SUB, contextRole: 'TRAVELER', reportId: 'R1', expenseIds: ['E1'] };
    const result = { employee: { expenseReport: { deleteExpenseEntries: { status: { success: true } } } } };
    const t = await toolHarness(registerGraphqlTools, [result]);
    harness = t.harness;

    const args = { endpoint: 'spend', query: WRITE, variables };
    const first = parseToolResult<Preview>(await t.harness.callTool('concur_graphql_mutation', args));
    expect(first.status).toBe('confirmation-required');
    expect(t.sent).toEqual([]);
    expect(first.preview.action).toMatch(/DeleteExpenseEntries/);
    expect(first.preview.action).toMatch(/spend/);
    expect(first.preview.willSend).toEqual({ endpoint: 'spend', query: WRITE, variables });

    const second = await t.harness.callTool('concur_graphql_mutation', { ...args, confirmToken: first.confirmToken });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.url).toBe(SPEND_URL);
    expect(t.sent[0]!.query).toBe(WRITE);
    expect(t.sent[0]!.variables).toEqual(variables);
    expect(untrustedPayload(textOf(second))).toEqual({ endpoint: 'spend', operation: 'DeleteExpenseEntries', data: result });
  });

  it('names an anonymous mutation and sends empty variables when none are given', async () => {
    const t = await toolHarness(registerGraphqlTools, [{ x: { y: 1 } }]);
    harness = t.harness;
    const args = { query: 'mutation { x { y } }' };
    const first = parseToolResult<Preview>(await t.harness.callTool('concur_graphql_mutation', args));
    expect(first.preview.action).toMatch(/\(anonymous mutation\)/);
    expect(first.preview.willSend).toEqual({ endpoint: 'spend', query: 'mutation { x { y } }', variables: {} });
    await t.harness.callTool('concur_graphql_mutation', { ...args, confirmToken: first.confirmToken });
    expect(t.sent[0]!.variables).toEqual({});
  });

  it('refuses a token minted for a different document', async () => {
    const t = await toolHarness(registerGraphqlTools, [{}]);
    harness = t.harness;
    const first = parseToolResult<Preview>(
      await t.harness.callTool('concur_graphql_mutation', { query: WRITE, variables: { reportId: 'R1' } }),
    );
    const swapped = await t.harness.callTool('concur_graphql_mutation', {
      query: WRITE,
      variables: { reportId: 'R2' },
      confirmToken: first.confirmToken,
    });
    expect(textOf(swapped)).not.toMatch(/"data"/);
    expect(t.sent).toEqual([]);
  });

  it('runs on the CDS endpoint when asked', async () => {
    const t = await toolHarness(registerGraphqlTools, [{ travel: { trip: { sendItineraryEmail: { tripId: 'T' } } } }]);
    harness = t.harness;
    const query = 'mutation sendItinerary($input: TravelTripSendItineraryEmailInput!) { travel { trip { sendItineraryEmail(input: $input) { tripId } } } }';
    const args = { endpoint: 'cds', query, variables: { input: { tripId: 'T' } } };
    const first = parseToolResult<Preview>(await t.harness.callTool('concur_graphql_mutation', args));
    await t.harness.callTool('concur_graphql_mutation', { ...args, confirmToken: first.confirmToken });
    expect(t.sent.map((s) => s.url)).toEqual([CDS_URL]);
  });

  it.each([
    ['a query', READ],
    ['a query shorthand', '{ employee { userId } }'],
  ])('refuses %s and points at concur_graphql_query', async (_label, query) => {
    const { isError, text, sent } = await call('concur_graphql_mutation', { query });
    expect(isError).toBe(true);
    expect(text).toMatch(/concur_graphql_query/);
    expect(sent).toEqual([]);
  });

  it.each([
    ['two mutations', `${WRITE}\nmutation Two { x { y } }`],
    ['a subscription', 'subscription { x { y } }'],
    ['a malformed document', 'mutation { x { y }'],
  ])('refuses %s without sending anything', async (_label, query) => {
    const { isError, sent } = await call('concur_graphql_mutation', { query });
    expect(isError).toBe(true);
    expect(sent).toEqual([]);
  });

  it('refuses submit and points at concur_submit_report (before any preview)', async () => {
    const { isError, text, sent } = await call('concur_graphql_mutation', { query: SUBMIT_REPORT });
    expect(isError).toBe(true);
    expect(text).toMatch(/concur_submit_report/);
    expect(text).not.toMatch(/confirmToken/);
    expect(sent).toEqual([]);
  });

  it.each(DENIED_MUTATIONS.filter((d) => d.id !== 'submit').map((d) => [d.id, d.fields[0]!]))(
    'refuses %s as out of scope, even renamed',
    async (_id, field) => {
      const { isError, text, sent } = await call('concur_graphql_mutation', {
        endpoint: 'cds',
        query: `mutation Innocent { travel { trip { ${field}(tripId: "T") { __typename } } } }`,
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/out of scope/i);
      expect(sent).toEqual([]);
    },
  );
});

// ── operation index ───────────────────────────────────────────────────────

interface IndexResult {
  texts: string;
  count: number;
  operations: Array<{ name: string; endpoint: string; kind: string; purpose: string; text?: string; tool?: string; refused?: true }>;
}

describe('concur_graphql_mutation partial answers', () => {
  it('a mutation that answered data plus a sub-field error is a success with `warnings`', async () => {
    const t = await toolHarness(registerGraphqlTools, [
      gqlPartial(
        { employee: { expenseReport: { deleteExpenseEntries: { status: { success: true } } } } },
        fieldError(['employee', 'rptKey'], 'corr-m'),
      ),
    ]);
    harness = t.harness;
    const args = { query: WRITE, variables: { userId: SUB, contextRole: 'TRAVELER', reportId: 'R', expenseIds: ['E'] } };
    const first = parseToolResult<Preview>(await t.harness.callTool('concur_graphql_mutation', args));
    const result = await t.harness.callTool('concur_graphql_mutation', { ...args, confirmToken: first.confirmToken });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(untrustedPayload(textOf(result))).toMatchObject({
      operation: 'DeleteExpenseEntries',
      data: { employee: { expenseReport: { deleteExpenseEntries: { status: { success: true } } } } },
      warnings: [{ path: 'employee.rptKey', correlationId: 'corr-m' }],
    });
  });
});

describe('concur_list_operations', () => {
  it('lists spend and travel operations with a one-line purpose, without calling Concur', async () => {
    const { text, sent } = await call('concur_list_operations', {});
    expect(sent).toEqual([]);
    const r = JSON.parse(text) as IndexResult;
    expect(r.texts).toMatch(/github\.com\/chrischall\/concur-mcp\/tree\/main\/docs\/api/);
    expect(r.count).toBe(r.operations.length);
    const byName = Object.fromEntries(r.operations.map((o) => [o.name, o]));
    expect(byName.GetReportsForUser).toMatchObject({
      endpoint: 'spend',
      kind: 'query',
      tool: 'concur_list_reports',
      text: 'docs/api/spend-reads.graphql',
    });
    expect(byName.GetAirlineFeeTypes!.purpose).toBe('Get airline fee types.');
    expect(byName.SubmitExpenseReport).toMatchObject({ kind: 'mutation', refused: true });
    expect(byName.SubmitExpenseReport!.purpose).toMatch(/concur_submit_report/);
    expect(byName.loadTripList).toMatchObject({ endpoint: 'cds', kind: 'query', tool: 'concur_list_trips' });
    expect(byName.holdTrip).toMatchObject({ endpoint: 'cds', kind: 'mutation', refused: true });
    expect(byName.GetCardAccounts!.purpose).toMatch(/out of scope/);
  });

  it('filters by endpoint, kind and a case-insensitive name match', async () => {
    const { text } = await call('concur_list_operations', { endpoint: 'cds', kind: 'mutation', match: 'TRIP' });
    const r = JSON.parse(text) as IndexResult;
    expect(r.operations.map((o) => o.name).sort()).toEqual(['confirmTrip', 'holdTrip', 'tryCancelTripOrBooking'].sort());
  });
});
