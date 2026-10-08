# SAP Concur MCP

[![CI](https://github.com/chrischall/concur-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/concur-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/concur-mcp)](https://www.npmjs.com/package/@chrischall/concur-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/concur-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to [SAP Concur](https://www.concur.com): your expense reports, the expenses on them, available (unassigned) expenses, receipts, and Concur Travel trips — read **and** write, with every write confirmation-gated.

> [!WARNING]
> **AI-developed project.** This codebase was entirely built and is actively maintained by [Claude](https://www.anthropic.com/claude). No human has audited the implementation. Review all code and tool permissions before use.

> [!CAUTION]
> **Unofficial and unsupported.** This server does not use Concur's documented partner API. It calls the internal GraphQL API the Concur web app itself uses, authenticated with your own signed-in browser session. It may break without notice, and automated use may conflict with SAP Concur's or your employer's terms. Use it only for your own account, at your own discretion.

## What you can do

Ask Claude things like:

- *"Which of my Concur reports are still unsubmitted, and what's blocking them?"*
- *"Show me the card transactions that aren't on a report yet."*
- *"Create a report called 'Austin offsite' and move last week's Uber and hotel charges onto it."*
- *"Upload ~/Downloads/dinner.pdf and attach it to the dinner expense."*
- *"When does my next trip leave, and what hotel am I in?"*

## Requirements

- [Claude Desktop](https://claude.ai/download), Claude Code, or any MCP host
- [Node.js](https://nodejs.org) 22.5 or later
- The [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) browser extension and a signed-in Concur tab (`https://<dc>.concursolutions.com/…`)

## Installation

### Claude Code plugin

```bash
claude plugin marketplace add chrischall/concur-mcp
claude plugin install concur@chrischall
```

### Any MCP host (npx)

```json
{
  "mcpServers": {
    "concur": {
      "command": "npx",
      "args": ["-y", "@chrischall/concur-mcp"],
      "env": { "CONCUR_DC": "us2" }
    }
  }
}
```

### Claude Desktop (.mcpb)

Install the `.mcpb` bundle from the [latest release](https://github.com/chrischall/concur-mcp/releases). The installer asks for your datacenter (default `us2`).

## How it authenticates

Concur's web app authenticates its API calls with an HttpOnly `JWT` cookie that the page itself cannot read. This server uses the [fetchproxy](https://github.com/chrischall/fetchproxy) bridge **only to read three session cookies** from your signed-in Concur tab: `JWT`, plus Concur's legacy session cookies `OTSESSIONAABQRD` and `OTSESSIONAABQRN`. Every API call is then made from Node with `Authorization: Bearer <jwt>` and a `Cookie` header carrying whichever OTSESSION cookies the tab had — the parts of Concur still served by its legacy services (report keys, currencies, available receipts, permissions) answer an error without them. The cookies are held in memory only and never appear in an error or a log; the only thing written under your home directory is the bridge's pairing identity.

The token lives 60 minutes. The server re-reads the cookies (all together) from your tab when the token is within two minutes of expiry, or once on a `401` (one re-read and one retry per call, never a loop). A read that fails the way a stale OTSESSION cookie fails gets the same single re-read and retry. Concur keeps the cookies fresh while a tab is open, so **keep a signed-in Concur tab open** while you use the tools. `concur_healthcheck` reports which source supplied the token, how many minutes it has left and whether the legacy session cookie was found — never a cookie value.

> **Upgrading from an earlier build?** The bridge scope grew from `JWT` alone to `JWT` + the two OTSESSION cookies. The pair grant is per-scope, so an already-paired server must be **re-approved once**: the next call answers with a new pair code (or a scope-changed notice) — approve it in the ContextMint Bridge popup.

### Pairing (once)

1. Install [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) (Chrome: load the release zip unpacked) and sign in to Concur in that browser.
2. Ask Claude to run `concur_healthcheck`. The first call answers with a **pair code**.
3. Approve that code in the ContextMint Bridge popup. The trust persists across restarts (it lives in `~/.fetchproxy/identity/`).

**More than one browser?** If ContextMint Bridge is installed in several browsers, each one dials the same local port, and the pair code can be approved in any of them. **Approve it in the browser that holds your Concur session** — the server pins whichever extension approved it, and only that browser's tab can supply the cookie. Lines like `refusing an extension whose identity is not the one this MCP paired with` on stderr are the *other* browser being turned away; they are harmless.

**Paired the wrong browser, or changed browsers?** Revoke `concur-mcp` in the ContextMint Bridge popup, clear the server's pinned extension with `fpx trust clear concur-mcp` (from [`@fetchproxy/cli`](https://www.npmjs.com/package/@fetchproxy/cli); or delete `~/.fetchproxy/identity/concur-mcp.extension-trust.json`), restart the server, and pair again from the right browser.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONCUR_DC` | `us2` | Your datacenter: the first label of your signed-in tab's host (`us2` for `us2.concursolutions.com`, `eu2`, …). Must match the session token's issuer, or every call fails with an error that says which value to use. |
| `CONCUR_WS_PORT` | `37149` | The fetchproxy bridge port. The whole fetchproxy fleet and ContextMint Bridge share `37149`; override only for local testing (or when a host injects a per-registration port). |
| `CONCUR_OUTPUT_DIR` | working directory | Where `concur_get_receipt` saves downloaded receipts (never overwriting an existing file). |
| `CONCUR_UPLOAD_ROOTS` | cwd, `~/Downloads`, `~/Documents`, `~/Desktop` | The only folders `concur_upload_receipt` will read from (a path-delimiter-separated list; `~` expanded). Hosted (with `MCP_DATA_DIR` set) the default is `$MCP_DATA_DIR/uploads`. |
| `CONCUR_INLINE_RECEIPTS` | off locally, on when hosted | `true` makes `concur_get_receipt` return the image in the result instead of writing a file. |
| `CONCUR_DEBUG` | off | Log the bridge's role and lifecycle to stderr. |
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt — see below. |
| `MCP_CONFIRM_ELICITATION` | `on` | `off` never shows a confirmation prompt, so every client takes the `MCP_CONFIRM_MODE` path (for clients that declare prompts but never render them). |

## Confirming writes

Every tool that changes something in Concur (or emails someone) is confirmation-gated:

- **Clients that support MCP elicitation** show a real confirmation prompt describing exactly what will be sent.
- **Elsewhere (claude.ai, Claude Desktop)** the first call makes **no** change: it returns a preview of exactly what would be sent plus a single-use, short-lived `confirmToken`. Only a repeat call carrying that token writes, and if anything in the request changed in between, the token is refused.

`MCP_CONFIRM_MODE` decides who may use that token:

| Value | Behaviour |
|---|---|
| `ask-user` (default) | The model must show you the preview and get your approval in chat before reusing the token. |
| `auto` | The model may use the token itself after seeing the preview. |
| `refuse` | Writes are refused on clients without a confirmation prompt. An unrecognised value is treated as `refuse`. |

Text that comes back from Concur — vendor names, comments, trip details, emails — is treated as untrusted data: it can never authorise a write.

## Tools

Most read tools take `view: compact | full | raw` (default `compact`): `compact` drops the fields you rarely need, `full` keeps them all, `raw` is Concur's response unprojected.

### Session and lookups

| Tool | What it does |
|---|---|
| `concur_healthcheck` | Which source supplied the token, whether the API accepted it, round-trip time, minutes to expiry |
| `concur_whoami` | Your Concur user id, datacenter, token minutes left, and enabled features |
| `concur_list_expense_types` | Expense types a report's policy allows (id, name, group) |
| `concur_list_payment_types` | Payment types you can put on an expense (cash, company card, …) |
| `concur_list_currencies` | Currencies Concur accepts, optionally filtered |
| `concur_search_locations` | Expense locations by city (optionally country / subdivision) |

### Reports and expenses (read)

| Tool | What it does |
|---|---|
| `concur_list_reports` | Your reports by status (`ALL`, `ACTIVE`, `UNSUBMITTED`, `SENT_FOR_PAYMENT`) and date range |
| `concur_get_report` | One report: header, every expense entry, and its exceptions (`blocking` ones prevent submission) |
| `concur_get_report_timeline` | A report's timeline (comments and workflow events) and audit trail |
| `concur_get_expense` | One expense: form fields by label, itemizations, receipt, comments, exceptions |
| `concur_list_available_expenses` | Card transactions, e-receipts and mobile captures not yet on a report |

### Reports and expenses (write — all confirmation-gated)

| Tool | What it does | Reversible? |
|---|---|---|
| `concur_create_report` | Create an unsubmitted report | yes (`concur_delete_report`) |
| `concur_update_report` | Change header fields; sends only what changes | yes |
| `concur_delete_report` | Delete an unsubmitted report **and every expense on it** | **no** |
| `concur_add_report_comment` | Add a comment approvers will see | **no** (comments cannot be deleted) |
| `concur_submit_report` | Send a report to your approver | **no** — it reaches a person; `concur_recall_report` can pull it back before approval |
| `concur_recall_report` | Recall a submitted, unapproved report | yes |
| `concur_create_expense` | Add an expense to an unsubmitted report | yes |
| `concur_update_expense` | Change an expense; sends only what changes | yes |
| `concur_delete_expenses` | Delete expenses from a report (card transactions return to available expenses) | **no** |
| `concur_copy_expense` | Duplicate an expense | yes |
| `concur_move_available_expenses_to_report` | Move available expenses onto a report | **no** (Concur has no move-back) |
| `concur_delete_available_expenses` | Delete available expenses | **no** |

### Receipts

| Tool | What it does | Gated? |
|---|---|---|
| `concur_list_available_receipts` | Receipt images in your receipt store that are not attached to an expense | read |
| `concur_get_receipt` | Download a receipt image to `CONCUR_OUTPUT_DIR` (or inline) | local file only |
| `concur_upload_receipt` | Upload a png / jpg / pdf (≤ 25 MB) from an allowed folder | yes |
| `concur_attach_receipt` | Attach a stored image to an expense that has none | yes |
| `concur_append_receipt` | Add a stored image as an extra page of an expense's receipt | yes |
| `concur_detach_receipt` | Take the image off an expense | yes |
| `concur_delete_receipt` | Delete an unattached receipt image — **cannot be undone** | yes |

### Travel

| Tool | What it does |
|---|---|
| `concur_list_trips` | Your trips (upcoming by default; past or all), filterable |
| `concur_get_trip` | One trip with its flight, hotel, car and rail bookings |
| `concur_get_trip_history` | A trip's history: changes, approvals, itinerary emails |
| `concur_send_itinerary` | Email a trip's itinerary — **sends real email**, confirmation-gated |

### Escape hatches

| Tool | What it does |
|---|---|
| `concur_list_operations` | The GraphQL operations the Concur web app uses — name, endpoint, purpose, and which dedicated tool already runs it |
| `concur_graphql_query` | Run a raw read-only query (`spend` or `cds` endpoint); refuses anything that could write |
| `concur_graphql_mutation` | Run a raw mutation, confirmation-gated with the full document in the preview; refuses the operations listed under Out of scope, including submit (use `concur_submit_report`) |

## Out of scope

These exist in Concur but are deliberately **not** built. Not built is not the same as refused: the raw escape hatches can still reach anything below that the guard does not name.

Refused by `concur_graphql_mutation` (matched by operation name and by the field the web app's text selects, so renaming or aliasing does not get through): `processApproval`, `updateWorkItemStatus`, `startSearch`, `saveBookingSelections`, `holdTrip`, `confirmTrip`, `commitChange`, `tryCancelTripOrBooking`, and `SubmitExpenseReport` (use `concur_submit_report`).

- **Approvals** — approving or sending back other people's reports (`contextRole: MANAGER`). Not built: the `approvalsportal.asp` page, the `GetApproversList` and `loadApprovalDetails` reads, and the `UpdateTimelineWorkflow` call. Refused: CDS `processApproval`, and `updateWorkItemStatus` (`updateDelegatesDashboardWorkItemStatus`). This server acts only on your own data.
- **Card-transaction management** — the card accounts page and its operations: `/Expense/Client/cardtransactions.asp`, `GetCardAccounts`, `GetCardTransaction`, `MoveCCTransactionsToReport`, `CreateCBSReportAndMoveCCTransactionsToReport`, `RefreshYodleeTransactions`. (Card charges that already appear as available expenses *are* covered — list, move to a report, delete.)
- **Booking or cancelling travel** — search, price, book, hold, confirm or cancel (`startSearch`, `saveBookingSelections`, `holdTrip`, `confirmTrip`, `commitChange`, `tryCancelTripOrBooking`). Trips are read-only apart from emailing the itinerary.

## Development

```bash
npm install
npm run build        # tsc → dist/, then esbuild → dist/bundle.js (the .mcpb entry)
npm test             # typecheck + vitest
npm run test:coverage
```

The API surface this is built on — hosts, auth, every operation used, and what was verified live — is in [`docs/CONCUR-API.md`](docs/CONCUR-API.md), with verbatim operation texts in [`docs/api/`](docs/api/).

## License

MIT
