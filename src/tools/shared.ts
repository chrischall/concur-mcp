// Shared bits for the read tools: the context role, the `view` rungs, paging,
// and the projection helpers every compact rung uses.

import { z } from 'zod';
import { warningsOf, type GraphqlWarning } from '../client.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  messageOf,
  projectOrRaw,
  truncateErrorMessage,
  resolveView,
  untrustedEnvelope,
  untrustedResult,
  viewParam,
  viewResult,
  type View,
} from '@chrischall/mcp-utils';

/** Every tool acts on the signed-in user's own data. */
export const CONTEXT_ROLE = 'TRAVELER';

export const CONCUR_VIEWS = ['compact', 'full', 'raw'] as const satisfies readonly View[];

/** The `view` parameter. `note` says what compact leaves out. */
export const concurView = (note: string) => viewParam(CONCUR_VIEWS, { note });

export const pageParam = z.number().int().min(1).default(1).describe('1-based page number (default 1).');
export const sizeParam = z.number().int().min(1).max(100).default(50).describe('Page size, 1–100 (default 50).');

export interface Money {
  value?: number | null;
  currencyCode?: string | null;
}

/** `{value: 12.5, currencyCode: "USD"}` → `"12.5 USD"`; absent → undefined. */
export function money(m: Money | null | undefined): string | undefined {
  if (m?.value === null || m?.value === undefined) return undefined;
  return m.currencyCode ? `${m.value} ${m.currencyCode}` : String(m.value);
}

export interface PersonName {
  firstName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
}

/** "Preferred Last" (or "First Last"); undefined when there is no name at all. */
export function personName(p: PersonName | null | undefined): string | undefined {
  const name = [p?.preferredName || p?.firstName, p?.lastName].filter(Boolean).join(' ');
  return name || undefined;
}

/** Drop null/undefined keys (compact rungs only — false and 0 are kept). */
export function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/** Keys of `flags` whose value is exactly `true` (an empty list becomes undefined). */
export function trueFlags(flags: Record<string, unknown> | null | undefined): string[] | undefined {
  const on = Object.entries(flags ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return on.length > 0 ? on : undefined;
}

export interface Projections<T> {
  /** The default rung. */
  compact: (raw: T) => unknown;
  /** Every field this MCP selected, unwrapped from the GraphQL envelope. */
  full: (raw: T) => unknown;
}

/** `payload` plus `warnings` (Concur's partial errors) when there are any. */
export function withWarnings(payload: unknown, warnings: readonly GraphqlWarning[]): unknown {
  if (warnings.length === 0) return payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? { ...payload, warnings }
    : { result: payload, warnings };
}

/**
 * Answer in the requested rung. `raw` is the GraphQL `data` untouched; the
 * other two go through `projectOrRaw`, so a projector that trips over an
 * upstream shape change hands back everything instead of a half-empty record.
 * `untrusted` frames the payload as third-party text (vendor names, comments).
 * Any partial-error warnings Concur sent with `raw` ride along in every rung.
 */
export function respond<T>(
  viewArg: string | undefined,
  raw: T,
  projections: Projections<T>,
  opts: { context: string; untrusted?: boolean },
): CallToolResult {
  const view = resolveView(viewArg, CONCUR_VIEWS);
  const payload = withWarnings(
    view === 'raw' ? raw : projectOrRaw(raw, projections[view], { label: 'concur-mcp', context: opts.context }),
    warningsOf(raw),
  );
  if (!opts.untrusted) return viewResult(view, payload);
  return view === 'raw' ? viewResult('raw', untrustedEnvelope(payload)) : untrustedResult(payload);
}

/** A write's best-effort re-read: what Concur shows now, or why it could not be read. */
export type Verification<T> = { verified: T } | { verificationError: string };

/**
 * Re-read after a write that already SUCCEEDED. The re-read is best-effort: its
 * failure must never turn the write into an error result (the change is in
 * Concur either way, and a caller told "failed" would redo it — or believe a
 * report it just created does not exist). The caller spreads the outcome into
 * its success result.
 */
export async function verify<T>(read: () => Promise<T>): Promise<Verification<T>> {
  try {
    return { verified: await read() };
  } catch (err) {
    return {
      verificationError:
        `The change was made, but re-reading it failed: ${truncateErrorMessage(messageOf(err), 500)}. ` +
        'Do not repeat the write; re-read it shortly instead.',
    };
  }
}
