// Identity and reference data: who am I, expense types for a report, payment
// types, currencies, and the location search used by expense forms.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { warningsField, type ConcurClient } from '../client.js';
import { LIST_CURRENCIES, LIST_EXPENSE_TYPES, LIST_PAYMENT_TYPES, SEARCH_LOCATIONS, WHOAMI } from '../graphql/lookups.js';
import { GET_REPORT_POLICY } from '../graphql/reports.js';
import { REPORT_ESSENTIAL, reportIdParam } from './reports.js';
import { CONTEXT_ROLE, concurView, prune, respond, trueFlags } from './shared.js';

interface WhoamiData {
  employee: { userId?: string; contextRole?: string } | null;
  userPermissions: Record<string, unknown> | null;
}

interface ReportPolicyData {
  employee: {
    expenseReport: { reportDetails: { policyId?: string | null; reportOwnerUserId?: string | null } | null } | null;
  } | null;
}

interface ExpenseType {
  id?: string;
  code?: string;
  name?: string;
  parentName?: string | null;
  header?: unknown;
  [key: string]: unknown;
}

interface PaymentType {
  paymentTypeId?: string;
  paymentTypeName?: string;
  isPrePopulatedOnly?: boolean | null;
}

interface Location {
  id?: string;
  locationId?: string;
  name?: string;
  preferredDisplay?: string | null;
  country?: { code?: string; currencyCode?: string } | null;
  subdivision?: { code?: string } | null;
  [key: string]: unknown;
}

const listOf = <T>(value: T[] | null | undefined): T[] => value ?? [];

export function registerLookupTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_whoami',
    {
      description:
        'Who the SAP Concur session belongs to: your Concur user id (UUID), the datacenter, minutes until the ' +
        'browser session token expires, and which Concur features your account has (travel requests, cash ' +
        'advances, ExpenseIt).',
      annotations: toolAnnotations({ title: 'Concur: who am I', readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const session = await client.session();
      const data = await client.spend<WhoamiData>(
        WHOAMI,
        { userId: session.userId, contextRole: CONTEXT_ROLE },
        { essential: ['employee.userId'] },
      );
      if (!data.employee?.userId) {
        throw new McpToolError('SAP Concur answered, but returned no employee for the signed-in user.');
      }
      return minifiedResult(
        prune({
          userId: data.employee.userId,
          contextRole: data.employee.contextRole,
          datacenter: session.dc,
          sessionExpiresInMinutes: Math.floor((session.exp - client.now() / 1000) / 60),
          features: trueFlags(data.userPermissions) ?? [],
          ...warningsField(data),
        }),
      );
    },
  );

  server.registerTool(
    'concur_list_expense_types',
    {
      description:
        'List the expense types you can use on one SAP Concur report (its policy decides which). Returns each ' +
        "type's id (pass it as the expense type when creating an expense), name and group.",
      annotations: toolAnnotations({ title: 'List Concur expense types', readOnly: true }),
      inputSchema: z.object({
        reportId: reportIdParam,
        view: concurView('compact keeps id, code, name and group (parentName); full adds description, text, header and visibility.'),
      }),
    },
    async ({ reportId, view }) => {
      const userId = await client.userId();
      const header = await client.spend<ReportPolicyData>(GET_REPORT_POLICY, {
        userId,
        reportId,
        contextRole: CONTEXT_ROLE,
      }, REPORT_ESSENTIAL);
      const details = header.employee?.expenseReport?.reportDetails;
      if (!details?.policyId) {
        throw new McpToolError('SAP Concur returned no report (or no policy) with that id for the signed-in user.', {
          hint: 'Check the id with concur_list_reports.',
        });
      }
      const data = await client.spend<{ expenseTypesForReport: ExpenseType[] | null }>(LIST_EXPENSE_TYPES, {
        userId,
        contextRole: CONTEXT_ROLE,
        policyId: details.policyId,
        reportId,
        reportOwnerUserId: details.reportOwnerUserId ?? userId,
      });
      const types = (d: typeof data) => listOf(d.expenseTypesForReport);
      return respond(
        view,
        data,
        {
          compact: (d) => ({
            expenseTypes: types(d).map((t) => prune({ id: t.id, code: t.code, name: t.name, group: t.parentName })),
          }),
          full: (d) => ({ expenseTypes: types(d) }),
        },
        { context: 'GetExpenseTypesForReport' },
      );
    },
  );

  server.registerTool(
    'concur_list_payment_types',
    {
      description:
        'List the SAP Concur payment types you can put on an expense (e.g. cash / out-of-pocket, company card). ' +
        'Returns each payment type id and name.',
      annotations: toolAnnotations({ title: 'List Concur payment types', readOnly: true }),
      inputSchema: z.object({
        view: concurView('compact renames to {id, name} and shows prePopulatedOnly only when true (card-fed types you cannot pick by hand).'),
      }),
    },
    async ({ view }) => {
      const data = await client.spend<{ paymentTypes: PaymentType[] | null }>(LIST_PAYMENT_TYPES, {
        reportOwnerUserId: await client.userId(),
      });
      return respond(
        view,
        data,
        {
          compact: (d) => ({
            paymentTypes: listOf(d.paymentTypes).map((p) =>
              prune({ id: p.paymentTypeId, name: p.paymentTypeName, prePopulatedOnly: p.isPrePopulatedOnly || undefined }),
            ),
          }),
          full: (d) => ({ paymentTypes: listOf(d.paymentTypes) }),
        },
        { context: 'GetPaymentTypes' },
      );
    },
  );

  server.registerTool(
    'concur_list_currencies',
    {
      description:
        'List the currencies SAP Concur accepts (ISO code and name), optionally filtered by a code or name fragment.',
      annotations: toolAnnotations({ title: 'List Concur currencies', readOnly: true }),
      inputSchema: z.object({
        search: z.string().trim().min(1).optional().describe('Case-insensitive code or name fragment, e.g. "eur" or "dollar".'),
        view: concurView('compact renders each currency as one "CODE Name" string; full keeps {code, name} objects; raw is unfiltered.'),
      }),
    },
    async ({ search, view }) => {
      const data = await client.spend<{ currencies: Array<{ code?: string; name?: string }> | null }>(LIST_CURRENCIES);
      const needle = search?.toLowerCase();
      const matching = (d: typeof data) =>
        listOf(d.currencies).filter(
          (c) => !needle || `${c.code ?? ''} ${c.name ?? ''}`.toLowerCase().includes(needle),
        );
      return respond(
        view,
        data,
        {
          compact: (d) => ({ currencies: matching(d).map((c) => [c.code, c.name].filter(Boolean).join(' ')) }),
          full: (d) => ({ currencies: matching(d) }),
        },
        { context: 'GetCurrencies' },
      );
    },
  );

  server.registerTool(
    'concur_search_locations',
    {
      description:
        'Search SAP Concur locations by city name (optionally narrowed by country and subdivision code) — the ' +
        'location list expense forms use. Returns each match with its id, display name, country, subdivision and ' +
        'local currency.',
      annotations: toolAnnotations({ title: 'Search Concur locations', readOnly: true }),
      inputSchema: z.object({
        city: z.string().trim().min(1).describe('City name or its beginning, e.g. "Toronto".'),
        countryCode: z
          .string()
          .regex(/^[A-Za-z]{2}$/, 'a two-letter country code')
          .transform((s) => s.toUpperCase())
          .optional()
          .describe('ISO country code, e.g. "CA".'),
        subdivisionCode: z.string().trim().min(1).optional().describe('Subdivision code as Concur writes it, e.g. "CA-ON".'),
        view: concurView('compact keeps id, locationId, display name, country, subdivision and currency codes; full adds legacyKey and the country/subdivision names.'),
      }),
    },
    async ({ city, countryCode, subdivisionCode, view }) => {
      const data = await client.spend<{ locations: Location[] | null }>(SEARCH_LOCATIONS, {
        cityName: city,
        countryCode: countryCode ?? null,
        subdivisionCode: subdivisionCode ?? null,
      });
      return respond(
        view,
        data,
        {
          compact: (d) => ({
            locations: listOf(d.locations).map((l) =>
              prune({
                id: l.id,
                locationId: l.locationId,
                name: l.preferredDisplay || l.name,
                country: l.country?.code,
                subdivision: l.subdivision?.code,
                currency: l.country?.currencyCode,
              }),
            ),
          }),
          full: (d) => ({ locations: listOf(d.locations) }),
        },
        { context: 'GetLocations' },
      );
    },
  );
}
