// Escape hatches: raw GraphQL against either Concur endpoint, for anything the
// dedicated tools don't cover, plus the operation index that makes them usable.
// A query runs straight through (only if it cannot write); a mutation is
// confirm-gated with the whole document in the preview and refused outright
// when it hits the deny-list (submit, booking, cancel, approvals).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  McpToolError,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  confirmTokenParam,
  confirmWrite,
  messageOf,
  minifiedResult,
  toolAnnotations,
  untrustedResult,
} from '@chrischall/mcp-utils';
import { isReadOnlyGraphqlDocument } from '@chrischall/mcp-utils/graphql';
import { warningsField, type ConcurClient } from '../client.js';
import { findDeniedMutation, inspectGraphqlDocument, type GraphqlDocumentInfo } from '../graphql-guard.js';
import { OPERATION_TEXTS_URL, operationIndex, type GraphqlEndpoint } from '../operations.js';

const GATE = `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`;
const MAX_DOCUMENT = 100_000;

const ENDPOINT_NOTE =
  '`spend` = /spend-graphql/graphql (expense reports, entries, receipts, available expenses); `cds` = /cds/graphql ' +
  '(travel: loadTripList, loadOverviewTrip, …).';

const SHAPES_NOTE =
  'Introspection is disabled; find operation names with concur_list_operations and their verbatim texts in the ' +
  `repo's docs/api/ (spend-reads.graphql, spend-operations.graphql, spend-forms.graphql, travel-operations.graphql — ${OPERATION_TEXTS_URL}). ` +
  'Pass the real userId (concur_whoami) and contextRole TRAVELER where an operation asks for them.';

const endpointParam = z.enum(['spend', 'cds']).default('spend').describe(`Which GraphQL endpoint (default spend). ${ENDPOINT_NOTE}`);
const documentParam = (what: string) =>
  z.string().trim().min(1).max(MAX_DOCUMENT).describe(`The GraphQL document: exactly one ${what} (plus any fragments it spreads).`);
const variablesParam = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Variables for the operation, as a JSON object.');

function unreadable(err: unknown): McpToolError {
  return new McpToolError(`The GraphQL document could not be parsed: ${messageOf(err)}.`, {
    hint: 'Send one well-formed operation; copy its text from docs/api/ rather than retyping it.',
  });
}

function inspect(query: string): GraphqlDocumentInfo {
  try {
    return inspectGraphqlDocument(query);
  } catch (err) {
    throw unreadable(err);
  }
}

function requireSingleOperation(info: GraphqlDocumentInfo): void {
  if (info.operations.length !== 1) {
    throw new McpToolError(
      `The document must contain exactly one operation (it has ${info.operations.length}); this tool sends no operationName.`,
      { hint: 'Split it into one call per operation.' },
    );
  }
}

function run(client: ConcurClient, endpoint: GraphqlEndpoint, query: string, variables: Record<string, unknown> | undefined) {
  return endpoint === 'cds' ? client.cds(query, variables) : client.spend(query, variables);
}

export function registerGraphqlTools(server: McpServer, client: ConcurClient): void {
  server.registerTool(
    'concur_graphql_query',
    {
      description:
        'Run a raw read-only GraphQL query against SAP Concur — the escape hatch for data no dedicated tool returns. ' +
        'Refuses anything that could write (a mutation or subscription anywhere in the document, or a document it ' +
        `cannot parse); use concur_graphql_mutation for writes. ${ENDPOINT_NOTE} ${SHAPES_NOTE} Prefer a dedicated tool ` +
        'when concur_list_operations names one. Returns the GraphQL `data` as-is. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: toolAnnotations({ title: 'Run a Concur GraphQL query', readOnly: true, openWorld: true }),
      inputSchema: z.object({
        endpoint: endpointParam,
        query: documentParam('query'),
        variables: variablesParam,
      }),
    },
    async ({ endpoint, query, variables }) => {
      if (!isReadOnlyGraphqlDocument(query)) {
        throw new McpToolError(
          'concur_graphql_query only runs read-only documents: this one contains a mutation or subscription, or could not be parsed.',
          { hint: 'Use concur_graphql_mutation for a write (it asks for confirmation first).' },
        );
      }
      requireSingleOperation(inspect(query));
      const data = await run(client, endpoint, query, variables);
      return untrustedResult({ endpoint, data, ...warningsField(data) });
    },
  );

  server.registerTool(
    'concur_graphql_mutation',
    {
      description:
        'Run a raw GraphQL mutation against SAP Concur — the escape hatch for writes no dedicated tool covers. The ' +
        'preview shows the full document and variables exactly as they will be sent; this MCP cannot tell what an ' +
        'arbitrary mutation changes, so treat it as irreversible. Refused outright: submitting a report (use ' +
        'concur_submit_report) and the out-of-scope operations — trip cancel/hold/confirm/change, booking selections, ' +
        'travel search, approvals and delegate work items. Prefer a dedicated tool whenever concur_list_operations ' +
        `names one. ${ENDPOINT_NOTE} ${SHAPES_NOTE} ` +
        GATE,
      annotations: toolAnnotations({ title: 'Run a Concur GraphQL mutation', destructive: true, openWorld: true }),
      inputSchema: z.object({
        endpoint: endpointParam,
        query: documentParam('mutation'),
        variables: variablesParam,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ endpoint, query, variables, confirmToken }, ctx) => {
      const info = inspect(query);
      const kinds = new Set(info.operations.map((o) => o.kind));
      if (kinds.has('subscription')) {
        throw new McpToolError('Subscriptions are not supported.');
      }
      if (!kinds.has('mutation')) {
        throw new McpToolError('This document has no mutation; run reads with concur_graphql_query.', {
          hint: 'concur_graphql_query runs read-only documents without a confirmation step.',
        });
      }
      requireSingleOperation(info);
      const denied = findDeniedMutation(query);
      if (denied) throw new McpToolError(`Refused: ${denied.reason}`);

      const operation = info.operations[0]!.name ?? '(anonymous mutation)';
      const payload = { endpoint, query, variables: variables ?? {} };
      const gate = await confirmWrite(ctx, {
        tool: 'concur_graphql_mutation',
        action: 'concur.graphql.mutation',
        summary: `Run the raw GraphQL mutation ${operation} on Concur's ${endpoint} endpoint`,
        account: await client.userId(),
        target: operation,
        payload,
        preview: {
          warning:
            'Raw GraphQL: this MCP cannot tell what this mutation changes or whether it can be undone. Read the document before approving.',
        },
        confirmToken,
      });
      if (gate) return gate;

      const data = await run(client, endpoint, query, variables);
      return untrustedResult({ endpoint, operation, data, ...warningsField(data) });
    },
  );

  server.registerTool(
    'concur_list_operations',
    {
      description:
        'List the GraphQL operations the SAP Concur web app uses (from its public bundles): name, endpoint ' +
        '(spend|cds), query or mutation, a one-line purpose, the dedicated tool that already runs it (prefer that ' +
        'tool), whether concur_graphql_mutation refuses it, and which docs/api/ file holds its verbatim text ' +
        `(${OPERATION_TEXTS_URL}). Use it to find shapes for concur_graphql_query / concur_graphql_mutation. ` +
        'Local data — no call to Concur.',
      annotations: toolAnnotations({ title: 'List Concur GraphQL operations', readOnly: true, openWorld: false }),
      inputSchema: z.object({
        endpoint: z.enum(['spend', 'cds']).optional().describe('Only this endpoint.'),
        kind: z.enum(['query', 'mutation']).optional().describe('Only queries or only mutations.'),
        match: z.string().trim().min(1).max(100).optional().describe('Only names containing this text (case-insensitive).'),
      }),
    },
    async ({ endpoint, kind, match }) => {
      const needle = match?.toLowerCase();
      const operations = operationIndex().filter(
        (o) =>
          (!endpoint || o.endpoint === endpoint) &&
          (!kind || o.kind === kind) &&
          (!needle || o.name.toLowerCase().includes(needle)),
      );
      return minifiedResult({ texts: OPERATION_TEXTS_URL, count: operations.length, operations });
    },
  );
}
