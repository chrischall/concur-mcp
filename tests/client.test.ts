import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpToolError, SessionNotAuthenticatedError, UpstreamHttpError } from '@chrischall/mcp-utils';
import { GraphqlResponseError, GraphqlTransportError } from '@chrischall/mcp-utils/graphql';
import { ConcurClient, warningsField, warningsOf } from '../src/client.js';
import { ConcurConfigError } from '../src/config.js';
import { ConcurDatacenterError, ConcurSessionError, JwtSession } from '../src/session.js';
import type { SessionCookies } from '../src/transport.js';
import { NOW, SUB, fakeJwt, goodClaims } from './helpers.js';

const JWT1 = fakeJwt(goodClaims(NOW + 3600));
const JWT2 = fakeJwt({ ...goodClaims(NOW + 3600), jti: 'second' });
const SECRETS = [JWT1, JWT2];

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const html401 = () => new Response('<html><body>401 Unauthorized</body></html>', { status: 401, headers: { 'content-type': 'text/html' } });

/** Each lift answers the next entry: a JWT string (no OTSESSION cookies), undefined (no cookies), or a cookie map. */
type Lift = string | undefined | SessionCookies;

function harness(responses: Array<Response | Error | ((call: Call) => Response)>, jwts: Lift[] = [JWT1]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = {
      url: String(input),
      init,
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  });
  let i = 0;
  const readJwt = vi.fn(async (): Promise<SessionCookies> => {
    const next = jwts[Math.min(i++, jwts.length - 1)];
    return typeof next === 'string' ? { JWT: next } : (next ?? {});
  });
  const client = new ConcurClient({
    env: {},
    readCookies: readJwt,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW * 1000,
    correlationId: () => `corr-${calls.length + 1}`,
  });
  return { client, calls, fetchImpl, readJwt };
}

function expectNoSecret(err: unknown) {
  const text = `${(err as Error).message}\n${(err as McpToolError).hint ?? ''}`;
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConcurClient.spend / cds', () => {
  it('POSTs to the spend endpoint with Bearer auth and a fresh correlation id', async () => {
    const { client, calls } = harness([json(200, { data: { a: 1 } }), json(200, { data: { b: 2 } })]);
    await expect(client.spend('query A { a }', { x: 1 })).resolves.toEqual({ a: 1 });
    await expect(client.spend('query B { b }')).resolves.toEqual({ b: 2 });
    expect(calls[0]!.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/graphql');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${JWT1}`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['concur-correlationid']).toBe('corr-1');
    expect(calls[1]!.headers['concur-correlationid']).toBe('corr-2');
    expect(calls[0]!.body).toEqual({ query: 'query A { a }', variables: { x: 1 } });
  });

  it('cds() targets the CDS endpoint', async () => {
    const { client, calls } = harness([json(200, { data: { travel: {} } })]);
    await client.cds('query T { travel { x } }', {});
    expect(calls[0]!.url).toBe('https://www-us2.api.concursolutions.com/cds/graphql');
  });

  it('userId() is the JWT sub, and the cookie is lifted once across calls', async () => {
    const { client, readJwt } = harness([json(200, { data: { a: 1 } })]);
    await expect(client.userId()).resolves.toBe(SUB);
    await client.spend('query A { a }');
    expect(readJwt).toHaveBeenCalledTimes(1);
  });

  it('on 401 re-lifts the cookie and replays exactly once', async () => {
    const { client, calls, readJwt } = harness([html401(), json(200, { data: { ok: true } })], [JWT1, JWT2]);
    await expect(client.spend('query A { ok }')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(readJwt).toHaveBeenCalledTimes(2);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${JWT1}`);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${JWT2}`);
  });

  it('if the session was invalidated mid-flight, sends no stale header and recovers via the 401 replay', async () => {
    const peek = vi.spyOn(JwtSession.prototype, 'peek').mockReturnValueOnce(undefined);
    const { client, calls } = harness([html401(), json(200, { data: { ok: true } })], [JWT1, JWT2]);
    await expect(client.spend('query A { ok }')).resolves.toEqual({ ok: true });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${JWT2}`);
    peek.mockRestore();
  });

  it('a second 401 is a session error — never a loop', async () => {
    const { client, calls, readJwt } = harness([html401(), html401(), json(200, { data: {} })], [JWT1, JWT2]);
    const err = await client.spend('query A { a }').catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect(readJwt).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as Error).message).toMatch(/rejected/);
    expectNoSecret(err);
  });

  it('a mutation is replayed once on 401 too (it was refused, not run)', async () => {
    const { client, calls } = harness([html401(), json(200, { data: { m: 1 } })], [JWT1, JWT2]);
    await expect(client.spend('mutation M { m }')).resolves.toEqual({ m: 1 });
    expect(calls).toHaveLength(2);
  });

  it('maps errors[] on a 200 to a failure carrying dataSource, response status and correlationId', async () => {
    const { client } = harness([
      json(200, {
        data: { employee: null },
        errors: [
          {
            message: 'An error occurred',
            path: ['employee', 'reportsForUser'],
            extensions: { dataSource: 'ExpenseReportService', response: { status: 400 }, correlationId: 'abc-123' },
          },
          { message: 'Second' },
          {},
        ],
      }),
    ]);
    const err = await client.spend('query A { a }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlResponseError);
    const message = (err as Error).message;
    expect(message).toContain('An error occurred at employee.reportsForUser');
    expect(message).toContain('dataSource=ExpenseReportService');
    expect(message).toContain('status=400');
    expect(message).toContain('correlationId=abc-123');
    expect(message).toContain('Second');
    expect(message).toContain('Unknown error');
    expect((err as GraphqlResponseError).errors).toHaveLength(3);
    expect((err as McpToolError).hint).toMatch(/correlationId/);
  });

  it('a 200 with no data and no errors is an empty-response error', async () => {
    const { client } = harness([json(200, { data: null }), json(200, {})]);
    await expect(client.spend('query A { a }')).rejects.toThrow(/empty response/);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it('a JSON non-2xx without errors[] stays an upstream HTTP error', async () => {
    const { client } = harness([json(500, { message: 'boom' })]);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  it('errors[] beside a 401 is still treated as auth', async () => {
    const body = { errors: [{ message: 'nope' }] };
    const { client } = harness([json(401, body), json(401, body)], [JWT1, JWT2]);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(ConcurSessionError);
  });

  it('a network failure on a write says the outcome is unknown', async () => {
    const { client } = harness([new TypeError('fetch failed')]);
    const err = await client.spend('mutation M { m }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlTransportError);
    expect((err as GraphqlTransportError).outcomeUnknown).toBe(true);
  });

  it('a session failure is NOT reported as a transport error', async () => {
    const { client, calls } = harness([], [undefined]);
    const err = await client.spend('mutation M { m }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect(calls).toHaveLength(0);
  });

  it('a DC/iss mismatch surfaces before any request', async () => {
    const { client, calls } = harness([], [fakeJwt(goodClaims(NOW + 3600, 'eu2'))]);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(ConcurDatacenterError);
    expect(calls).toHaveLength(0);
  });
});

const OTD = 'otsd-SECRET-value';
const OTN = 'otsn-SECRET-value';
const COOKIES1: SessionCookies = { JWT: JWT1, OTSESSIONAABQRD: OTD, OTSESSIONAABQRN: OTN };
const COOKIES2: SessionCookies = { JWT: JWT2, OTSESSIONAABQRD: 'otsd-second', OTSESSIONAABQRN: 'otsn-second' };

/** A legacy-backed field failing for want of the OTSESSION cookie: a 200 with EMPTY extensions. */
const staleField = (data: unknown = { employee: { userId: SUB, rptKey: null } }) =>
  json(200, { data, errors: [{ message: 'An error occurred', path: ['employee', 'rptKey'], extensions: {} }] });

function expectNoCookie(err: unknown) {
  const text = `${(err as Error).message}\n${(err as McpToolError).hint ?? ''}`;
  for (const secret of [OTD, OTN, 'otsd-second', 'otsn-second', JWT1, JWT2]) expect(text).not.toContain(secret);
}

describe('legacy OTSESSION cookies', () => {
  it('sends them as a Cookie header beside the Bearer on spend and cds', async () => {
    const { client, calls } = harness([json(200, { data: { a: 1 } }), json(200, { data: { b: 1 } })], [COOKIES1]);
    await client.spend('query A { a }');
    await client.cds('query B { b }');
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${JWT1}`);
      expect(call.headers.cookie).toBe(`OTSESSIONAABQRD=${OTD}; OTSESSIONAABQRN=${OTN}`);
    }
  });

  it('sends only the one the browser had, and no Cookie header when it had neither', async () => {
    const one = harness([json(200, { data: { a: 1 } })], [{ JWT: JWT1, OTSESSIONAABQRN: OTN }]);
    await one.client.spend('query A { a }');
    expect(one.calls[0]!.headers.cookie).toBe(`OTSESSIONAABQRN=${OTN}`);
    const none = harness([json(200, { data: { a: 1 } })], [JWT1]);
    await none.client.spend('query A { a }');
    expect(none.calls[0]!.headers.cookie).toBeUndefined();
  });

  it('sends them on a receipt upload and a Concur-hosted download, never to another host', async () => {
    const png = new Uint8Array([1, 2, 3]);
    const { client, calls } = harness(
      [json(202, { imageId: 'I', id: 'D' }), new Response(png, { status: 200 }), new Response(png, { status: 200 })],
      [COOKIES1],
    );
    await client.upload({ data: png, filename: 'r.png', contentType: 'image/png' });
    await client.download('https://us2.concursolutions.com/img', { maxBytes: 100 });
    await client.download('https://receipts.s3.amazonaws.com/img', { maxBytes: 100 });
    expect(calls[0]!.headers.cookie).toBe(`OTSESSIONAABQRD=${OTD}; OTSESSIONAABQRN=${OTN}`);
    expect(calls[1]!.headers.cookie).toBe(`OTSESSIONAABQRD=${OTD}; OTSESSIONAABQRN=${OTN}`);
    expect(calls[2]!.headers.cookie).toBeUndefined();
  });

  it('a 401 re-lift picks up fresh OTSESSION cookies too', async () => {
    const { client, calls } = harness([html401(), json(200, { data: { ok: true } })], [COOKIES1, COOKIES2]);
    await client.spend('query A { ok }');
    expect(calls[1]!.headers.cookie).toBe('OTSESSIONAABQRD=otsd-second; OTSESSIONAABQRN=otsn-second');
  });

  it('an empty-extensions field error on a read → ONE re-lift and replay with the fresh cookies', async () => {
    const { client, calls, readJwt } = harness(
      [staleField(), json(200, { data: { employee: { userId: SUB, rptKey: '42' } } })],
      [COOKIES1, COOKIES2],
    );
    await client.userId(); // the session is already cached when the call starts
    await expect(client.spend('query A { employee { userId rptKey } }')).resolves.toEqual({
      employee: { userId: SUB, rptKey: '42' },
    });
    expect(calls).toHaveLength(2);
    expect(readJwt).toHaveBeenCalledTimes(2);
    expect(calls[1]!.headers.cookie).toBe('OTSESSIONAABQRD=otsd-second; OTSESSIONAABQRN=otsn-second');
  });

  it('never loops: a second empty-extensions answer is not replayed again', async () => {
    const { client, calls, readJwt } = harness([staleField(null), staleField(null), staleField(null)], [COOKIES1, COOKIES2]);
    await client.userId();
    const err = await client.spend('query A { employee { rptKey } }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect(calls).toHaveLength(2);
    expect(readJwt).toHaveBeenCalledTimes(2);
    expectNoCookie(err);
  });

  it('no replay when the session was freshly lifted for this very call', async () => {
    const { client, calls, readJwt } = harness([staleField(null)], [COOKIES1, COOKIES2]);
    await expect(client.spend('query A { employee { rptKey } }')).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(calls).toHaveLength(1);
    expect(readJwt).toHaveBeenCalledTimes(1);
  });

  it('no stale-cookie replay after a 401 re-lift either (that lift was fresh)', async () => {
    const { client, calls } = harness([html401(), staleField(null)], [COOKIES1, COOKIES2]);
    await client.userId();
    await expect(client.spend('query A { employee { rptKey } }')).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(calls).toHaveLength(2);
  });

  it('a write is never replayed on the stale-cookie signature, but the next call lifts fresh', async () => {
    const { client, calls, readJwt } = harness(
      [staleField({ createReport: null }), json(200, { data: { a: 1 } })],
      [COOKIES1, COOKIES2],
    );
    await client.userId();
    await expect(client.spend('mutation M { createReport { reportId } }')).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(calls).toHaveLength(1);
    await client.spend('query A { a }');
    expect(readJwt).toHaveBeenCalledTimes(2);
    expect(calls[1]!.headers.cookie).toBe('OTSESSIONAABQRD=otsd-second; OTSESSIONAABQRN=otsn-second');
  });

  it('errors that carry extensions (or none at all) are not the stale-cookie signature', async () => {
    const { client, calls } = harness(
      [
        json(200, { data: null, errors: [{ message: 'x', extensions: { correlationId: 'c' } }] }),
        json(200, { data: null, errors: [{ message: 'y' }] }),
      ],
      [COOKIES1, COOKIES2],
    );
    await client.userId();
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(GraphqlResponseError);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(GraphqlResponseError);
    expect(calls).toHaveLength(2);
  });

  it('never puts a cookie value in error text, even when Concur echoes it', async () => {
    const echo = `OTSESSIONAABQRD=${OTD}; OTSESSIONAABQRN=${OTN}`;
    const { client } = harness(
      [
        json(200, { data: null, errors: [{ message: `bad session ${echo} / ${OTD}`, extensions: { correlationId: 'c' } }] }),
        new Response(`rejected ${echo} and raw ${OTN}`, { status: 400 }),
        new Response(`nope ${echo}`, { status: 500 }),
        new TypeError(`socket hang up (${echo})`),
      ],
      [COOKIES1],
    );
    const errors = [
      await client.spend('query A { a }').catch((e: unknown) => e),
      await client.upload({ data: new Uint8Array([1]), filename: 'r.png', contentType: 'image/png' }).catch((e: unknown) => e),
      await client.download('https://us2.concursolutions.com/img', { maxBytes: 10 }).catch((e: unknown) => e),
      await client.spend('query B { b }').catch((e: unknown) => e),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expectNoCookie(err);
    }
  });
});

describe('partial GraphQL errors', () => {
  const partial = (data: unknown, errors: unknown[]) => json(200, { data, errors });
  const fieldError = (path: string[], extensions: Record<string, unknown> = { correlationId: 'corr-x', dataSource: 'Legacy' }) => ({
    message: 'An error occurred',
    path,
    extensions,
  });

  it('valid data plus errors[] for one sub-field returns the data, with the error as a warning', async () => {
    const data = { employee: { userId: SUB, reportsForUser: { list: [{ name: 'Trip', rptKey: null }] } } };
    const { client } = harness([partial(data, [fieldError(['employee', 'reportsForUser', 'list', 0, 'rptKey'])])]);
    const out = await client.spend('query A { a }');
    expect(out).toEqual(data);
    expect(warningsOf(out)).toEqual([
      { path: 'employee.reportsForUser.list.0.rptKey', message: 'An error occurred', correlationId: 'corr-x' },
    ]);
    expect(warningsField(out)).toEqual({ warnings: warningsOf(out) });
  });

  it('a warning without a path, message or correlationId still reads', async () => {
    const { client } = harness([partial({ a: 1 }, [{ extensions: { dataSource: 'X' } }])]);
    const out = await client.cds('query A { a }');
    expect(warningsOf(out)).toEqual([{ path: '', message: 'Unknown error' }]);
  });

  it('data without errors carries no warnings', async () => {
    const { client } = harness([json(200, { data: { a: 1 } })]);
    const out = await client.spend('query A { a }');
    expect(warningsOf(out)).toEqual([]);
    expect(warningsField(out)).toEqual({});
    expect(warningsOf(null)).toEqual([]);
    expect(warningsOf('text')).toEqual([]);
  });

  it('throws (with the mapped detail) when every root field is null', async () => {
    const { client } = harness([partial({ employee: null, other: null }, [fieldError(['employee'])])]);
    const err = await client.spend('query A { a }').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect((err as Error).message).toContain('correlationId=corr-x');
  });

  it('throws when an essential path is null, even though other roots answered', async () => {
    const data = { employee: { expenseReport: null }, reportExceptions: { countOfExceptions: 0 } };
    const { client } = harness([partial(data, [fieldError(['employee', 'expenseReport'])]), partial(data, [fieldError(['x'])])]);
    const err = await client
      .spend('query A { a }', {}, { essential: ['employee.expenseReport'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphqlResponseError);
    expect((err as Error).message).toContain('at employee.expenseReport');
    // a missing intermediate object counts as null too
    await expect(client.spend('query A { a }', {}, { essential: ['employee.expenseReport.reportDetails'] })).rejects.toBeInstanceOf(
      GraphqlResponseError,
    );
  });

  it('returns the data when every essential path is present', async () => {
    const data = { employee: { expenseReport: { reportDetails: { name: 'R' }, rptKey: null } } };
    const { client } = harness([partial(data, [fieldError(['employee', 'expenseReport', 'rptKey'])])]);
    const out = await client.spend('query A { a }', {}, { essential: ['employee.expenseReport.reportDetails'] });
    expect(out).toEqual(data);
    expect(warningsOf(out)).toHaveLength(1);
  });

  it('an HTTP error status with data still throws', async () => {
    const { client } = harness([json(400, { data: { a: 1 }, errors: [fieldError(['a'])] })]);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it('an auth-coded error beside data is not downgraded to a warning', async () => {
    const body = { data: { a: 1 }, errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] };
    const { client } = harness([json(200, body), json(200, body)], [JWT1, JWT2]);
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(GraphqlResponseError);
  });

  it('never puts a cookie value in a warning', async () => {
    const { client } = harness([partial({ a: 1 }, [{ message: `bad OTSESSIONAABQRD=${OTD} raw ${OTN}`, path: ['b'], extensions: {} }])], [
      COOKIES1,
    ]);
    const out = await client.spend('mutation M { a }');
    const text = JSON.stringify(warningsOf(out));
    expect(text).not.toContain(OTD);
    expect(text).not.toContain(OTN);
  });
});

describe('secret scrubbing', () => {
  it('scrubs a cookie pair out of a hinted bridge error it otherwise passes through untouched', async () => {
    const bridgeErr = Object.assign(new Error('pairing required'), {
      name: 'FetchproxySessionNotReadyError',
      hint: 'Stale grant for OTSESSIONAABQRD=leaked-value; re-approve in ContextMint Bridge.',
    });
    const client = new ConcurClient({
      env: {},
      readCookies: async () => {
        throw bridgeErr;
      },
    });
    const err = await client.spend('query A { a }').catch((e: unknown) => e);
    expect(err).toBe(bridgeErr);
    expect((err as McpToolError).hint).toBe('Stale grant for OTSESSIONAABQRD=[REDACTED]; re-approve in ContextMint Bridge.');
  });
});

describe('deferred config error', () => {
  it('constructs without throwing, then every call throws the config error', async () => {
    const readJwt = vi.fn(async () => ({ JWT: JWT1 }));
    const client = new ConcurClient({ env: { CONCUR_DC: 'bad.host' }, readCookies: readJwt });
    expect(client.hostLabel).toBe('www-us2.api.concursolutions.com');
    await expect(client.spend('query A { a }')).rejects.toBeInstanceOf(ConcurConfigError);
    await expect(client.cds('query A { a }')).rejects.toBeInstanceOf(ConcurConfigError);
    await expect(client.userId()).rejects.toBeInstanceOf(ConcurConfigError);
    await expect(client.session()).rejects.toBeInstanceOf(ConcurConfigError);
    await expect(
      client.upload({ data: new Uint8Array([1]), filename: 'r.png', contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(ConcurConfigError);
    expect(readJwt).not.toHaveBeenCalled();
  });

  it('hostLabel follows CONCUR_DC', () => {
    const client = new ConcurClient({ env: { CONCUR_DC: 'eu2' }, readCookies: async () => ({}) });
    expect(client.hostLabel).toBe('www-eu2.api.concursolutions.com');
  });
});

describe('receiver-safe default fetch', () => {
  it('calls the global fetch with an unbound receiver', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(function (this: unknown) {
        seen.push(this);
        return Promise.resolve(json(200, { data: { a: 1 } }));
      }),
    );
    const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT: JWT1 }), now: () => NOW * 1000 });
    await expect(client.spend('query A { a }')).resolves.toEqual({ a: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeInstanceOf(ConcurClient);
  });

  it('honours a custom timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { a: 1 } })));
    const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT: JWT1 }), now: () => NOW * 1000, timeoutMs: 5_000 });
    await expect(client.spend('query A { a }')).resolves.toEqual({ a: 1 });
  });

  it('defaults the correlation id to a UUID and the clock to Date.now', async () => {
    let header: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        header = new Headers(init.headers).get('concur-correlationid');
        return json(200, { data: { a: 1 } });
      }),
    );
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT: fakeJwt(goodClaims(exp)) }) });
    await client.spend('query A { a }');
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ConcurClient.upload', () => {
  const file = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), filename: 'receipt.png', contentType: 'image/png' };

  it('POSTs multipart with one `file` part and returns {imageId, id} on 202', async () => {
    const { client, calls } = harness([json(202, { imageId: 'IMG1', id: 'ID1', extra: true })]);
    await expect(client.upload(file, { isExpenseItUpload: 'true' })).resolves.toEqual({ imageId: 'IMG1', id: 'ID1' });
    const call = calls[0]!;
    expect(call.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/upload?isExpenseItUpload=true');
    expect(call.init.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${JWT1}`);
    expect(call.headers['concur-correlationid']).toBe('corr-1');
    expect(call.headers['content-type']).toBeUndefined(); // fetch sets the multipart boundary
    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get('file') as File;
    expect(part.name).toBe('receipt.png');
    expect(part.type).toBe('image/png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(file.data);
  });

  it('accepts a Blob as-is', async () => {
    const { client, calls } = harness([json(202, { imageId: 'I', id: 'D' })]);
    await client.upload({ data: new Blob(['%PDF-'], { type: 'application/pdf' }), filename: 'r.pdf', contentType: 'application/pdf' });
    expect(calls[0]!.url).toBe('https://www-us2.api.concursolutions.com/spend-graphql/upload');
    expect(((calls[0]!.init.body as FormData).get('file') as File).name).toBe('r.pdf');
  });

  it('a 200 (not 202) is a failure', async () => {
    const { client } = harness([json(200, { imageId: 'I', id: 'D' })]);
    const err = await client.upload(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).status).toBe(200);
  });

  it('a 4xx/5xx is an upstream error and does not echo the token', async () => {
    const { client } = harness([new Response(`bad request for Bearer ${JWT1}`, { status: 400 })]);
    const err = await client.upload(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).status).toBe(400);
    expectNoSecret(err);
  });

  it('a 202 without ids is an error that points at the receipt list', async () => {
    const { client } = harness([new Response('accepted', { status: 202 })]);
    const err = await client.upload(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/did not return an image id/);
  });

  it('a 202 with non-string ids is an error', async () => {
    const { client } = harness([json(202, { imageId: 1, id: 'x' })]);
    await expect(client.upload(file)).rejects.toThrow(/did not return an image id/);
  });

  it('401 → one re-lift + replay', async () => {
    const { client, calls } = harness([html401(), json(202, { imageId: 'I', id: 'D' })], [JWT1, JWT2]);
    await expect(client.upload(file)).resolves.toEqual({ imageId: 'I', id: 'D' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${JWT2}`);
  });

  it('401 twice → session error, exactly two attempts', async () => {
    const { client, calls } = harness([html401(), html401(), json(202, {})], [JWT1, JWT2]);
    const err = await client.upload(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect(calls).toHaveLength(2);
    expectNoSecret(err);
  });

  it('a network failure says the outcome is unknown, without the token', async () => {
    const { client } = harness([new TypeError(`fetch failed (Authorization: Bearer ${JWT1})`)]);
    const err = await client.upload(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/outcome is unknown/);
    expectNoSecret(err);
  });

  it('a caller cancellation is rethrown untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const { client } = harness([abort]);
    await expect(client.upload(file)).rejects.toBe(abort);
  });
});

describe('ConcurClient.download', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const bin = (bytes: Uint8Array, status = 200, type = 'image/png') =>
    new Response(bytes, { status, headers: { 'content-type': type } });

  it('GETs a Concur-hosted URL with the Bearer token and returns the bytes + content type', async () => {
    const { client, calls } = harness([bin(png)]);
    const url = 'https://www-us2.api.concursolutions.com/receipts/IMG1?sig=abc';
    await expect(client.download(url, { maxBytes: 1000 })).resolves.toEqual({ bytes: png, contentType: 'image/png' });
    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${JWT1}`);
    expect(calls[0]!.headers['concur-correlationid']).toBe('corr-1');
  });

  it('resolves a relative URL against the API host', async () => {
    const { client, calls } = harness([bin(png)]);
    await client.download('/receipt/image/IMG1', { maxBytes: 1000 });
    expect(calls[0]!.url).toBe('https://www-us2.api.concursolutions.com/receipt/image/IMG1');
  });

  it('never sends the token to a host outside concursolutions.com (a presigned URL)', async () => {
    const { client, calls } = harness([bin(png)]);
    await client.download('https://receipts.s3.amazonaws.com/IMG1?X-Amz-Signature=x', { maxBytes: 1000 });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['concur-correlationid']).toBeUndefined();
  });

  it('a look-alike host is not Concur', async () => {
    const { client, calls } = harness([bin(png)]);
    await client.download('https://evilconcursolutions.com/x', { maxBytes: 1000 });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('refuses a non-https URL before fetching', async () => {
    const { client, calls } = harness([]);
    await expect(client.download('http://www-us2.api.concursolutions.com/x', { maxBytes: 1000 })).rejects.toThrow(/https/);
    await expect(client.download('file:///etc/passwd', { maxBytes: 1000 })).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it('401 on a Concur host → one re-lift + replay', async () => {
    const { client, calls } = harness([html401(), bin(png)], [JWT1, JWT2]);
    await expect(client.download('https://us2.concursolutions.com/img', { maxBytes: 1000 })).resolves.toMatchObject({ bytes: png });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${JWT2}`);
  });

  it('401 twice → session error, without the token', async () => {
    const { client, calls } = harness([html401(), html401()], [JWT1, JWT2]);
    const err = await client.download('https://us2.concursolutions.com/img', { maxBytes: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect(calls).toHaveLength(2);
    expectNoSecret(err);
  });

  it('a non-2xx is an upstream error', async () => {
    const { client } = harness([new Response('gone', { status: 404 })]);
    const err = await client.download('https://us2.concursolutions.com/img', { maxBytes: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).status).toBe(404);
  });

  it('refuses a body over maxBytes (declared or streamed)', async () => {
    const declared = new Response(png, { status: 200, headers: { 'content-length': '5000' } });
    const { client } = harness([declared, bin(png)]);
    await expect(client.download('https://us2.concursolutions.com/a', { maxBytes: 100 })).rejects.toThrow(/larger than/);
    await expect(client.download('https://us2.concursolutions.com/b', { maxBytes: 5 })).rejects.toThrow(/larger than/);
  });

  it('an empty body is zero bytes', async () => {
    const { client } = harness([new Response(null, { status: 200 })]);
    const out = await client.download('https://us2.concursolutions.com/a', { maxBytes: 1000 });
    expect(out.bytes.byteLength).toBe(0);
  });

  it('a non-2xx whose body cannot be read is still an upstream error', async () => {
    const broken = new ReadableStream({ start: (c) => c.error(new Error('reset')) });
    const { client } = harness([new Response(broken, { status: 502 })]);
    const err = await client.download('https://us2.concursolutions.com/a', { maxBytes: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect((err as UpstreamHttpError).status).toBe(502);
  });

  it('a missing content type is undefined', async () => {
    const res = new Response(png, { status: 200 });
    res.headers.delete('content-type');
    const { client } = harness([res]);
    const out = await client.download('https://us2.concursolutions.com/a', { maxBytes: 1000 });
    expect(out.contentType).toBeUndefined();
  });

  it('a network failure is an actionable error without the token', async () => {
    const { client } = harness([new TypeError(`fetch failed (Bearer ${JWT1})`)]);
    const err = await client.download('https://us2.concursolutions.com/a', { maxBytes: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expectNoSecret(err);
  });

  it('a caller cancellation is rethrown untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const { client } = harness([abort]);
    await expect(client.download('https://us2.concursolutions.com/a', { maxBytes: 1000 })).rejects.toBe(abort);
  });
});
