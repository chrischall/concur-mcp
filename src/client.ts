// ConcurClient — every Concur API call, made from Node with the lifted JWT as
// `Authorization: Bearer` plus the legacy OTSESSION cookies as `Cookie` (the
// legacy-backed fields fail without them). GraphQL goes through mcp-utils'
// createGraphqlClient `execute` (errors[] on a 200 is mapped here); receipt
// upload is a hand-rolled multipart POST because it answers 202 with JSON, not
// a GraphQL envelope.
//
// Deferred-config-error pattern: a bad CONCUR_DC is stored at construction and
// thrown from the first call, so the server always boots and lists its tools.

import { randomUUID } from 'node:crypto';
import {
  McpToolError,
  UpstreamHttpError,
  formatApiError,
  messageOf,
  truncateErrorMessage,
  withAmbientCancellation,
} from '@chrischall/mcp-utils';
import {
  GraphqlResponseError,
  createGraphqlClient,
  isGraphqlAuthError,
  isReadOnlyGraphqlDocument,
  type GraphqlClient,
  type GraphqlError,
  type GraphqlErrorContext,
  type GraphqlResult,
} from '@chrischall/mcp-utils/graphql';
import { DEFAULT_DC, configForDc, readConfig, type ConcurConfig, type EnvSource } from './config.js';
import { ConcurSessionError, JwtSession, type ConcurSessionInfo } from './session.js';
import type { SessionCookies } from './transport.js';

const SERVICE = 'SAP Concur';
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface ConcurClientOptions {
  /** Lift the browser's session cookies (`JWT` + OTSESSION) for a datacenter (the bridge). */
  readCookies: (dc: string) => Promise<SessionCookies>;
  env?: EnvSource;
  /** Injectable fetch. The default is a receiver-safe wrapper around the global. */
  fetchImpl?: typeof fetch;
  /** Clock in ms (test seam). */
  now?: () => number;
  /** `concur-correlationid` source (test seam). Defaults to a random UUID. */
  correlationId?: () => string;
  timeoutMs?: number;
}

/** A receipt to upload. */
export interface ReceiptFile {
  data: Uint8Array | Blob;
  filename: string;
  contentType: string;
}

/** A downloaded file (a receipt image). */
export interface Download {
  bytes: Uint8Array;
  /** The response's `content-type` (without parameters), when it sent one. */
  contentType?: string;
}

/** The credential headers for a session: the Bearer, plus the OTSESSION cookies when the browser had them. */
function authHeaders(session: ConcurSessionInfo): Record<string, string> {
  return {
    authorization: `Bearer ${session.jwt}`,
    ...(session.legacyCookie ? { cookie: session.legacyCookie } : {}),
  };
}

/**
 * The signature of a stale or missing OTSESSION cookie: a field error on a 200
 * whose `extensions` is present but EMPTY (Concur's real failures always carry
 * dataSource / correlationId there). Verified live against legacy-backed fields.
 */
export function isStaleSessionSignature(errors: readonly GraphqlError[] | undefined): boolean {
  return (errors ?? []).some((e) => {
    const ext = e.extensions;
    return typeof ext === 'object' && ext !== null && !Array.isArray(ext) && Object.keys(ext).length === 0;
  });
}

/** A session cookie written as `NAME=value` (as an upstream message might echo it). */
const SESSION_COOKIE_PAIR = /\b(JWT|OTSESSION[A-Za-z0-9]*)=[^;\s,"']+/g;

/**
 * Keep every session secret out of an error's text: `NAME=value` pairs by
 * pattern, and each live value verbatim (a bare echo carries no name). Mutates
 * in place so the error's identity and type survive.
 */
function scrubText(text: string, sessions: readonly ConcurSessionInfo[]): string {
  let out = text.replace(SESSION_COOKIE_PAIR, '$1=[REDACTED]');
  for (const s of sessions) {
    const values = [s.jwt, ...(s.legacyCookie ? s.legacyCookie.split('; ').map((pair) => pair.slice(pair.indexOf('=') + 1)) : [])];
    for (const value of values) out = out.split(value).join('[REDACTED]');
  }
  return out;
}

function scrubSecrets(err: unknown, sessions: readonly ConcurSessionInfo[]): void {
  /* v8 ignore next -- every path below throws an Error; a non-Error has no text to scrub */
  if (!(err instanceof Error)) return;
  const scrub = (text: string) => scrubText(text, sessions);
  // Only assigned when it changed: a DOMException's message is read-only, and a
  // caller's AbortError (rethrown untouched) never carries a session value.
  const message = scrub(err.message);
  if (message !== err.message) err.message = message;
  const hinted = err as Error & { hint?: unknown };
  if (typeof hinted.hint === 'string') {
    const hint = scrub(hinted.hint);
    if (hint !== hinted.hint) Object.defineProperty(err, 'hint', { value: hint, enumerable: true, configurable: true });
  }
}

/**
 * One `errors[]` entry that did NOT sink the call: Concur answered with data
 * and this sub-field failed. Surfaced to the caller instead of thrown.
 */
export interface GraphqlWarning {
  /** The failed field's path, joined with `.` (empty when Concur gave none). */
  path: string;
  message: string;
  correlationId?: string;
}

/** Per-call options for spend() / cds(). */
export interface GraphqlCallOptions {
  /**
   * Dot paths into `data` the caller cannot do without (e.g.
   * `employee.expenseReport.reportDetails`). When Concur answers `errors[]`
   * and one of these is null, the call throws the mapped error. Without it,
   * the call throws only when EVERY root field is null.
   */
  essential?: readonly string[];
}

// Warnings ride beside the returned `data` object (keyed by identity), so the
// many call sites that only want `data` keep their shape and the shared result
// builders (`respond`) can pick the warnings up.
const WARNINGS = new WeakMap<object, GraphqlWarning[]>();

/** The partial-error warnings Concur sent with this `data` (empty when none). */
export function warningsOf(data: unknown): GraphqlWarning[] {
  return (typeof data === 'object' && data !== null && WARNINGS.get(data)) || [];
}

/** `{ warnings }` when this `data` came with any, else `{}` — for spreading into a result. */
export function warningsField(data: unknown): { warnings?: GraphqlWarning[] } {
  const warnings = warningsOf(data);
  return warnings.length > 0 ? { warnings } : {};
}

/** The value at a dot path (through objects only); undefined when any step is missing. */
function valueAt(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Whether a partial answer still carries what the caller needs. */
function hasEssentials(data: object, essential: readonly string[] | undefined): boolean {
  if (essential) return essential.every((path) => valueAt(data, path) !== null && valueAt(data, path) !== undefined);
  return Object.values(data).some((v) => v !== null && v !== undefined);
}

/** Hosts the Bearer token may be sent to. */
function isConcurHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'concursolutions.com' || host.endsWith('.concursolutions.com');
}

/** Read a body, refusing once it passes `maxBytes` (a declared length is refused up front). */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new McpToolError(`The receipt image is larger than ${maxBytes} bytes; refusing to download it.`, {
      hint: 'Open it in the Concur web app instead.',
    });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** What the upload endpoint answers on success (HTTP 202). */
export interface UploadResult {
  imageId: string;
  id: string;
}

interface Ready {
  config: ConcurConfig;
  session: JwtSession;
  spend: GraphqlClient;
  cds: GraphqlClient;
}

/** One `errors[]` entry, with the fields Concur hides its real detail in. */
function describeError(error: GraphqlError): string {
  const message = typeof error.message === 'string' && error.message ? error.message : 'Unknown error';
  const at = Array.isArray(error.path) && error.path.length > 0 ? ` at ${error.path.join('.')}` : '';
  const ext = (error.extensions ?? {}) as {
    dataSource?: unknown;
    response?: { status?: unknown };
    correlationId?: unknown;
  };
  const facts = [
    ext.dataSource !== undefined ? `dataSource=${String(ext.dataSource)}` : undefined,
    ext.response?.status !== undefined ? `status=${String(ext.response.status)}` : undefined,
    ext.correlationId !== undefined ? `correlationId=${String(ext.correlationId)}` : undefined,
  ].filter((f): f is string => f !== undefined);
  return `${message}${at}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`;
}

/**
 * Concur answers failures as HTTP 200 + `errors[]` whose message is an opaque
 * "An error occurred"; the useful part is in `extensions`. Auth (401) is left
 * to the client's replay + onUnauthorized, so it is never claimed here.
 */
export function mapConcurErrors(ctx: GraphqlErrorContext): Error | undefined {
  if (ctx.errors.length === 0 || ctx.status === 401) return undefined;
  const detail = ctx.errors.map(describeError).join('; ');
  return new GraphqlResponseError(`${SERVICE} GraphQL error: ${truncateErrorMessage(detail)}`, {
    status: ctx.status,
    errors: ctx.errors,
    data: ctx.data,
    hint: 'Check the ids and arguments. If it persists, quote the correlationId to your Concur administrator.',
  });
}

function isUploadResult(value: unknown): value is UploadResult {
  if (typeof value !== 'object' || value === null) return false;
  const { imageId, id } = value as Record<string, unknown>;
  return typeof imageId === 'string' && imageId.length > 0 && typeof id === 'string';
}

export class ConcurClient {
  private readonly ready: Ready | undefined;
  private readonly configError: unknown;
  private readonly fetchImpl: typeof fetch;
  private readonly correlationId: () => string;
  readonly now: () => number;

  constructor(opts: ConcurClientOptions) {
    // Receiver-safe: storing the bare global and calling it as a method binds
    // `this` to the client, which older undici rejects with "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.correlationId = opts.correlationId ?? randomUUID;
    this.now = opts.now ?? Date.now;

    let config: ConcurConfig;
    try {
      config = readConfig(opts.env);
    } catch (err) {
      this.configError = err;
      this.ready = undefined;
      return;
    }

    const session = new JwtSession({ config, readCookies: opts.readCookies, now: this.now });
    const graphql = (endpoint: string): GraphqlClient =>
      createGraphqlClient({
        endpoint,
        serviceName: SERVICE,
        // Synchronous on purpose: spend()/cds() resolve the session BEFORE the
        // request, so a sign-in failure surfaces as itself. A throw from here
        // would be reported as a transport failure ("outcome unknown" on a write).
        headers: () => {
          const current = session.peek();
          return {
            ...(current ? authHeaders(current) : {}),
            'concur-correlationid': this.correlationId(),
          };
        },
        // One re-lift; the client replays once, and a second 401 throws below.
        onAuthError: async () => {
          session.invalidate();
          await session.get();
        },
        writeOutcomeHint: 'Re-read the report or expense to check whether the change landed before retrying.',
        fetchImpl: this.fetchImpl,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

    this.ready = { config, session, spend: graphql(config.spendGraphqlUrl), cds: graphql(config.cdsGraphqlUrl) };
  }

  /** The API host, for display. Falls back to the default datacenter when CONCUR_DC is invalid. */
  get hostLabel(): string {
    return new URL((this.ready?.config ?? configForDc(DEFAULT_DC)).apiOrigin).host;
  }

  private requireReady(): Ready {
    if (!this.ready) throw this.configError;
    return this.ready;
  }

  /** The live session (lifting it if needed). Never return `jwt` to a caller. */
  async session(): Promise<ConcurSessionInfo> {
    return this.requireReady().session.get();
  }

  /** The signed-in user's UUID (JWT `sub`) — pass it as `userId` everywhere. */
  async userId(): Promise<string> {
    return (await this.session()).userId;
  }

  /** Run a document against the expense GraphQL endpoint (`/spend-graphql/graphql`). */
  async spend<T = unknown>(query: string, variables?: Record<string, unknown>, opts: GraphqlCallOptions = {}): Promise<T> {
    return this.redacting(() => this.run<T>('spend', query, variables, opts));
  }

  /** Run a document against the CDS GraphQL endpoint (`/cds/graphql` — travel). */
  async cds<T = unknown>(query: string, variables?: Record<string, unknown>, opts: GraphqlCallOptions = {}): Promise<T> {
    return this.redacting(() => this.run<T>('cds', query, variables, opts));
  }

  /** Run `fn`, scrubbing every session secret out of anything it throws. */
  private async redacting<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      scrubSecrets(err, this.ready?.session.recent() ?? []);
      throw err;
    }
  }

  /**
   * One GraphQL call. The library replays once on a 401 (after a re-lift). A
   * stale-OTSESSION field error (empty `extensions`) gets the same treatment
   * here — ONE re-lift and replay — but only for a read, and only when the
   * session was not freshly lifted for this very call (then a re-lift cannot
   * help). A write is never replayed: its mutation may already have run; the
   * session is dropped instead so the next call (the re-read) lifts fresh.
   */
  private async run<T>(
    endpoint: 'spend' | 'cds',
    query: string,
    variables: Record<string, unknown> | undefined,
    opts: GraphqlCallOptions,
  ): Promise<T> {
    const ready = this.requireReady();
    const generation = ready.session.generation;
    await ready.session.get();
    const request = { query, ...(variables !== undefined ? { variables } : {}) };
    let result = await ready[endpoint].execute<T>(request);
    if (isStaleSessionSignature(result.errors) && ready.session.generation === generation) {
      ready.session.invalidate();
      if (isReadOnlyGraphqlDocument(query)) {
        await ready.session.get();
        result = await ready[endpoint].execute<T>(request);
      }
    }
    return this.unwrap(result, ready, opts);
  }

  /**
   * The `data` of a GraphQL answer, or the mapped error. Concur often answers
   * valid data plus `errors[]` for one sub-field: that returns the data, with
   * the errors as warnings ({@link warningsOf}), unless an essential path is
   * null — then (and when there is no data at all) it throws as before.
   */
  private unwrap<T>(result: GraphqlResult<T>, ready: Ready, opts: GraphqlCallOptions): T {
    const { status, data } = result;
    const errors = result.errors ?? [];
    const partial =
      errors.length > 0 &&
      status < 400 &&
      typeof data === 'object' &&
      data !== null &&
      !isGraphqlAuthError(status, errors) &&
      hasEssentials(data, opts.essential);
    if (partial) {
      const sessions = ready.session.recent();
      WARNINGS.set(
        data,
        errors.map((e) => {
          const correlationId = (e.extensions as { correlationId?: unknown } | undefined)?.correlationId;
          return {
            path: Array.isArray(e.path) ? e.path.join('.') : '',
            message: scrubText(truncateErrorMessage(typeof e.message === 'string' && e.message ? e.message : 'Unknown error', 300), sessions),
            ...(correlationId !== undefined ? { correlationId: String(correlationId) } : {}),
          };
        }),
      );
      return data;
    }
    const failed = errors.length > 0 || status >= 400 || data === undefined || data === null;
    if (failed) {
      const mapped = mapConcurErrors({ status, errors, data });
      if (mapped) throw mapped;
    }
    if (isGraphqlAuthError(status, errors)) {
      throw new ConcurSessionError(ready.config.webOrigin, 'Concur rejected the session (HTTP 401) even after re-reading it from the browser');
    }
    if (status >= 400) throw new UpstreamHttpError(status, `${SERVICE} GraphQL API returned HTTP ${status}.`);
    if (data === undefined || data === null) {
      throw new GraphqlResponseError(`${SERVICE} GraphQL API returned an empty response.`, { status });
    }
    return data;
  }

  /**
   * Upload a receipt image (multipart, one part named `file`). Success is HTTP
   * 202 with `{ imageId, id }`; attach it to an entry with `AttachImage`.
   */
  async upload(file: ReceiptFile, params: Record<string, string> = {}): Promise<UploadResult> {
    return this.redacting(() => this.uploadOnce(file, params));
  }

  private async uploadOnce(file: ReceiptFile, params: Record<string, string>): Promise<UploadResult> {
    const ready = this.requireReady();
    const url = new URL(ready.config.spendUploadUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const blob =
      file.data instanceof Blob ? file.data : new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.contentType });

    for (let attempt = 0; ; attempt++) {
      const current = await ready.session.get();
      const form = new FormData();
      form.append('file', blob, file.filename);

      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: 'POST',
          headers: {
            ...authHeaders(current),
            'concur-correlationid': this.correlationId(),
            accept: 'application/json',
          },
          body: form,
          signal: withAmbientCancellation(AbortSignal.timeout(UPLOAD_TIMEOUT_MS)),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err; // the caller cancelled
        throw new McpToolError(
          `Receipt upload to ${SERVICE} did not complete: ${truncateErrorMessage(messageOf(err), 200)} — ` +
            'the receipt may already have been stored (outcome is unknown).',
          { hint: 'List the available receipts before uploading again.', cause: err },
        );
      }

      if (res.status === 401) {
        if (attempt === 0) {
          ready.session.invalidate();
          continue;
        }
        throw new ConcurSessionError(
          ready.config.webOrigin,
          'Concur rejected the session (HTTP 401) even after re-reading it from the browser',
        );
      }

      const text = await res.text();
      if (res.status !== 202) {
        throw new UpstreamHttpError(
          res.status,
          formatApiError(res.status, 'POST', '/spend-graphql/upload', text, { service: SERVICE }),
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!isUploadResult(body)) {
        throw new McpToolError(`${SERVICE} accepted the receipt upload (HTTP 202) but did not return an image id.`, {
          hint: 'List the available receipts — the upload may have landed there.',
        });
      }
      return { imageId: body.imageId, id: body.id };
    }
  }

  /**
   * Download a file the API pointed at (a receipt's `imageUrl`). A relative URL
   * resolves against the API host; only https is fetched. The Bearer token (and
   * the session cookies) go ONLY to a concursolutions.com host (one re-lift + replay on 401) — a
   * presigned URL elsewhere is fetched without it.
   */
  async download(rawUrl: string, opts: { maxBytes: number }): Promise<Download> {
    return this.redacting(() => this.downloadOnce(rawUrl, opts));
  }

  private async downloadOnce(rawUrl: string, opts: { maxBytes: number }): Promise<Download> {
    const ready = this.requireReady();
    const url = new URL(rawUrl, ready.config.apiOrigin);
    if (url.protocol !== 'https:') {
      throw new McpToolError(`Refusing to download a receipt from a non-https URL (${url.protocol}).`, {
        hint: 'The receipt image URL Concur returned was not https; open the receipt in the Concur web app.',
      });
    }
    const authed = isConcurHost(url.hostname);

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: '*/*' };
      if (authed) {
        Object.assign(headers, authHeaders(await ready.session.get()));
        headers['concur-correlationid'] = this.correlationId();
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers,
          signal: withAmbientCancellation(AbortSignal.timeout(UPLOAD_TIMEOUT_MS)),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err; // the caller cancelled
        throw new McpToolError(
          `Downloading the receipt image from ${SERVICE} failed: ${truncateErrorMessage(messageOf(err), 200)}`,
          { hint: 'Retry; if it persists, open the receipt in the Concur web app.', cause: err },
        );
      }

      if (res.status === 401 && authed) {
        await res.body?.cancel();
        if (attempt === 0) {
          ready.session.invalidate();
          continue;
        }
        throw new ConcurSessionError(
          ready.config.webOrigin,
          'Concur rejected the session (HTTP 401) even after re-reading it from the browser',
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new UpstreamHttpError(
          res.status,
          formatApiError(res.status, 'GET', url.pathname, text, { service: SERVICE }),
        );
      }
      const bytes = await readCapped(res, opts.maxBytes);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
      return { bytes, ...(contentType ? { contentType } : {}) };
    }
  }
}
