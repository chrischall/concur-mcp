/**
 * Truthful annotations on every tool, read off the REGISTERED config (the
 * wire), not a hand-kept list.
 *
 * `destructiveHint` DEFAULTS TO TRUE whenever `readOnlyHint` is false, so a
 * write that forgets it publishes as destructive and nothing fails — a
 * considered `false` and a forgotten one look identical. So every non-read
 * must set it explicitly, and no read may claim to destroy anything.
 */

import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { ConcurClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/index.js';

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

async function annotations(): Promise<Record<string, Ann | undefined>> {
  const client = new ConcurClient({ env: {}, readCookies: async () => ({ JWT: 'unused' }) });
  const harness = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
  const { tools } = await harness.client.listTools();
  return Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
}

/**
 * The tools with NO inverse in this tool set (or that reach another person).
 * Pinned so a reclassification is a deliberate, reviewed edit.
 */
const DESTRUCTIVE = [
  'concur_add_report_comment', // permanent, seen by approvers — no delete
  'concur_append_receipt', // no tool removes a single appended page; detach takes the whole receipt
  'concur_delete_available_expenses',
  'concur_delete_expenses',
  'concur_delete_receipt',
  'concur_delete_report',
  'concur_graphql_mutation', // arbitrary — cannot know it is reversible
  'concur_move_available_expenses_to_report', // no move-back operation
  'concur_send_itinerary', // real email to third parties
  'concur_submit_report', // reaches the approver
  'concur_upload_receipt', // `append: true` is the same irreversible append
].sort();

/** The only tools that never reach Concur: concur_list_operations reads the bundled operation index. */
const LOCAL_ONLY = ['concur_list_operations'];

describe('tool annotations', () => {
  it('covers the whole surface (a meta-test that silently covers half is worse than none)', async () => {
    expect(Object.keys(await annotations()).length).toBeGreaterThanOrEqual(37);
  });

  it('sets an explicit boolean readOnlyHint on every tool', async () => {
    const missing = Object.entries(await annotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const missing = Object.entries(await annotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('no read claims to be destructive', async () => {
    const wrong = Object.entries(await annotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('marks exactly the irreversible writes destructive', async () => {
    const destructive = Object.entries(await annotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual(DESTRUCTIVE);
  });

  it('sets an explicit boolean openWorldHint on every tool, false only for the local ones', async () => {
    const all = Object.entries(await annotations());
    expect(all.filter(([, a]) => typeof a?.openWorldHint !== 'boolean').map(([name]) => name)).toEqual([]);
    expect(all.filter(([, a]) => a?.openWorldHint === false).map(([name]) => name).sort()).toEqual(LOCAL_ONLY);
  });
});
