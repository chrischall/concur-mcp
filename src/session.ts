// The Concur session: the browser's HttpOnly `JWT` cookie, lifted through the
// ContextMint Bridge and reused from Node as a Bearer token, together with
// Concur's legacy OTSESSION cookies (sent as a `Cookie` header — the legacy-
// backed fields need them). All are lifted together, single-flight. The JWT
// lives 60 min; we re-lift when within SKEW_SECONDS of `exp`, or after the
// client invalidates the session (a 401, or a stale-OTSESSION field error).
// No cookie value ever appears in an error.

import {
  McpToolError,
  SessionNotAuthenticatedError,
  decodeJwtClaim,
  messageOf,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import type { ConcurConfig } from './config.js';
import { JWT_COOKIE, OTSESSION_COOKIES, type SessionCookies } from './transport.js';

/** Re-lift this many seconds before `exp`, so a call never races the expiry. */
export const SKEW_SECONDS = 120;

export interface ConcurSessionInfo {
  /** The raw token. Never put it in a message, a result, or a log line. */
  jwt: string;
  /** JWT `sub` — the user's UUID, passed as `userId` everywhere. */
  userId: string;
  /** JWT `exp`, epoch seconds. */
  exp: number;
  dc: string;
  /**
   * `OTSESSIONAABQRD=…; OTSESSIONAABQRN=…` — only the ones the browser had;
   * undefined when it had neither. A secret, like `jwt`.
   */
  legacyCookie?: string;
}

export function signInHint(webOrigin: string): string {
  return `Open and sign in to ${webOrigin} in the browser running ContextMint Bridge, then retry.`;
}

/** No usable session in the browser. A `SessionNotAuthenticatedError` with Concur's own copy. */
export class ConcurSessionError extends SessionNotAuthenticatedError {
  constructor(webOrigin: string, reason: string) {
    super('SAP Concur', webOrigin);
    this.message = `Not signed in to SAP Concur: ${reason}.`;
    Object.defineProperty(this, 'hint', { value: signInHint(webOrigin), enumerable: true, configurable: true });
  }
}

/** Reading the cookie through the bridge failed for an unclassified reason. */
export class ConcurBridgeError extends McpToolError {
  constructor(message: string, hint: string, cause: unknown) {
    super(message, { hint, cause });
    this.name = 'ConcurBridgeError';
  }
}

/** The signed-in session belongs to a different datacenter than CONCUR_DC. */
export class ConcurDatacenterError extends McpToolError {
  constructor(message: string, hint: string) {
    super(message, { hint });
    this.name = 'ConcurDatacenterError';
  }
}

/**
 * The fleet's `fetchproxyHintOf` rule: a `Fetchproxy*` error carrying a typed
 * hint (pairing pending, scope changed, no tab, bridge down) already names its
 * remedy, so it is surfaced unmodified. Matched by duck type, not
 * `instanceof` — `FetchproxySessionNotReadyError` is not a
 * `FetchproxyHintedError`, and a duplicated package breaks `instanceof`.
 */
export function isHintedFetchproxyError(err: unknown): boolean {
  if (!(err instanceof Error) || !err.name.startsWith('Fetchproxy')) return false;
  const hint = (err as Error & { hint?: unknown }).hint;
  return typeof hint === 'string' && hint.length > 0;
}

const ISSUER_PATTERN = /^https:\/\/([a-z0-9]+)\.api\.concursolutions\.com\/?$/;

export interface JwtSessionOptions {
  config: ConcurConfig;
  /** Lift the session cookies (`JWT` + the OTSESSION ones) for a datacenter, in one bridge call. */
  readCookies: (dc: string) => Promise<SessionCookies>;
  /** Clock in ms (test seam). */
  now?: () => number;
}

export class JwtSession {
  private cached: ConcurSessionInfo | undefined;
  private inflight: Promise<ConcurSessionInfo> | undefined;
  private readonly now: () => number;
  private lifts = 0;
  /** The last two lifted sessions (kept past invalidate()) — what an error scrubber must redact. */
  private history: ConcurSessionInfo[] = [];

  constructor(private readonly opts: JwtSessionOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A session good for at least SKEW_SECONDS more, lifting one if needed. */
  get(): Promise<ConcurSessionInfo> {
    const cached = this.cached;
    if (cached && cached.exp - this.nowSeconds() > SKEW_SECONDS) return Promise.resolve(cached);
    this.inflight ??= this.lift().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The cached session, without lifting. */
  peek(): ConcurSessionInfo | undefined {
    return this.cached;
  }

  /**
   * How many lifts have completed. A caller compares it across a request to
   * tell whether the session was freshly lifted for that very call (then a
   * re-lift cannot help, so it must not replay).
   */
  get generation(): number {
    return this.lifts;
  }

  /** The sessions lifted most recently (current and previous), for redaction only. */
  recent(): readonly ConcurSessionInfo[] {
    return this.history;
  }

  /** Drop the cached token (the API rejected it); the next get() re-lifts. */
  invalidate(): void {
    this.cached = undefined;
  }

  private nowSeconds(): number {
    return this.now() / 1000;
  }

  private async lift(): Promise<ConcurSessionInfo> {
    const { config } = this.opts;
    this.cached = undefined;
    let cookies: SessionCookies;
    try {
      cookies = await this.opts.readCookies(config.dc);
    } catch (err) {
      if (isHintedFetchproxyError(err)) throw err;
      throw new ConcurBridgeError(
        `Could not read the SAP Concur session from the browser: ${truncateErrorMessage(messageOf(err))}`,
        signInHint(config.webOrigin),
        err,
      );
    }
    const jwt = cookies[JWT_COOKIE];
    if (!jwt) {
      throw new ConcurSessionError(config.webOrigin, `no Concur session cookie was found for ${config.webOrigin}`);
    }

    const exp = decodeJwtClaim(jwt, 'exp');
    const sub = decodeJwtClaim(jwt, 'sub');
    if (typeof exp !== 'number' || typeof sub !== 'string' || sub.length === 0) {
      throw new ConcurSessionError(config.webOrigin, 'the browser\'s JWT cookie is not a readable Concur session token');
    }

    const iss = decodeJwtClaim(jwt, 'iss');
    if (iss !== config.expectedIssuer) {
      const actualDc = typeof iss === 'string' ? ISSUER_PATTERN.exec(iss)?.[1] : undefined;
      if (actualDc) {
        throw new ConcurDatacenterError(
          `The signed-in Concur session belongs to datacenter "${actualDc}", but CONCUR_DC is "${config.dc}".`,
          `Set CONCUR_DC=${actualDc} (the first label of your Concur tab's host) and restart the server.`,
        );
      }
      throw new ConcurDatacenterError(
        `The Concur session token's issuer (${truncateErrorMessage(String(iss), 120)}) is not a Concur API host for CONCUR_DC "${config.dc}".`,
        `Check CONCUR_DC matches your Concur tab's host, then ${signInHint(config.webOrigin)}`,
      );
    }

    if (exp <= this.nowSeconds()) {
      throw new ConcurSessionError(config.webOrigin, 'the Concur session in the browser has expired');
    }

    const legacy = OTSESSION_COOKIES.filter((name) => cookies[name]).map((name) => `${name}=${cookies[name]}`);
    const info: ConcurSessionInfo = {
      jwt,
      userId: sub,
      exp,
      dc: config.dc,
      ...(legacy.length > 0 ? { legacyCookie: legacy.join('; ') } : {}),
    };
    this.cached = info;
    this.lifts++;
    this.history = [info, ...this.history].slice(0, 2);
    return info;
  }
}
