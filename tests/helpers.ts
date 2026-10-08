import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import type { McpServer } from '@modelcontextprotocol/server';
import { ConcurClient } from '../src/client.js';

// Shared test fixtures. No real credential: fake JWTs are unsigned base64url
// JSON with a dummy signature segment.

export const NOW = 1_800_000_000; // epoch seconds
export const SUB = '0a1b2c3d-0000-4000-8000-000000000001';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

export const goodClaims = (exp = NOW + 3600, dc = 'us2') => ({
  iss: `https://${dc}.api.concursolutions.com`,
  sub: SUB,
  exp,
  iat: exp - 3600,
});

// ── tool-test harness ──────────────────────────────────────────────────────


export interface SentRequest {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  /** The raw request (multipart uploads and downloads carry no GraphQL body). */
  init: RequestInit;
}

export const gqlOk = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });

/** A Concur field error (a 200's `errors[]` entry) at `path`. */
export const fieldError = (path: Array<string | number>, correlationId = 'corr-1') => ({
  message: 'An error occurred',
  path,
  extensions: { dataSource: 'LegacyService', response: { status: 500 }, correlationId },
});

/** A 200 with data AND errors[] — Concur's usual partial answer. */
export const gqlPartial = (data: unknown, ...errors: unknown[]) =>
  new Response(JSON.stringify({ data, errors }), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * A ConcurClient whose fetch answers each request with the next scripted
 * `data` payload (or Response), recording what was sent. No network.
 */
export async function toolHarness(
  register: (server: McpServer, client: ConcurClient) => void,
  script: Array<unknown | Response>,
): Promise<{ harness: TestHarness; sent: SentRequest[]; jwt: string }> {
  const jwt = fakeJwt(goodClaims(NOW + 45 * 60 + 30));
  const queue = [...script];
  const sent: SentRequest[] = [];
  const client = new ConcurClient({
    env: {},
    readCookies: async () => ({ JWT: jwt }),
    now: () => NOW * 1000,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = (typeof init.body === 'string' ? JSON.parse(init.body) : { query: '' }) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      sent.push({ url: String(url), query: body.query, variables: body.variables ?? {}, init });
      if (queue.length === 0) throw new Error('unexpected fetch');
      const next = queue.shift();
      return next instanceof Response ? next : gqlOk(next);
    }) as unknown as typeof fetch,
  });
  const harness = await createTestHarness((server) => register(server, client));
  return { harness, sent, jwt };
}

/** The text of a tool result's first content block. */
export function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0]!).text;
}

/** An untrusted-framed result's payload, after checking the markers are there. */
export function untrustedPayload(text: string): Record<string, unknown> {
  const { untrusted_content, note, ...rest } = JSON.parse(text) as Record<string, unknown>;
  if (untrusted_content !== true || typeof note !== 'string') throw new Error(`not untrusted-framed: ${text.slice(0, 80)}`);
  return rest;
}
