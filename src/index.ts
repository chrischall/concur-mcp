#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';

// runMcp builds the McpServer, applies the registrars, prints the banner to
// stderr, wires SIGINT/SIGTERM graceful shutdown, and connects the stdio
// transport. Registrars are appended to `tools` as they land; nothing here may
// resolve a credential at boot (deferred-config-error pattern), so the host's
// initial tools/list always succeeds before any session check runs.
await runMcp({
  name: 'concur-mcp',
  version: VERSION,
  tools: [],
  banner:
    '[concur-mcp] Unofficial SAP Concur MCP. Concur has no public API for this; it uses the web app\'s internal one ' +
    'and may break or violate their ToS. Developed and maintained by AI (Claude). Use at your own discretion.',
});
