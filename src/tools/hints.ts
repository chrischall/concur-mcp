// Context-group hints, published on each tool as `_meta.mint` (the mcp-host
// context-groups contract, `mintHintSchema`). Inert data: a host that does not
// read them sees an extra `_meta` key and nothing else. The shape is fixed by
// the host's contract, so it is restated here rather than imported — this
// server takes no dependency on mcp-host.
//
// `when` names THIS tool's own argument names (the host fills them), never
// values. No tool here declares a `subject`: every call acts on the signed-in
// employee (CONTEXT_ROLE), so there is no listable set of subjects to offer.
// `aliases` are words a person says — lowercase, at most 8, each ≤ 40 chars.

import { UNTRUSTED_CONTENT_RULE, minifiedResult, untrustedEnvelope } from '@chrischall/mcp-utils';
import type { GraphqlWarning } from '../client.js';

export type MintIntent =
  | 'whats-new'
  | 'whats-due'
  | 'whats-on'
  | 'lookup'
  | 'turn-on-off'
  | 'send'
  | 'change'
  | 'other';

export interface MintHint {
  domain: 'work';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Concur tool: every tool here is in the `work` domain. */
export function workMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): { mint: MintHint } {
  return { mint: { domain: 'work', intent, ...extra } };
}

/** A read of the user's own Concur records, a list or reference data. */
export const LOOKUP = workMeta('lookup');
/** A write that creates, edits or removes a record in Concur. */
export const CHANGE = workMeta('change');
/** A tool that fits no intent: the raw GraphQL escape hatch. */
export const OTHER = workMeta('other');
/** A write that reaches another person (an approver, an email recipient). */
export const SEND = workMeta('send');

// ── brief lines ──────────────────────────────────────────────────────────────

const BRIEF_MAX = 120;

/** Text from an upstream field, on one line; undefined when blank. */
export function oneLine(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(); // \s also takes U+2028/2029
  return s === '' ? undefined : s;
}

/**
 * One item as one line, `title — <ISO date | no date> — <status>`, at most 120
 * characters: the title is shortened (with an ellipsis) to make room, then the
 * line as a whole is cut. A title starting with `-- ` would read as a note, and
 * the host strips one leading `\` from every item line, so a title starting
 * with either is escaped with one `\`.
 */
export function briefLine(rawTitle: string, date: string | undefined, status: string): string {
  const title = rawTitle.startsWith('-- ') || rawTitle.startsWith('\\') ? `\\${rawTitle}` : rawTitle;
  const tail = ` — ${date ?? 'no date'} — ${status}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 1))}…` : title;
  return `${shown}${tail}`.slice(0, BRIEF_MAX);
}

/** A note line, at most 120 characters. */
const note = (text: string): string => (text.length > BRIEF_MAX ? `${text.slice(0, BRIEF_MAX - 1)}…` : text);

/** One `-- error:` note per partial error Concur sent beside the data. */
export function errorNotes(warnings: readonly GraphqlWarning[]): string[] {
  return warnings.map((w) =>
    note(`-- error: Concur could not read ${w.path || 'part of the answer'}: ${oneLine(w.message) ?? 'no reason given'}`),
  );
}

/**
 * A brief answer: the item lines (or `-- none`), then the notes, inside the
 * untrusted-data envelope as `data: string[]`, minified — the titles are text
 * `whoWrote` names, not this MCP.
 */
export function briefResult(items: readonly string[], notes: readonly string[], whoWrote: string) {
  const lines = [...(items.length === 0 ? ['-- none'] : items), ...notes];
  return minifiedResult(untrustedEnvelope(lines, { note: `${whoWrote} ${UNTRUSTED_CONTENT_RULE}` }));
}
