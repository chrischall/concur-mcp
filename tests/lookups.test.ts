import { afterEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import { LIST_CURRENCIES, LIST_EXPENSE_TYPES, LIST_PAYMENT_TYPES, SEARCH_LOCATIONS, WHOAMI } from '../src/graphql/lookups.js';
import { GET_REPORT_POLICY } from '../src/graphql/reports.js';
import { registerLookupTools } from '../src/tools/lookups.js';
import { SUB, fieldError, gqlPartial, textOf, toolHarness } from './helpers.js';

const RID = '0123456789ABCDEF0123';

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function call(name: string, args: Record<string, unknown>, script: unknown[]) {
  const t = await toolHarness(registerLookupTools, script);
  harness = t.harness;
  const result = await t.harness.callTool(name, args);
  return { result, text: textOf(result), sent: t.sent, jwt: t.jwt };
}

describe('concur_whoami', () => {
  it('reports the user id, datacenter, minutes to expiry and enabled features — never the token', async () => {
    const { text, sent, jwt } = await call('concur_whoami', {}, [
      {
        employee: { userId: SUB, contextRole: 'TRAVELER' },
        userPermissions: { userId: SUB, isRequestTraveler: false, isCashAdvanceUser: true, isExpenseItEnabled: true },
      },
    ]);
    expect(sent[0]!.query).toBe(WHOAMI);
    expect(sent[0]!.variables).toEqual({ userId: SUB, contextRole: 'TRAVELER' });
    expect(JSON.parse(text)).toEqual({
      userId: SUB,
      contextRole: 'TRAVELER',
      datacenter: 'us2',
      sessionExpiresInMinutes: 45,
      features: ['isCashAdvanceUser', 'isExpenseItEnabled'],
    });
    expect(text).not.toContain(jwt);
  });

  it('no permissions block → empty feature list', async () => {
    const { text } = await call('concur_whoami', {}, [{ employee: { userId: SUB, contextRole: null }, userPermissions: null }]);
    expect(JSON.parse(text)).toEqual({ userId: SUB, datacenter: 'us2', sessionExpiresInMinutes: 45, features: [] });
  });

  it('a failed userPermissions (legacy-backed) keeps the answer and reports a warning', async () => {
    const { text } = await call('concur_whoami', {}, [
      gqlPartial({ employee: { userId: SUB, contextRole: 'TRAVELER' }, userPermissions: null }, fieldError(['userPermissions'], 'corr-p')),
    ]);
    expect(JSON.parse(text)).toMatchObject({
      userId: SUB,
      features: [],
      warnings: [{ path: 'userPermissions', message: 'An error occurred', correlationId: 'corr-p' }],
    });
  });

  it('no employee is an error', async () => {
    const { result } = await call('concur_whoami', {}, [{ employee: null, userPermissions: null }]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no employee/);
  });
});

const policy = (details: unknown) => ({ employee: { userId: SUB, expenseReport: { reportId: RID, reportDetails: details } } });

const types = [
  { id: 'DUESX', code: 'DUESX', name: 'Dues', parentName: 'Other', description: null, text: null, header: null, visibilityCode: 'B' },
  { id: 'MEALS', code: 'MEALS', name: 'Meals', parentName: null, description: 'Meals', text: null, header: null, visibilityCode: 'B' },
];

describe('concur_list_expense_types', () => {
  it("resolves the report's policy and owner, then lists that policy's types", async () => {
    const owner = '0a1b2c3d-0000-4000-8000-0000000000ff';
    const { text, sent } = await call('concur_list_expense_types', { reportId: RID }, [
      policy({ id: RID, policyId: 'POL1', reportOwnerUserId: owner }),
      { expenseTypesForReport: types },
    ]);
    expect(sent[0]!.query).toBe(GET_REPORT_POLICY);
    expect(sent[0]!.variables).toEqual({ userId: SUB, reportId: RID, contextRole: 'TRAVELER' });
    expect(sent[1]!.query).toBe(LIST_EXPENSE_TYPES);
    expect(sent[1]!.variables).toEqual({
      userId: SUB,
      contextRole: 'TRAVELER',
      policyId: 'POL1',
      reportId: RID,
      reportOwnerUserId: owner,
    });
    expect(JSON.parse(text)).toEqual({
      expenseTypes: [
        { id: 'DUESX', code: 'DUESX', name: 'Dues', group: 'Other' },
        { id: 'MEALS', code: 'MEALS', name: 'Meals' },
      ],
    });
  });

  it('owner defaults to the signed-in user; full keeps every field; null list is empty', async () => {
    const { text, sent } = await call('concur_list_expense_types', { reportId: RID, view: 'full' }, [
      policy({ id: RID, policyId: 'POL1', reportOwnerUserId: null }),
      { expenseTypesForReport: types },
    ]);
    expect(sent[1]!.variables.reportOwnerUserId).toBe(SUB);
    expect(JSON.parse(text)).toEqual({ expenseTypes: types });
    await harness?.close();
    const empty = await call('concur_list_expense_types', { reportId: RID }, [
      policy({ id: RID, policyId: 'POL1', reportOwnerUserId: SUB }),
      { expenseTypesForReport: null },
    ]);
    expect(JSON.parse(empty.text)).toEqual({ expenseTypes: [] });
  });

  it('an unknown report (or one with no policy) is an actionable error and stops there', async () => {
    const { result, sent } = await call('concur_list_expense_types', { reportId: RID }, [policy(null)]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no report[\s\S]*concur_list_reports/);
    expect(sent).toHaveLength(1);
    await harness?.close();
    const noPolicy = await call('concur_list_expense_types', { reportId: RID }, [policy({ id: RID, policyId: null })]);
    expect(noPolicy.result.isError).toBe(true);
    await harness?.close();
    const noEmployee = await call('concur_list_expense_types', { reportId: RID }, [{ employee: null }]);
    expect(noEmployee.result.isError).toBe(true);
  });
});

describe('concur_list_payment_types', () => {
  const paymentTypes = [
    { paymentTypeId: 'CASH', paymentTypeName: 'Cash', isPrePopulatedOnly: false },
    { paymentTypeId: 'CBCP', paymentTypeName: 'Company Card', isPrePopulatedOnly: true },
  ];

  it('lists for the signed-in user, compact renames', async () => {
    const { text, sent } = await call('concur_list_payment_types', {}, [{ paymentTypes }]);
    expect(sent[0]!.query).toBe(LIST_PAYMENT_TYPES);
    expect(sent[0]!.variables).toEqual({ reportOwnerUserId: SUB });
    expect(JSON.parse(text)).toEqual({
      paymentTypes: [
        { id: 'CASH', name: 'Cash' },
        { id: 'CBCP', name: 'Company Card', prePopulatedOnly: true },
      ],
    });
  });

  it('full keeps the upstream names; null list is empty', async () => {
    const { text } = await call('concur_list_payment_types', { view: 'full' }, [{ paymentTypes }]);
    expect(JSON.parse(text)).toEqual({ paymentTypes });
    await harness?.close();
    const empty = await call('concur_list_payment_types', {}, [{ paymentTypes: null }]);
    expect(JSON.parse(empty.text)).toEqual({ paymentTypes: [] });
  });
});

describe('concur_list_currencies', () => {
  const currencies = [
    { code: 'USD', name: 'US Dollar' },
    { code: 'EUR', name: 'Euro' },
    { code: 'CAD', name: 'Canadian Dollar' },
    { code: 'XXX', name: null },
  ];

  it('lists every currency as "CODE Name"', async () => {
    const { text, sent } = await call('concur_list_currencies', {}, [{ currencies }]);
    expect(sent[0]!.query).toBe(LIST_CURRENCIES);
    expect(sent[0]!.variables).toEqual({});
    expect(JSON.parse(text)).toEqual({ currencies: ['USD US Dollar', 'EUR Euro', 'CAD Canadian Dollar', 'XXX'] });
  });

  it('filters by code or name, case-insensitively; full keeps objects; raw is unfiltered', async () => {
    const { text } = await call('concur_list_currencies', { search: 'DOLLAR' }, [{ currencies }]);
    expect(JSON.parse(text)).toEqual({ currencies: ['USD US Dollar', 'CAD Canadian Dollar'] });
    await harness?.close();
    const full = await call('concur_list_currencies', { search: 'eur', view: 'full' }, [
      { currencies: [...currencies, { code: null, name: 'Euro (old)' }] },
    ]);
    expect(JSON.parse(full.text)).toEqual({ currencies: [{ code: 'EUR', name: 'Euro' }, { code: null, name: 'Euro (old)' }] });
    await harness?.close();
    const raw = await call('concur_list_currencies', { search: 'eur', view: 'raw' }, [{ currencies }]);
    expect(JSON.parse(raw.text)).toEqual({ currencies });
  });

  it('a null list is empty', async () => {
    const { text } = await call('concur_list_currencies', {}, [{ currencies: null }]);
    expect(JSON.parse(text)).toEqual({ currencies: [] });
  });
});

describe('concur_search_locations', () => {
  const locations = [
    {
      id: '5965E68F48AC4FA9A1AF739D6AE5D225',
      locationId: 'feea1853-9e06-4611-9cf0-834f834d4dd8',
      legacyKey: 1,
      name: 'Toronto',
      preferredDisplay: 'Toronto, Ontario',
      country: { code: 'CA', name: 'CANADA', currencyCode: 'CAD', currencyName: 'Canadian Dollar' },
      subdivision: { code: 'CA-ON', name: 'Ontario' },
    },
    { id: 'X', locationId: null, legacyKey: null, name: 'Nowhere', preferredDisplay: null, country: null, subdivision: null },
  ];

  it('searches by city with optional country/subdivision, compact projection', async () => {
    const { text, sent } = await call('concur_search_locations', { city: 'Toronto', countryCode: 'ca', subdivisionCode: 'CA-ON' }, [
      { locations },
    ]);
    expect(sent[0]!.query).toBe(SEARCH_LOCATIONS);
    expect(sent[0]!.variables).toEqual({ cityName: 'Toronto', countryCode: 'CA', subdivisionCode: 'CA-ON' });
    expect(JSON.parse(text)).toEqual({
      locations: [
        {
          id: '5965E68F48AC4FA9A1AF739D6AE5D225',
          locationId: 'feea1853-9e06-4611-9cf0-834f834d4dd8',
          name: 'Toronto, Ontario',
          country: 'CA',
          subdivision: 'CA-ON',
          currency: 'CAD',
        },
        { id: 'X', name: 'Nowhere' },
      ],
    });
  });

  it('omitted filters go as null; full keeps everything; null list is empty', async () => {
    const { text, sent } = await call('concur_search_locations', { city: 'Tor', view: 'full' }, [{ locations }]);
    expect(sent[0]!.variables).toEqual({ cityName: 'Tor', countryCode: null, subdivisionCode: null });
    expect(JSON.parse(text)).toEqual({ locations });
    await harness?.close();
    const empty = await call('concur_search_locations', { city: 'Zz' }, [{ locations: null }]);
    expect(JSON.parse(empty.text)).toEqual({ locations: [] });
  });

  it('rejects an empty city and a non-ISO country code', async () => {
    const a = await call('concur_search_locations', { city: '  ' }, []);
    expect(a.result.isError).toBe(true);
    await harness?.close();
    const b = await call('concur_search_locations', { city: 'Paris', countryCode: 'FRA' }, []);
    expect(b.result.isError).toBe(true);
    expect(b.sent).toHaveLength(0);
  });
});

describe('lookup tool roster', () => {
  it('registers five read-only tools', async () => {
    const t = await toolHarness(registerLookupTools, []);
    harness = t.harness;
    const { tools } = await t.harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'concur_list_currencies',
      'concur_list_expense_types',
      'concur_list_payment_types',
      'concur_search_locations',
      'concur_whoami',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});
