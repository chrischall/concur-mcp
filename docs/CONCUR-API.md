# SAP Concur — API surface (recon 2026-10-08)

Everything here was observed live against a real `us2` account through the
signed-in web app, or read from the web app's own public JS bundles
(`static.concursolutions.com`). Operation texts are in `docs/api/*.graphql`
(verbatim from the bundles, fragments resolved). No credential, cookie, or
account id appears in this repo.

## Hosts

| Host | What |
|---|---|
| `<dc>.concursolutions.com` (`us2`, `eu2`, …) | the web app (pages, classic ASP) |
| `www-<dc>.api.concursolutions.com/spend-graphql/graphql` | expense GraphQL (reports, entries, receipts, available expenses) |
| `www-<dc>.api.concursolutions.com/spend-graphql/upload` | receipt upload (multipart) |
| `www-<dc>.api.concursolutions.com/cds/graphql` | "CDS" GraphQL — travel (trip list/overview), some expense helpers |
| `static.concursolutions.com` | public JS bundles (operation source) |

`<dc>` is the datacenter from the signed-in tab's host. Introspection is
disabled on both GraphQL endpoints (`__schema` → 400/403); the bundles are the
only schema source.

## Auth — VERIFIED

- The web app calls both GraphQL endpoints with `credentials: 'include'` and NO
  auth header. The session is cookies on `.concursolutions.com`.
- The cookie that matters is **`JWT`** (HttpOnly — invisible to
  `document.cookie`). Replayed from Node (plain `fetch`, no browser), the JWT
  alone authenticates — as the `JWT` cookie **or** as
  `Authorization: Bearer <jwt>` — HTTP 200 with data. No Akamai/bot-wall
  interference on the API host from Node (tested with a Node UA and a Chrome
  UA). No credential → `401` HTML.
- JWT: `iss https://<dc>.api.concursolutions.com`, `aud *`, `concur.type user`,
  **60-minute lifetime** (`exp - iat`). `sub` = the user's UUID (= `userId`).
  Carries `concur.ip`/`concur.ipr` claims — an IP binding is possible; from the
  same machine it worked. Untested from a different egress IP (matters for
  mcp-host hosting only).
- **Legacy-backed fields also need an OTSESSION cookie (verified 2026-10-08).**
  With `Authorization: Bearer <JWT>` alone, Node gets HTTP 200 with
  `errors: [{"message":"An error occurred","path":[…],"extensions":{}}]` —
  EMPTY `extensions` — for `employee.reportsForUser.list[].rptKey`,
  `employee.expenseReport.rptKey`, `userPermissions`, `currencies`,
  `employee.availableReceipts` (and likely anything else served by Concur's
  legacy services). Adding a `Cookie` header with `OTSESSIONAABQRD=<v>` and/or
  `OTSESSIONAABQRN=<v>` fixes it — either one alone is enough. Bearer +
  `OTSEC670817` or + `origin_dc` does NOT help. Cookies only
  (`JWT=…; OTSESSIONAABQRD=…`) also works. An empty-`extensions` error on a 200
  is therefore the signature of a stale or missing OTSESSION cookie.
- The web app keeps the JWT fresh while a tab is open. No browser-free refresh
  endpoint was found (portal scripts reference `/nui/signin/setsession`;
  uninvestigated). **Design: lift the `JWT`, `OTSESSIONAABQRD` and `OTSESSIONAABQRN` cookies
  through the fetchproxy bridge (`read_cookies`, one call), call everything from
  Node with `Authorization: Bearer` + `Cookie: <the OTSESSION ones>`, and
  re-lift on 401, on an empty-extensions field error (reads only), or when
  within ~2 min of `exp`.**

Required headers: `content-type: application/json`. The app also sends
`accept`, `accept-language`, `concur-correlationid` (a random UUID per call) —
send a fresh `concur-correlationid` (harmless, aids support traces).

## GraphQL conventions — VERIFIED

- `employee(userId: "", contextRole: TRAVELER)` resolves to the signed-in user —
  BUT `reportEntriesDetails(userId: …)` rejects `""` (400 from
  `ExpenseReportService`). Always resolve the real `userId` first
  (`employee(userId:"",…){ userId }` or the JWT `sub`) and pass it everywhere.
- `contextRole`: `TRAVELER` (own data). Others in the bundle: `PROXY`,
  `MANAGER`, `EMPLOYEE` (approvals/delegates — out of build scope).
- Errors arrive on **HTTP 200** as `errors[]` with an opaque
  `message: "An error occurred"`; useful detail is in
  `extensions.dataSource` + `extensions.response.status` +
  `extensions.correlationId`. Partial data is common (one field errors, the
  rest return). Treat any `errors[]` as a failure of THAT field.
- Ids: report/expense ids are 20-char uppercase hex (`reportId`), expense
  entries 32-char hex; `rptKey`/`rpeKey` are legacy numeric keys.

## Reads — VERIFIED live

- **Report list**: `employee.reportsForUser(input:{filterByStatus, dateRange:{start,end}, paging:{page,size}, sortBy, sortDirection})`.
  `filterByStatus` enum seen: `ALL`, `ACTIVE`, `UNSUBMITTED`, `SENT_FOR_PAYMENT`.
  Dates `YYYY-MM-DD`. Page size 100 is what the app uses. Fields: see
  `GetReportsForUser` in `docs/api/spend-reads.graphql`.
- **Report header**: `employee.expenseReport(reportId){ reportDetails{…} }`.
- **Report entries**: top-level `reportEntriesDetails(userId, reportId, contextRole){ entries{ expenseId summary{…} } }` — needs the real userId.
  `vendor` usually lands in `vendor.description` (not `name`).
  `transactionAmount` = spend currency; `postedAmount` = report currency.
- **Report comments + timeline** (verified live 2026-10-08): top-level
  `timelineSummary(userId, reportId, contextRole){ summaryDate summaryItems{…} }`
  — the web app's `GetExpenseTimelineSummary`. Comments live HERE, NOT in
  `employee.expenseReport.reportDetails.comments`, which stayed `[]` after a
  successful `createNewReportComment`. Before the comment the answer was
  `{"timelineSummary":[]}`; right after it, one day whose single item was
  `{id, action:null, authorName:"Chris Hall", comment:"…", commentSource:null,
  commentType:"report", creationDate:"2026-10-08T18:50:11.580Z"}`. Workflow
  events (submitted, approved, …) come through the same list with `action` set.
  `createNewReportComment` can select `timelineSummary` itself, so a comment can
  be verified from the mutation's own answer.
- **Available expenses** (not on a report): `employee.availableExpensesWithPagination(pagination:{page,size}, params)`.
  Rows still being OCR'd come back all-null with `meta.missingData` populated.
- **Trips**: CDS `travel.trips.list(filter:{quick:[PAST_TRIPS|UPCOMING_TRIPS], tripName, tripStatus:[], fromDate, toDate}, sort:{sortBy:START_DATE, direction:ASCENDING}, nextToken)` — op `loadTripList`; succeeded in-tab (200). Not yet exercised from Node.

## Writes — CAPTURED from the real UI (throwaway report, since deleted)

All on `spend-graphql`. Variables shown with ids elided.

### Create report — `CreateReportHeader`
```
vars: { userId, contextRole: "TRAVELER",
  fields: { name, reportDate: "YYYY-MM-DD", businessPurpose: "",
    policyId, countryCode: "US", comment: "", reportSource: "WEB",
    orgUnit1..orgUnit5: {value: <listItemId>},     // defaults from the form
    custom5: {value: <listItemId>},                // "Business Purpose" list (required on this tenant)
    custom7: {value: ""}, custom15: {value: <id>}, custom16: {value: "012345"} } }
resp: data.createReport.reportId
```
The header is **form-driven and tenant-specific**: fetch
`GetNewReportFormFields(userId, contextRole, policyId?)` → `newReportForm.fields[]`
(`FormFieldFragment`) and its default values, then overlay the caller's name /
date / purpose. On this tenant the visible "Business Purpose" dropdown is
`custom5` (a list), while the free-text `businessPurpose` was sent empty.
The tool must expose list-valued fields by label and resolve the list item id
(`GetFormListItems` / `GetListItems`), not hardcode `custom5`.

Live `newReportForm.fields` on this tenant (2026-10-08) — labels are NOT unique:
- `{id: "businessPurpose", label: "Business Purpose", dataType: "STRING", isRequired: false}`
- `{id: "custom5", label: "Business Purpose", dataType: "LIST", isRequired: true}` —
  the dropdown the UI shows (it sent `businessPurpose: ""`, `custom5: {value: <listItemId>}`;
  "Internal Meetings/Expenses" is one of its items).
- `policy` LIST required; `custom15` "Expense Group ID" LIST; `custom7` "Product
  Code" LIST; `orgUnit1..5` CONNECTED_LIST / LIST.
- Many required read-only computed fields (`reportTotal`, `approvalStatus`,
  `hasExceptions`, `amountDueEmployee`, … — dataType AMOUNT / BOOLEAN / INTEGER)
  that carry an `accessMode`.
- Field keys: accessMode, control, dataType, defaultValue, formFieldId, id,
  isRequired, label, list, maximumLength, options, value. The `accessMode` enum
  values are not in the bundle texts.
Followed by `AddMultipleRecentLists` (MRU bookkeeping — skip).

### Create expense — `SaveNewExpenseEntry`
```
vars: { userId, contextRole, reportId, expenseTypeId: "DUESX", policyId,
  expenseListDetailFormId, isTrexEnabled: true|false, taxFields: null,
  shouldIncludeRpeKey: false, showAttendeeField: false,
  fields: { expenseTypeId, transactionDate, businessPurpose, vendorName,
    locationId: null, paymentTypeId: "CASH",
    transactionAmount: {value: 1.23, currencyCode: "USD"},
    exchangeRate: {operation: "MULTIPLY", value: 1},
    taxRateLocation: "HOME", receiptTypeId: "", isExpensePartOfTravelAllowance: false,
    comment: "", isPersonalExpense: false, receiptImageId: null,
    custom1|2|3|18|19|37: {listItemId: null, value: null},
    custom15|20|21: {value: "false"} } }
resp: data.createExpense.id  (+ CDS_addRecentExpenseTypes)
```
Form-driven per expense type (`GetNewExpenseEntry` / `GetExpenseFormExpenseTypes`).
`policyId` and `expenseListDetailFormId` come from the report
(`reportDetails.policy`). Saving with missing required fields SUCCEEDS but
attaches exceptions ("missing required information") — report it, don't fail.
Use `isTrexEnabled: false` to skip the heavy response fragments (verify).
concur-mcp drops those `@include(if: $isTrexEnabled)` blocks from its trimmed
texts entirely and re-reads with `GetExistingExpenseEntry` instead.
A selected list-valued custom field is sent as `{listItemId: <item id>, value: <item text>}`
— inferred from the bundle (the form state keeps `{listItemId, value}` pairs), NOT
yet live-captured; an empty one is `{listItemId: null, value: null}` (captured).

### Update expense — `UpdateExistingExpenseEntry`
Sends ONLY changed fields: `fields: { transactionAmount: {value: 2.34, currencyCode: "USD"} }`
plus `{userId, contextRole, reportId, expenseId, expenseTypeId: "", policyId,
expenseListDetailFormId, shouldCopyDownFields: false, updateRecentExpenseType: false,
isTrexEnabled, taxFields: null, showAttendeeField: false}` → `data.updateExpense`.

### Delete expenses — `DeleteExpenseEntries`
`{userId, contextRole, reportId, expenseIds: [..]}` →
`employee.expenseReport.deleteExpenseEntries.status.success === true`.

### Delete report — `DeleteExpenseReport`
`{userId, contextRole, reportId}` → `employee.expenseReport.deleteReport.status.success`.
The UI deletes the report's entries first (`DeleteExpenseEntries`), then the report.

### From the bundle, NOT yet exercised (shapes in `docs/api/spend-operations.graphql`)
- `MoveAvailableExpensesToReport(userId, contextRole, ids, reportId)`
- `DeleteAvailableExpenses`
- `CreateNewReportComment(userId, reportId, contextRole, comment)` — exercised live 2026-10-08; the comment shows up in `timelineSummary` (see Reads).
- `AttachImage / AppendImage / DetachImage (userId, contextRole, reportId, expenseId, imageId?)`
- `DeleteReceipt(imageId)`
- `SubmitExpenseReport` — **CDS-namespaced**: `CDS_expense.report.submit(contextType, id, userId, validate, reportSource, approverValidated){status}`. Reaches the approver. NEVER live-tested.
- `RecallReport(contextRole, reportId, userId)` — NEVER live-tested.
- `CopyExpenseEntry`, `MoveExpense`, `UpdateReportHeader`, allocations, attendees, itemizations.
- `MoveExpense` moves entries report → report (`fromReportId`/`toReportId`); nothing in the
  bundle moves an entry back to available expenses, so `MoveAvailableExpensesToReport` has no
  inverse (deleting the entry is the only way off the report).

### Receipt upload — from the bundle
`POST https://www-<dc>.api.concursolutions.com/spend-graphql/upload`
(`spendGraphql.url.replace('/graphql','/upload')`), `multipart/form-data` with
one part named `file`; header `concur-correlationid: <uuid>`; optional query
`isExpenseItUpload=true`, `reportIdForExpenseItOnReport`,
`entryIdForExpenseItOnEntry`. **Success is HTTP 202** with JSON
`{ imageId, id }`. Then `AttachImage(imageId)` onto an entry. Accepted types
(UI): png, jpg, jpeg, pdf, tif, tiff. Needs the Node path — the fetchproxy
bridge only carries string bodies.

## Travel (CDS) — from the bundle

Trip list `loadTripList`, trip detail `loadOverviewTrip`, `loadTripHistory`,
`booking`, `loadTripActivities`; writes include `sendItinerary` (emails),
`tryCancelTripOrBooking` + `cancelSummary` (cancels a real booking),
`holdTrip`, `confirmTrip`, and the whole search/book flow
(`initializeSearch`, `startSearch`, `saveBookingSelections`, …).
Texts for the first eight are in `docs/api/travel-operations.graphql`.

Facts pulled from the trip bundle (not yet exercised from Node):
- `sendItinerary` input (`TravelTripSendItineraryEmailInput`) is exactly
  `{ tripId, recipients: [String], subject, message }` — the UI requires a
  subject (max 150 chars), message may be `""`; it answers `{ tripId }`.
- `loadTripList` sort: `sortBy` ∈ `START_DATE | END_DATE | CREATED_TIME`,
  `direction` ∈ `ASCENDING | DESCENDING`; dates are `YYYY-MM-DD`. `quick` and
  `tripStatus` values are server-supplied strings echoed back in
  `meta.filter` (the UI starts with `quick: ["UPCOMING_TRIPS"]`).
- The list result is a union: `TravelTripListSuccessResult` or
  `TravelErrorResponse { messages { code type } }`.

## Out of build scope (documented only)

- **Approvals** (`contextRole: MANAGER`): `approvalsportal.asp`, `GetApproversList`,
  `UpdateTimelineWorkflow`, CDS `processApproval`, `loadApprovalDetails`.
- **Card transactions**: `/Expense/Client/cardtransactions.asp`, `GetCardAccounts`,
  `GetCardTransaction`, `MoveCCTransactionsToReport`,
  `CreateCBSReportAndMoveCCTransactionsToReport`, `RefreshYodleeTransactions`.
- **Booking travel** (search/price/book) and **cancelling bookings**.
