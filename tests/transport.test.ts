import { describe, expect, it, vi } from 'vitest';
import type { FetchproxyServer, FetchproxyServerOpts } from '@chrischall/mcp-utils/fetchproxy';
import { BRIDGE_DOMAIN, SESSION_COOKIES, createConcurBridge } from '../src/transport.js';

function fakeServer(cookies: string | Error = 'JWT=a.b.c') {
  const readCookies = vi.fn(async (_opts: unknown) => {
    if (cookies instanceof Error) throw cookies;
    return cookies;
  });
  const server = {
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    bridgeHealth: vi.fn(() => ({ port: 37_149 })),
    readCookies,
    role: null,
  };
  return server;
}

function bridgeWith(server: ReturnType<typeof fakeServer>, captured: FetchproxyServerOpts[] = []) {
  return createConcurBridge({
    port: 41_000,
    version: '9.9.9',
    createServer: (opts) => {
      captured.push(opts);
      return server as unknown as FetchproxyServer;
    },
  });
}

describe('createConcurBridge', () => {
  it('declares concursolutions.com and ONLY the JWT + OTSESSION cookies up front, on the configured port', async () => {
    const captured: FetchproxyServerOpts[] = [];
    const server = fakeServer();
    const bridge = bridgeWith(server, captured);
    await bridge.start();
    expect(server.listen).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const opts = captured[0]!;
    expect(opts.serverName).toBe('concur-mcp');
    expect(opts.version).toBe('9.9.9');
    expect(opts.port).toBe(41_000);
    expect(opts.domains).toEqual([BRIDGE_DOMAIN]);
    expect(BRIDGE_DOMAIN).toBe('concursolutions.com');
    expect(opts.cookieKeys).toEqual(['JWT', 'OTSESSIONAABQRD', 'OTSESSIONAABQRN']);
    expect(SESSION_COOKIES).toEqual(['JWT', 'OTSESSIONAABQRD', 'OTSESSIONAABQRN']);
    expect(opts.capabilities).toContain('read_cookies');
  });

  it('reads every session cookie for the datacenter subdomain in ONE bridge call', async () => {
    const server = fakeServer('JWT=hdr.payload.sig; OTSESSIONAABQRD=d1; OTSESSIONAABQRN=n1; other=1');
    const bridge = bridgeWith(server);
    await bridge.start();
    await expect(bridge.readSessionCookies('eu2')).resolves.toEqual({
      JWT: 'hdr.payload.sig',
      OTSESSIONAABQRD: 'd1',
      OTSESSIONAABQRN: 'n1',
    });
    expect(server.readCookies).toHaveBeenCalledTimes(1);
    expect(server.readCookies).toHaveBeenCalledWith({
      domain: 'concursolutions.com',
      subdomain: 'eu2',
      keys: ['JWT', 'OTSESSIONAABQRD', 'OTSESSIONAABQRN'],
    });
  });

  it('leaves out absent or empty cookies', async () => {
    const bridge = bridgeWith(fakeServer(''));
    await expect(bridge.readSessionCookies('us2')).resolves.toEqual({});
    const empty = bridgeWith(fakeServer('JWT=; OTSESSIONAABQRN=n1'));
    await expect(empty.readSessionCookies('us2')).resolves.toEqual({ OTSESSIONAABQRN: 'n1' });
  });

  it('starts lazily (once) when a read arrives before start()', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await Promise.all([bridge.readSessionCookies('us2'), bridge.readSessionCookies('us2'), bridge.start()]);
    expect(server.listen).toHaveBeenCalledTimes(1);
  });

  it('propagates bridge errors untouched', async () => {
    const err = Object.assign(new Error('pairing required — pair code 123-456'), {
      name: 'FetchproxySessionNotReadyError',
      hint: 'Approve pair code 123-456 in ContextMint Bridge.',
    });
    const bridge = bridgeWith(fakeServer(err));
    await expect(bridge.readSessionCookies('us2')).rejects.toBe(err);
  });

  it('a failed start is deferred to the first read, and does not crash close()', async () => {
    const server = fakeServer();
    server.listen.mockRejectedValueOnce(new Error('identity unreadable'));
    const bridge = bridgeWith(server);
    await expect(bridge.start()).rejects.toThrow('identity unreadable');
    await expect(bridge.readSessionCookies('us2')).rejects.toThrow('identity unreadable');
    await expect(bridge.close()).resolves.toBeUndefined();
    expect(server.close).not.toHaveBeenCalled();
  });

  it('close() is a no-op before start and closes the server after', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await bridge.close();
    expect(server.close).not.toHaveBeenCalled();
    await bridge.start();
    await bridge.close();
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});
