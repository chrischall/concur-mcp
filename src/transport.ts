// The ContextMint Bridge, used ONLY to lift the session cookies from the
// user's signed-in Concur tab (the "bootstrap" archetype): the HttpOnly `JWT`
// plus Concur's legacy `OTSESSIONAABQRD` / `OTSESSIONAABQRN` session cookies.
// Every API call is a plain Node fetch with `Authorization: Bearer <jwt>` and a
// `Cookie` header carrying the OTSESSION ones — see client.ts.
//
// `@chrischall/mcp-utils/fetchproxy` eagerly imports `@fetchproxy/server`, so it
// is imported lazily here (type imports are erased): nothing on the boot path
// depends on the bridge package resolving.

import { parseCookieHeader } from '@chrischall/mcp-utils';
import type { FetchproxyServer, FetchproxyServerOpts, FetchproxyTransport } from '@chrischall/mcp-utils/fetchproxy';

/** The cookie domain the bridge is scoped to. */
export const BRIDGE_DOMAIN = 'concursolutions.com';

/** The session token: sent as `Authorization: Bearer`. Required. */
export const JWT_COOKIE = 'JWT';

/**
 * Concur's legacy session cookies. Fields backed by its legacy services
 * (`rptKey`, `userPermissions`, `currencies`, `availableReceipts`, …) answer
 * `errors[]` with EMPTY `extensions` to a Bearer-only call; either one of these
 * in a `Cookie` header fixes that (verified live). Optional: sent when present.
 */
export const OTSESSION_COOKIES = ['OTSESSIONAABQRD', 'OTSESSIONAABQRN'] as const;

/**
 * Every cookie this MCP reads, declared up front: the pair grant is per-scope,
 * so changing this list strands every paired user until they re-approve.
 */
export const SESSION_COOKIES: readonly string[] = [JWT_COOKIE, ...OTSESSION_COOKIES];

/** The session cookies the browser had, by name (absent or empty ones are left out). */
export type SessionCookies = Partial<Record<string, string>>;

export interface ConcurBridge {
  /** Load the fetchproxy identity (no port bind — that is lazy, on the first read). */
  start(): Promise<void>;
  close(): Promise<void>;
  /**
   * The session cookies for `<dc>.concursolutions.com` (the host the JWT is
   * issued for), in ONE bridge round-trip. Absent cookies are left out.
   */
  readSessionCookies(dc: string): Promise<SessionCookies>;
}

export interface ConcurBridgeOptions {
  port: number;
  version: string;
  /** Test seam: build the underlying FetchproxyServer (inject a mock). */
  createServer?: (opts: FetchproxyServerOpts) => FetchproxyServer;
}

export function createConcurBridge(opts: ConcurBridgeOptions): ConcurBridge {
  let started: Promise<FetchproxyTransport> | undefined;

  // Single-flight, and cached even when it fails: a start failure (an
  // unreadable identity file, say) then surfaces on every read instead of
  // crashing boot — the deferred-config-error pattern for the bridge.
  const ensureStarted = (): Promise<FetchproxyTransport> =>
    (started ??= (async () => {
      const fp = await import('@chrischall/mcp-utils/fetchproxy');
      const transport = fp.createFetchproxyTransport({
        serverName: 'concur-mcp',
        version: opts.version,
        port: opts.port,
        ...fp.createBootstrapOpts({
          domains: [BRIDGE_DOMAIN],
          bootstrap: { cookieKeys: [...SESSION_COOKIES] },
        }),
        debugEnvVar: 'CONCUR_DEBUG',
        logListening: true,
        // undefined → the library's default `new FetchproxyServer(...)`.
        createServer: opts.createServer,
      });
      await transport.start();
      return transport;
    })());

  return {
    async start() {
      await ensureStarted();
    },
    async close() {
      if (!started) return;
      const transport = await started.catch(() => undefined);
      await transport?.close();
    },
    async readSessionCookies(dc) {
      const transport = await ensureStarted();
      const header = await transport.server.readCookies({ domain: BRIDGE_DOMAIN, subdomain: dc, keys: [...SESSION_COOKIES] });
      const parsed = parseCookieHeader(header);
      const out: SessionCookies = {};
      for (const name of SESSION_COOKIES) if (parsed[name]) out[name] = parsed[name];
      return out;
    },
  };
}
