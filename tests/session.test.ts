import { describe, expect, it, vi } from 'vitest';
import { McpToolError, SessionNotAuthenticatedError } from '@chrischall/mcp-utils';
import { configForDc } from '../src/config.js';
import { ConcurBridgeError, ConcurDatacenterError, ConcurSessionError, JwtSession, signInHint } from '../src/session.js';
import { NOW, SUB, fakeJwt, goodClaims } from './helpers.js';


/** A session over a JWT-only reader (the OTSESSION cookies absent). */
function sessionWith(readJwt: (dc: string) => Promise<string | undefined>, now = () => NOW * 1000) {
  return new JwtSession({
    config: configForDc('us2'),
    readCookies: async (dc) => {
      const jwt = await readJwt(dc);
      return jwt === undefined ? {} : { JWT: jwt };
    },
    now,
  });
}

describe('JwtSession', () => {
  it('lifts the JWT, decodes sub/exp, and caches it while outside the skew window', async () => {
    const jwt = fakeJwt(goodClaims());
    const readJwt = vi.fn(async () => jwt);
    const session = sessionWith(readJwt);
    const info = await session.get();
    expect(info).toEqual({ jwt, userId: SUB, exp: NOW + 3600, dc: 'us2' });
    await session.get();
    expect(readJwt).toHaveBeenCalledTimes(1);
    expect(readJwt).toHaveBeenCalledWith('us2');
    expect(session.peek()).toEqual(info);
  });

  it('lifts the OTSESSION cookies with the JWT, as one Cookie header of the present ones', async () => {
    const jwt = fakeJwt(goodClaims());
    const readCookies = vi.fn(async () => ({ JWT: jwt, OTSESSIONAABQRD: 'dee', OTSESSIONAABQRN: 'enn', other: 'x' }));
    const session = new JwtSession({ config: configForDc('us2'), readCookies, now: () => NOW * 1000 });
    const info = await session.get();
    expect(info.legacyCookie).toBe('OTSESSIONAABQRD=dee; OTSESSIONAABQRN=enn');
    expect(readCookies).toHaveBeenCalledTimes(1);
    expect(readCookies).toHaveBeenCalledWith('us2');
  });

  it('sends whichever OTSESSION cookie is present, and none when neither is', async () => {
    const jwt = fakeJwt(goodClaims());
    const only = new JwtSession({ config: configForDc('us2'), readCookies: async () => ({ JWT: jwt, OTSESSIONAABQRN: 'enn' }), now: () => NOW * 1000 });
    expect((await only.get()).legacyCookie).toBe('OTSESSIONAABQRN=enn');
    const none = new JwtSession({ config: configForDc('us2'), readCookies: async () => ({ JWT: jwt }), now: () => NOW * 1000 });
    expect((await none.get()).legacyCookie).toBeUndefined();
  });

  it('OTSESSION cookies without a JWT are still "not signed in"', async () => {
    const session = new JwtSession({ config: configForDc('us2'), readCookies: async () => ({ OTSESSIONAABQRD: 'dee' }), now: () => NOW * 1000 });
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect((err as Error).message).not.toContain('dee');
  });

  it('generation counts completed lifts (not cache hits)', async () => {
    const session = sessionWith(async () => fakeJwt(goodClaims()));
    expect(session.generation).toBe(0);
    await session.get();
    await session.get();
    expect(session.generation).toBe(1);
    session.invalidate();
    await session.get();
    expect(session.generation).toBe(2);
  });

  it('recent() keeps the current and previous session (for redaction), even after invalidate()', async () => {
    const first = fakeJwt(goodClaims());
    const second = fakeJwt({ ...goodClaims(), jti: '2' });
    const third = fakeJwt({ ...goodClaims(), jti: '3' });
    const readJwt = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
    const session = sessionWith(readJwt);
    expect(session.recent()).toEqual([]);
    await session.get();
    session.invalidate();
    await session.get();
    session.invalidate();
    expect(session.recent().map((s) => s.jwt)).toEqual([second, first]);
    await session.get();
    expect(session.recent().map((s) => s.jwt)).toEqual([third, second]);
  });

  it('re-lifts when within 120 s of exp', async () => {
    let now = NOW * 1000;
    const first = fakeJwt(goodClaims(NOW + 3600));
    const second = fakeJwt(goodClaims(NOW + 7200));
    const readJwt = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const session = sessionWith(readJwt, () => now);
    expect((await session.get()).jwt).toBe(first);
    now = (NOW + 3600 - 121) * 1000; // 121 s left: still cached
    expect((await session.get()).jwt).toBe(first);
    now = (NOW + 3600 - 120) * 1000; // 120 s left: inside the skew
    expect((await session.get()).jwt).toBe(second);
    expect(readJwt).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent lifts', async () => {
    let release!: (v: string) => void;
    const readJwt = vi.fn(() => new Promise<string>((r) => (release = r)));
    const session = sessionWith(readJwt);
    const all = Promise.all([session.get(), session.get(), session.get()]);
    release(fakeJwt(goodClaims()));
    const results = await all;
    expect(readJwt).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.jwt)).size).toBe(1);
    // and a later lift is a fresh flight
    session.invalidate();
    const again = session.get();
    release(fakeJwt(goodClaims()));
    await again;
    expect(readJwt).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next get() to re-lift', async () => {
    const readJwt = vi.fn(async () => fakeJwt(goodClaims()));
    const session = sessionWith(readJwt);
    await session.get();
    session.invalidate();
    expect(session.peek()).toBeUndefined();
    await session.get();
    expect(readJwt).toHaveBeenCalledTimes(2);
  });

  it('no cookie → SessionNotAuthenticatedError with the sign-in hint', async () => {
    const session = sessionWith(async () => undefined);
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as McpToolError).hint).toBe(
      'Open and sign in to https://us2.concursolutions.com in the browser running ContextMint Bridge, then retry.',
    );
    expect(signInHint('https://x')).toContain('https://x');
    expect((err as Error).message).toMatch(/no Concur session cookie/);
    expect((err as Error).name).toBe('SessionNotAuthenticatedError');
  });

  it('an expired cookie → SessionNotAuthenticatedError, and nothing is cached', async () => {
    const jwt = fakeJwt(goodClaims(NOW - 1));
    const session = sessionWith(async () => jwt);
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect((err as Error).message).toMatch(/expired/);
    expect((err as Error).message).not.toContain(jwt);
    expect(session.peek()).toBeUndefined();
  });

  it.each([
    ['not a JWT', 'garbage'],
    ['no sub', fakeJwt({ ...goodClaims(), sub: undefined })],
    ['empty sub', fakeJwt({ ...goodClaims(), sub: '' })],
    ['no exp', fakeJwt({ ...goodClaims(), exp: 'soon' })],
  ])('an undecodable cookie (%s) → SessionNotAuthenticatedError without echoing it', async (_label, jwt) => {
    const session = sessionWith(async () => jwt);
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurSessionError);
    expect((err as Error).message).toMatch(/not a readable Concur session token/);
    expect((err as Error).message).not.toContain(jwt);
  });

  it('a JWT from another datacenter → actionable CONCUR_DC error', async () => {
    const jwt = fakeJwt({ ...goodClaims(), iss: 'https://eu2.api.concursolutions.com' });
    const session = sessionWith(async () => jwt);
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurDatacenterError);
    expect((err as Error).message).toContain('"eu2"');
    expect((err as Error).message).toContain('"us2"');
    expect((err as McpToolError).hint).toMatch(/CONCUR_DC=eu2/);
    expect((err as Error).message).not.toContain(jwt);
  });

  it('a JWT whose issuer is not a Concur API host → datacenter error naming it', async () => {
    const session = sessionWith(async () => fakeJwt({ ...goodClaims(), iss: 'https://evil.example' }));
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurDatacenterError);
    expect((err as Error).message).toContain('https://evil.example');
    expect((err as McpToolError).hint).toMatch(/CONCUR_DC/);
  });

  it('a missing issuer → datacenter error', async () => {
    const session = sessionWith(async () => fakeJwt({ ...goodClaims(), iss: undefined }));
    await expect(session.get()).rejects.toBeInstanceOf(ConcurDatacenterError);
  });

  it('surfaces a hinted fetchproxy error UNMODIFIED', async () => {
    const err = Object.assign(new Error('pairing required — pair code 123-456'), {
      name: 'FetchproxySessionNotReadyError',
      hint: 'Approve pair code 123-456 in ContextMint Bridge.',
    });
    const session = sessionWith(async () => {
      throw err;
    });
    await expect(session.get()).rejects.toBe(err);
  });

  it('wraps an unclassified bridge error with the sign-in hint (redacted)', async () => {
    const jwt = fakeJwt(goodClaims());
    const session = sessionWith(async () => {
      throw new Error(`socket closed; Cookie: JWT=${jwt}`);
    });
    const err = await session.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurBridgeError);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(ConcurSessionError);
    expect((err as Error).message).toMatch(/Could not read the SAP Concur session/);
    expect((err as Error).message).not.toContain(jwt);
    expect((err as McpToolError).hint).toContain('ContextMint Bridge');
  });

  it('a non-Fetchproxy error that happens to carry a hint is still wrapped', async () => {
    const session = sessionWith(async () => {
      throw Object.assign(new Error('HTTP 502'), { hint: 'retry later' });
    });
    const err = await session.get().catch((e: unknown) => e);
    expect((err as McpToolError).hint).toContain('ContextMint Bridge');
  });

  it('uses Date.now by default', async () => {
    const session = new JwtSession({
      config: configForDc('us2'),
      readCookies: async () => ({ JWT: fakeJwt(goodClaims(Math.floor(Date.now() / 1000) + 3600)) }),
    });
    await expect(session.get()).resolves.toMatchObject({ userId: SUB });
  });
});
