// concur_healthcheck — a CREDENTIAL healthcheck: the bridge is used only to
// lift the session cookies, then every call is direct from Node, so the useful
// questions are "is there a session, how long has it got, does the API accept
// it". Reports a source label and minutes-to-expiry, never the token.

import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { ConcurClient } from '../client.js';
import { ConcurConfigError } from '../config.js';
import { ConcurBridgeError, ConcurDatacenterError, ConcurSessionError, isHintedFetchproxyError } from '../session.js';

/** The cheapest authenticated read: resolve the signed-in employee. */
export const HEALTHCHECK_QUERY =
  'query ConcurHealthcheck($userId: String!, $contextRole: ContextRoleType!) { employee(userId: $userId, contextRole: $contextRole) { userId } }';

const CREDENTIAL_SOURCE = 'browser session cookie (ContextMint Bridge)';

function classify(err: unknown): { kind: string; hint?: string; detail?: Record<string, unknown> } | undefined {
  if (isHintedFetchproxyError(err)) {
    return { kind: 'bridge', hint: (err as McpToolError).hint, detail: { error: (err as Error).name } };
  }
  if (err instanceof ConcurBridgeError) return { kind: 'bridge', hint: err.hint };
  if (err instanceof ConcurSessionError) return { kind: 'no_credential', hint: err.hint };
  if (err instanceof ConcurConfigError || err instanceof ConcurDatacenterError) return { kind: 'config', hint: err.hint };
  return undefined;
}

export function registerHealthcheckTool(server: McpServer, client: ConcurClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'concur',
    hostLabel: client.hostLabel,
    probePath: '/spend-graphql/graphql',
    resolveCredential: async () => {
      const session = await client.session();
      return {
        source: CREDENTIAL_SOURCE,
        detail: {
          datacenter: session.dc,
          expires_in_minutes: Math.floor((session.exp - client.now() / 1000) / 60),
          // Legacy-backed fields (report keys, currencies, receipts) need it.
          legacy_session_cookie: session.legacyCookie !== undefined,
        },
      };
    },
    probeFn: async () => {
      const userId = await client.userId();
      const data = await client.spend<{ employee: { userId?: string } | null }>(HEALTHCHECK_QUERY, {
        userId,
        contextRole: 'TRAVELER',
      });
      if (!data.employee?.userId) {
        throw new McpToolError('SAP Concur answered, but returned no employee for the signed-in user.');
      }
    },
    classifyThrown: classify,
  });
}
