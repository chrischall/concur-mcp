// The one list of tool registrars. `src/index.ts` registers exactly these, and
// the manifest-roster and annotation tests drive the same list, so a registrar
// can never be wired into the server but missed by the tests (or vice versa).

import type { McpServer } from '@modelcontextprotocol/server';
import type { ConcurClient } from '../client.js';
import { registerExpenseWriteTools } from './expense-writes.js';
import { registerExpenseTools } from './expenses.js';
import { registerGraphqlTools } from './graphql.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { registerLookupTools } from './lookups.js';
import { registerReceiptTools } from './receipts.js';
import { registerReportWriteTools } from './report-writes.js';
import { registerReportTools } from './reports.js';
import { registerTravelTools } from './travel.js';

export type ToolRegistrar = (server: McpServer, client: ConcurClient) => void;

export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
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
