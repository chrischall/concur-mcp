#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { ConcurClient } from './client.js';
import { readWsPort } from './config.js';
import { TOOL_REGISTRARS } from './tools/index.js';
import { createConcurBridge } from './transport.js';
import { VERSION } from './version.js';

// The bridge only lifts the session cookies (the HttpOnly `JWT` + the legacy
// OTSESSION ones) from the signed-in Concur tab; every API call is plain Node
// fetch with the JWT as a Bearer and the OTSESSION cookies as `Cookie`.
const bridge = createConcurBridge({ port: readWsPort(), version: VERSION });
// start() loads the fetchproxy identity (no port bind — that is lazy). A
// failure is NOT fatal: the bridge caches it and re-throws it from the first
// cookie read, so the server still boots and answers tools/list.
await bridge.start().catch(() => {});

// Built ONCE, outside the registrars (runMcp builds a server per connection).
// Nothing here resolves a credential at boot (deferred-config-error pattern):
// a bad CONCUR_DC is thrown from the first tool call, not from here.
const client = new ConcurClient({ readCookies: (dc) => bridge.readSessionCookies(dc) });

await runMcp({
  name: 'concur-mcp',
  version: VERSION,
  deps: client,
  tools: [...TOOL_REGISTRARS],
  shutdown: { onSignal: () => bridge.close() },
  banner:
    '[concur-mcp] Unofficial SAP Concur MCP. Concur has no public API for this; it uses the web app\'s internal one ' +
    'and may break or violate their ToS. Developed and maintained by AI (Claude). Use at your own discretion.',
});
