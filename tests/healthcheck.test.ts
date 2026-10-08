import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReadOnlyGraphqlDocument } from '@chrischall/mcp-utils/graphql';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { ConcurClient } from '../src/client.js';
import { HEALTHCHECK_QUERY, registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { NOW, SUB, fakeJwt, goodClaims } from './helpers.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  probe: { url?: string; status?: number };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

const JWT = fakeJwt(goodClaims(NOW + 30 * 60 + 59));

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function run(opts: {
  env?: Record<string, string>;
  readJwt?: () => Promise<string | undefined>;
  responses?: Response[];
}): Promise<{ result: Result; text: string; bodies: unknown[] }> {
  const responses = [...(opts.responses ?? [])];
  const bodies: unknown[] = [];
  const client = new ConcurClient({
    env: opts.env ?? {},
    readCookies: async () => {
      const jwt = await (opts.readJwt ?? (async () => JWT))();
      return jwt === undefined ? {} : { JWT: jwt };
    },
    now: () => NOW * 1000,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    }) as unknown as typeof fetch,
  });
  harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
  const raw = await harness.callTool('concur_healthcheck');
  const text = (raw.content as { text: string }[])[0]!.text;
  return { result: parseToolResult<Result>(raw), text, bodies };
}

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('concur_healthcheck', () => {
  it('probes with a read-only document', () => {
    expect(isReadOnlyGraphqlDocument(HEALTHCHECK_QUERY)).toBe(true);
  });

  it('is registered, read-only, and searchable', async () => {
    const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT }) });
    harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
    const tools = await harness.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'concur_healthcheck');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.description).toMatch(/www-us2\.api\.concursolutions\.com/);
  });

  it('reports the credential source + minutes to expiry and probes with the real userId', async () => {
    const { result, text, bodies } = await run({ responses: [ok({ employee: { userId: SUB } })] });
    expect(result.ok).toBe(true);
    expect(result.credential).toEqual({
      source: 'browser session cookie (ContextMint Bridge)',
      resolved: true,
      detail: { datacenter: 'us2', expires_in_minutes: 30, legacy_session_cookie: false },
    });
    expect(result.probe.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/graphql');
    expect(bodies[0]).toEqual({ query: HEALTHCHECK_QUERY, variables: { userId: SUB, contextRole: 'TRAVELER' } });
    expect(text).not.toContain(JWT);
  });

  it('says whether the legacy OTSESSION cookie was found, never its value', async () => {
    const client = new ConcurClient({
      env: {},
      readCookies: async () => ({ JWT, OTSESSIONAABQRD: 'otsd-SECRET' }),
      now: () => NOW * 1000,
      fetchImpl: (async () => ok({ employee: { userId: SUB } })) as unknown as typeof fetch,
    });
    harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
    const raw = await harness.callTool('concur_healthcheck');
    const text = (raw.content as { text: string }[])[0]!.text;
    expect(parseToolResult<Result>(raw).credential.detail).toMatchObject({ legacy_session_cookie: true });
    expect(text).not.toContain('otsd-SECRET');
  });

  it('a probe that returns no employee is a failure', async () => {
    const { result } = await run({ responses: [ok({ employee: null })] });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/no employee/);
  });

  it('no session cookie → not ok, with the sign-in hint and no probe', async () => {
    const { result, bodies } = await run({ readJwt: async () => undefined });
    expect(result.ok).toBe(false);
    expect(result.credential.resolved).toBe(false);
    expect(result.error?.kind).toBe('no_credential');
    expect(result.hint).toBe(
      'Open and sign in to https://us2.concursolutions.com in the browser running ContextMint Bridge, then retry.',
    );
    expect(bodies).toHaveLength(0);
  });

  it('a hinted fetchproxy error (pairing pending) keeps its own remedy', async () => {
    const { result } = await run({
      readJwt: async () => {
        throw Object.assign(new Error('pairing required — pair code 123-456'), {
          name: 'FetchproxySessionNotReadyError',
          hint: 'Approve pair code 123-456 in the ContextMint Bridge popup.',
        });
      },
    });
    expect(result.error?.kind).toBe('bridge');
    expect(result.error?.detail).toEqual({ error: 'FetchproxySessionNotReadyError' });
    expect(result.hint).toBe('Approve pair code 123-456 in the ContextMint Bridge popup.');
  });

  it('an unclassified bridge failure → bridge arm with the sign-in hint', async () => {
    const { result } = await run({
      readJwt: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(result.error?.kind).toBe('bridge');
    expect(result.hint).toContain('ContextMint Bridge');
  });

  it('a datacenter mismatch → config arm naming the fix', async () => {
    const { result } = await run({ readJwt: async () => fakeJwt(goodClaims(NOW + 3600, 'eu2')) });
    expect(result.error?.kind).toBe('config');
    expect(result.hint).toMatch(/CONCUR_DC=eu2/);
  });

  it('an invalid CONCUR_DC → config arm (the server still registered the tool)', async () => {
    const { result } = await run({ env: { CONCUR_DC: 'nope.example' } });
    expect(result.error?.kind).toBe('config');
    expect(result.hint).toMatch(/CONCUR_DC/);
  });

  it('a 401 that survives the re-lift → no_credential with the sign-in hint, no token in the text', async () => {
    const r401 = () => new Response('<html>401</html>', { status: 401 });
    const { result, text } = await run({ responses: [r401(), r401()] });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('no_credential');
    expect(result.hint).toContain('sign in to https://us2.concursolutions.com');
    expect(text).not.toContain(JWT);
  });

  it('other probe failures fall through to the library arms', async () => {
    const { result } = await run({ responses: [new Response('boom', { status: 500 })] });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('http');
  });
});

describe('registerHealthcheckTool wiring', () => {
  it('does not resolve a credential at registration (deferred)', async () => {
    const readJwt = vi.fn(async () => ({ JWT }));
    const client = new ConcurClient({ env: {}, readCookies: readJwt });
    harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
    expect(readJwt).not.toHaveBeenCalled();
  });
});
