import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { McpServer } from '@modelcontextprotocol/server';
import { ConcurClient } from '../src/client.js';
import { DENIED_MUTATIONS } from '../src/graphql-guard.js';
import { operationIndex } from '../src/operations.js';
import { registerExpenseWriteTools } from '../src/tools/expense-writes.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerGraphqlTools } from '../src/tools/graphql.js';
import { registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerLookupTools } from '../src/tools/lookups.js';
import { registerReceiptTools } from '../src/tools/receipts.js';
import { registerReportWriteTools } from '../src/tools/report-writes.js';
import { registerReportTools } from '../src/tools/reports.js';
import { registerTravelTools } from '../src/tools/travel.js';

// The bundled index must say exactly what docs/api/ says.

const API = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'api');
const read = (file: string) => readFileSync(join(API, file), 'utf8');

function indexSection(heading: string): string[] {
  const md = read('spend-operation-index.md');
  const start = md.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`no ${heading}`);
  const rest = md.slice(start + heading.length + 1);
  const end = rest.indexOf('\n## ');
  return (end < 0 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

/** `### Name` headings followed by `query|mutation` — operations, not fragments. */
function documented(file: string): Array<{ name: string; kind: string }> {
  return [...read(file).matchAll(/^### (\w+)\n(query|mutation)\b/gm)].map((m) => ({ name: m[1]!, kind: m[2]! }));
}

const index = operationIndex();

describe('operation index', () => {
  it('has every spend query and mutation from spend-operation-index.md, and nothing else', () => {
    const spend = index.filter((o) => o.endpoint === 'spend');
    expect(spend.filter((o) => o.kind === 'query').map((o) => o.name)).toEqual(indexSection('## Queries'));
    expect(spend.filter((o) => o.kind === 'mutation').map((o) => o.name)).toEqual(indexSection('## Mutations (not wired — writes)'));
  });

  it('points each spend operation at the docs/api file that holds its text (first occurrence)', () => {
    const where = new Map<string, string>();
    for (const file of ['spend-reads.graphql', 'spend-operations.graphql', 'spend-forms.graphql']) {
      for (const { name } of documented(file)) if (!where.has(name)) where.set(name, `docs/api/${file}`);
    }
    for (const op of index.filter((o) => o.endpoint === 'spend')) {
      expect([op.name, op.text]).toEqual([op.name, where.get(op.name)]);
    }
  });

  it('has exactly the travel operations in travel-operations.graphql, with the right kind', () => {
    const travel = index.filter((o) => o.endpoint === 'cds');
    expect(travel.map((o) => ({ name: o.name, kind: o.kind }))).toEqual(documented('travel-operations.graphql'));
    for (const op of travel) expect(op.text).toBe('docs/api/travel-operations.graphql');
  });

  it('marks every deny-listed operation as refused, and only those', () => {
    const denied = new Set(DENIED_MUTATIONS.flatMap((d) => d.operationNames));
    expect(index.filter((o) => o.refused).map((o) => o.name).sort()).toEqual([...denied].sort());
  });

  it('gives every operation a one-line purpose', () => {
    for (const op of index) expect(op.purpose).toMatch(/^\S.*\.$/s);
    for (const op of index) expect(op.purpose).not.toContain('\n');
  });

  it('names only tools that are actually registered', async () => {
    const registrars = [
      registerHealthcheckTool,
      registerLookupTools,
      registerReportTools,
      registerExpenseTools,
      registerReportWriteTools,
      registerExpenseWriteTools,
      registerReceiptTools,
      registerTravelTools,
      registerGraphqlTools,
    ];
    const client = new ConcurClient({ env: {}, readCookies: async () => ({}) });
    const harness = await createTestHarness((server: McpServer) => {
      for (const register of registrars) register(server, client);
    });
    try {
      const { tools } = await harness.client.listTools();
      const names = new Set(tools.map((t) => t.name));
      for (const op of index.filter((o) => o.tool)) expect([op.name, names.has(op.tool!)]).toEqual([op.name, true]);
    } finally {
      await harness.close();
    }
  });
});
