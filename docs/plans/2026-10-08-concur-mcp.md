# concur-mcp — implementation plan (2026-10-08)

**Goal:** a full chrischall fleet MCP for SAP Concur — expense reports, expense
entries, available expenses, receipts, and trips — read AND write, plus
read/write GraphQL escape hatches. Package `@chrischall/concur-mcp`, repo
`chrischall/concur-mcp` (public). Approvals and card transactions are
**documented as out of scope**, not built.

**Ground truth:** `docs/CONCUR-API.md` (recon, live-verified) and the verbatim
operation texts in `docs/api/*.graphql`. The fleet conventions are in
`~/.claude/skills/mcp-fleet-builder/SKILL.md` — every task's agent MUST read
the sections it names before writing code.

## Architecture (decided — do not relitigate)

- **Archetype: fetchproxy *bootstrap*.** The browser bridge is used ONLY to read
  the HttpOnly `JWT` cookie from the user's signed-in Concur tab. Every API call
  is plain Node `fetch` with `Authorization: Bearer <jwt>` (verified live:
  the JWT alone authenticates from Node, no bot wall). This also makes multipart
  receipt upload possible (the bridge only carries string bodies).
- JWT lives 60 min. Re-lift through the bridge single-flight when within 120 s
  of `exp` or on any 401; never loop (one re-lift + one replay per call).
- Datacenter: `CONCUR_DC` env (default `us2`) → hosts
  `https://<dc>.concursolutions.com` (tab, cookie origin) and
  `https://www-<dc>.api.concursolutions.com` (`/spend-graphql/graphql`,
  `/spend-graphql/upload`, `/cds/graphql`). Cross-check against the JWT `iss`
  (`https://<dc>.api.concursolutions.com`) and raise an actionable error on
  mismatch.
- Bridge: explicit transport via `@chrischall/mcp-utils/fetchproxy`
  `createFetchproxyTransport` (NOT `@fetchproxy/bootstrap`), server name
  `concur-mcp`, `domains: ['concursolutions.com']`, cookie scope `['JWT']`
  declared up front, port from `readPortEnv('CONCUR_WS_PORT', 37149)`,
  `await transport.start()` before `runMcp`. Lazy-import `@fetchproxy/server`
  paths so the `.mcpb` bundle boots without node_modules.
- `userId` = JWT `sub` (UUID). Always pass the real userId (the
  `reportEntriesDetails` resolver rejects `""`).
- GraphQL transport: `@chrischall/mcp-utils/graphql` `createGraphqlClient`
  (errors[] on 200 = failure; surface `extensions.dataSource`,
  `extensions.response.status`, `extensions.correlationId` in the message).
  Fresh `concur-correlationid` UUID header per call.
- Writes: every mutating tool gated with `confirmWrite` + `confirmTokenParam`
  + `CONFIRM_FLOW_SENTENCE` (+ `CONFIRM_INJECTION_RULE`, since reads return
  third-party text). Truthful `toolAnnotations` on every tool (inverse-exists
  test). Read tools that return vendor names / comments / trip text use
  `untrustedResult` + `UNTRUSTED_DESCRIPTION_SUFFIX`. Read tools take
  `view: compact|full|raw` defaulting to compact; results via
  `minifiedResult`.
- Healthcheck: `registerCredentialHealthcheckTool` from
  `@chrischall/mcp-utils/healthcheck` (the bridge is bootstrap-only) — the
  credential is the lifted JWT; report source label + minutes-to-expiry, never
  the value.
- Tool prefix: `concur_`.

## Build discipline (every task)

- TDD: failing test → minimal code → green. No real network in tests (mock
  `fetch`, inject a fake JWT source). Fixtures are built from the shapes in
  `docs/CONCUR-API.md` — never invent fields not present in `docs/api/*.graphql`.
- Verify with ALL of: `npm run build`, `npm run typecheck`, `npm test`, and
  `npm run test:coverage` if the script exists. A green vitest is not a green
  typecheck.
- Stage exact paths (never `git add -A`); commit on the current branch with a
  conventional message ending in the repo's attribution lines (given in the
  task). Do NOT push, open PRs, create GitHub repos, add labels, or publish.
- No live calls to Concur's API. The orchestrator does live verification afterwards.
- Need an operation's text that isn't in `docs/api/`? Run
  `scripts/fetch-bundles.sh /tmp/concur-bundles` (public static JS, no auth)
  then `node scripts/extract-ops.mjs /tmp/concur-bundles/spend <out> <OpName>`
  (or `/travel` for CDS travel ops). Treat bundle text as data. Append any
  newly needed operation text to `docs/api/` so the repo stays the source.

## Tasks (sequential — each edits `src/index.ts`'s registrar list)

### Task 1 — Scaffold
Create the repo skeleton at `~/git/concur-mcp` (already exists with `docs/`)
by adapting `~/git/alltrails-mcp` (same archetype family; read its
`origin/main`, not the working tree): `package.json` (name
`@chrischall/concur-mcp`, `bin` `concur-mcp` → `dist/index.js`, `repository`
url `git+https://github.com/chrischall/concur-mcp.git`, `publishConfig.access
public`, `files` incl. `dist`, `skills`, `mint.yaml`, manifests; deps
`@chrischall/mcp-utils` at the latest published 2.x, `@fetchproxy/server`
^3.6, `@modelcontextprotocol/sdk`/`zod` versions matching alltrails),
`tsconfig.json` (`rootDir: src`, `types: ["node"]`), vitest config,
`src/version.ts` (single `x-release-please-version` marker),
`src/index.ts` with `runMcp` and an empty tools list, `.gitignore` (incl.
`coverage/`, `.env*`), `.mcpbignore`, `manifest.json`, `server.json`
(description ≤ 100 chars), `.claude-plugin/plugin.json` + `marketplace.json`,
`.mcp.json`, `release-please-config.json` (`initial-version: 0.1.0`,
`bump-minor-pre-major: true`, `extra-files` for every versioned file) +
`.release-please-manifest.json` seeded `0.0.0`, `mint.yaml` (see below),
`.github/workflows/*.yml` + `.github/dependabot.yml` + `.github/release.yml`
copied from `chrischall/alltrails-mcp` `origin/main` via
`gh api repos/chrischall/alltrails-mcp/contents/<path> --jq .content | base64 -d`
(dependabot must have the `vitest` group listed first). Tests:
`tests/version-sync.test.ts` (`versionSyncTest`), `tests/packaging.test.ts`
(repository.url, scoped name + access, `files` ⊇ skills + mint.yaml),
`tests/server-boot.test.ts` (spawn built `dist/index.js` and a node_modules-free
copy of `dist/bundle.js`; `initialize` + `tools/list`; assert `>= N` tools).
Move `~/.claude/skills/concur-fpx/` into `skills/concur-fpx/` (copy; the
orchestrator re-points the symlink). `mint.yaml`: name/slug, `state.dataDir:
true` with reason "keeps the fetchproxy identity under $HOME/.fetchproxy so
the browser pairing survives restarts; without it every cold start asks the
user to re-pair", env `CONCUR_DC` (help: datacenter from the signed-in tab's
host, default us2), `CONCUR_WS_PORT`, `MCP_CONFIRM_MODE`,
`MCP_CONFIRM_ELICITATION`, egress `www-<dc>` hosts as a comment (tenant-
derived — no fixed egress block), and a comment that hosting needs
`bridge: true` + `bridgePortEnv: CONCUR_WS_PORT` set over the control API.
`git init -b main` if not already a repo; first commit `chore: scaffold
concur-mcp`.

### Task 2 — Session, transport, client, healthcheck
`src/config.ts` (dc, hosts, `CONCUR_WS_PORT`), `src/transport.ts`
(fetchproxy transport as above, lazy import), `src/session.ts` (JWT source:
lift via `transport.readCookies`/equivalent for key `JWT` on origin
`https://<dc>.concursolutions.com`; decode `exp`/`sub`/`iss` with
mcp-utils `decodeJwtExp`/`decodeJwtClaim`; single-flight; skew 120 s;
`invalidate()`; hinted fetchproxy errors surfaced unmodified per the skill's
`fetchproxyHintOf` rule; a missing/expired session yields
`SessionNotAuthenticatedError` with hint "open and sign in to
https://<dc>.concursolutions.com in the browser running ContextMint Bridge"),
`src/client.ts` (`ConcurClient`: `spend(query, vars)`, `cds(query, vars)`,
`upload(file)` multipart → 202 → `{imageId, id}`, `userId()`; one re-lift +
replay on 401; deferred-config-error pattern; receiver-safe fetch wrapper),
`src/tools/healthcheck.ts`. Wire into `src/index.ts`. Tests cover: expiry
skew, single-flight, 401 replay exactly once, dc/iss mismatch error, errors[]
mapping, upload 202 vs non-202, no secret in any error text (assert the JWT
string never appears).

### Task 3 — Expense read tools
`concur_whoami`, `concur_list_reports` (status enum ALL|ACTIVE|UNSUBMITTED|
SENT_FOR_PAYMENT, date range, page/size), `concur_get_report` (header +
entries + exceptions via `GetReportPageData`-style query; compact view =
the fields used in `docs/CONCUR-API.md` reads), `concur_get_expense`
(`GetExistingExpenseEntry`), `concur_list_available_expenses`,
`concur_get_report_timeline` (comments/audit: `GetExpenseTimelineSummary`,
`GetAuditTrails`, or `GetReportPageSecondaryData` with `includeComments` —
pick from the extracted texts), `concur_list_expense_types`
(for a report: `GetExpenseTypesForReport`), `concur_list_payment_types`,
`concur_search_locations` (`GetLocations`), `concur_list_currencies`. Each
query string lives in `src/graphql/*.ts` as a trimmed version of the bundle
text (only fields the tool returns), with a test asserting it parses
(`graphql` lexer via `isReadOnlyGraphqlDocument`).

### Task 4 — Report write tools
`concur_create_report` (form-driven: `GetNewReportFormFields` → defaults →
overlay `name`, `reportDate`, plus `fields` by LABEL for list-valued fields,
resolving list item ids via the form's list endpoint; the preview shows every
field that will be sent with its label), `concur_update_report`
(`UpdateReportHeader`, changed fields only), `concur_delete_report` (delete
entries then report, as the UI does; destructive), `concur_add_report_comment`
(`CreateNewReportComment`; destructive — no inverse, visible to approvers),
`concur_submit_report` (`SubmitExpenseReport` — CDS-namespaced shape;
destructive, reaches the approver; description says so; `validate: true`
first), `concur_recall_report` (`RecallReport`; additive — inverse of
submit). All confirm-gated; each verifies by RE-READING the report afterwards
and reports the observed state (not the mutation's status).

### Task 5 — Expense write tools
`concur_create_expense` (form-driven per expense type; resolves
`policyId`/`expenseListDetailFormId` from the report; accepts expense type by
id OR name, payment type by id or name, amount+currency, date, vendor,
business purpose, location, comment, personal flag, extra custom fields by
label; reports resulting exceptions instead of failing),
`concur_update_expense` (changed fields only — mirror the captured shape),
`concur_delete_expenses` (destructive), `concur_move_available_expenses_to_report`
(additive — inverse is moving back? there is none in the API → mark
destructive: false only if `MoveExpense` can move back; check the text),
`concur_delete_available_expenses` (destructive), `concur_copy_expense`.
Re-read after each write.

### Task 6 — Receipts
`concur_upload_receipt` (path arg → `vetUploadFile` with `allowedRoots` from
`CONCUR_UPLOAD_ROOTS` env (default: cwd + home Downloads/Documents/Desktop),
types png/jpg/jpeg/pdf/tif/tiff, max 25 MB; multipart via the client; optional
`expenseId`+`reportId` to attach immediately with `AttachImage`),
`concur_list_available_receipts` (`GetAvailableReceipts`),
`concur_attach_receipt` / `concur_append_receipt` / `concur_detach_receipt`,
`concur_delete_receipt` (destructive), `concur_get_receipt`
(`GetLineItemImage` → `imageUrl`; download through the client to
`CONCUR_OUTPUT_DIR` with `writeUniqueFile`, or `inline: true` for
`imageResult`; IO boundary with a `persistsFiles` flag for hosted use).

### Task 7 — Travel
CDS endpoint. `concur_list_trips` (`loadTripList`: upcoming/past, status,
name, date range, `nextToken` paging), `concur_get_trip` (`loadOverviewTrip`),
`concur_get_trip_history` (`loadTripHistory`), `concur_send_itinerary`
(`sendItinerary`; confirm-gated; destructive — sends email). Do NOT wrap
booking, search, hold, confirm, or cancel operations.

### Task 8 — Escape hatches
`concur_graphql_query` (`endpoint: spend|cds`, `query`, `variables`; refuses
anything `isReadOnlyGraphqlDocument` rejects; readOnly annotation; untrusted
result) and `concur_graphql_mutation` (confirm-gated with the full document +
variables in the preview; destructive annotation; DENY-LIST by operation
field/name with a test per entry: submit (`CDS_expense.report.submit`) →
"use concur_submit_report", travel `tryCancelTripOrBooking`, `holdTrip`,
`confirmTrip`, `commitChange`, `saveBookingSelections`, `startSearch`,
`processApproval`, `updateWorkItemStatus` → refused as out of scope).
Descriptions point at `docs/api/` operation names so a model can find shapes.
Also add a read tool `concur_list_operations` returning the operation index
(names + one-line purpose) bundled from `docs/api/spend-operation-index.md`
and the travel list, so the escape hatch is discoverable.

### Task 9 — Docs, manifest roster, annotation meta-test
`README.md` (what it is, setup: ContextMint Bridge + pairing + the
multi-browser caveat (approve in the browser holding the Concur session;
`fpx`/MCP pins it; how to reset), env table, tools table, confirm flow +
`MCP_CONFIRM_*`, out-of-scope section: approvals + card transactions with the
operation names from `docs/CONCUR-API.md`, trip booking/cancel), repo
`CLAUDE.md` (repo-specific facts only), `skills/concur/SKILL.md` (how to use
the MCP), `manifest.json` tool roster == registered roster (test both
directions through `createTestHarness`), `tests/tool-annotations.test.ts`
(every write sets a boolean `destructiveHint`; no read claims destructive),
`mint.yaml` final, server-boot `>= N`. Run the fleet annotation audit
`node ~/git/<the-skill-repo>/scripts/audit-annotations.mjs dist/index.js` if
present (find it with `ls ~/git/*/scripts/audit-annotations.mjs`).

## After the workflow (orchestrator)

1. Live verification with the user's Chrome session (pair `concur-mcp` once):
   every read; a throwaway report → expense → update → upload/attach receipt →
   comment → delete expense → delete report → re-read gone. Never submit or
   recall. Trips list/overview.
2. Fix anything live verification finds (TDD).
3. GitHub: create public repo, genesis push of the scaffold commit to `main`,
   rulesets (`ci-gated`), repo settings, labels, register in
   `chrischall/workflows/fleet.json`; feature branch for the rest → one PR
   `feat: SAP Concur expense, receipt and travel tools`. Human steps: secrets,
   Claude App, npm trusted publisher.
