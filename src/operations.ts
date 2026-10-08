// The operation index behind concur_list_operations: every GraphQL operation
// the Concur web app's bundles carry (spend: docs/api/spend-operation-index.md;
// travel: the operations in docs/api/travel-operations.graphql), so the raw
// escape hatches are discoverable. Bundled as data because the .mcpb ships
// without docs/. tests/operations.test.ts keeps it in sync with docs/api/.

import { DENIED_MUTATIONS } from './graphql-guard.js';

export type GraphqlEndpoint = 'spend' | 'cds';

export interface OperationEntry {
  name: string;
  endpoint: GraphqlEndpoint;
  kind: 'query' | 'mutation';
  /** One line on what it does (or why to use something else). */
  purpose: string;
  /** The docs/api file holding its verbatim text, when the repo has it. */
  text?: string;
  /** The dedicated tool that already runs it — prefer that tool. */
  tool?: string;
  /** Set when concur_graphql_mutation refuses it. */
  refused?: true;
}

/** Where the verbatim operation texts live (not shipped in the package). */
export const OPERATION_TEXTS_URL = 'https://github.com/chrischall/concur-mcp/tree/main/docs/api';

// ── spend-graphql (docs/api/spend-operation-index.md, verbatim) ────────────

const SPEND_QUERIES: readonly string[] = [
  'GetAirlineFeeTypes', 'GetAirlineServiceCodes', 'GetAllocationData', 'GetAllocationFavorite',
  'GetAllocationFavorites', 'GetAllocationFormFieldsWithDefaults', 'GetAllocationGroup', 'GetAllocationPermissions',
  'GetAllocationPermissionsForAllocationLevel', 'GetAllocations', 'GetAllocationsTotals', 'GetApproversList',
  'GetAssociatedAttendees', 'GetAttendeeGroupDetails', 'GetAttendees', 'GetAttendeesByPredictiveSearch',
  'GetAttendeesMeta', 'GetAuditTrails', 'GetAvailableExpense', 'GetAvailableExpenses', 'GetAvailableReceipts',
  'GetBulkEditFormFields', 'GetCardAccounts', 'GetCardAndReportDetails', 'GetCardTransaction',
  'GetCashAdvanceGroupSettings', 'GetComplianceResultsForEntry', 'GetConfirmationAgreement', 'GetCountries',
  'GetCountrySubdivisions', 'GetCurrencies', 'GetDefaultPolicyExpenseTypes', 'GetEmtLocations', 'GetEntityId',
  'GetEntryDetailsForAttendees', 'GetEntrySuggestions', 'GetEreceiptHtml', 'GetExchangeRate',
  'GetExistingEntryExceptions', 'GetExistingEntryTaxForms', 'GetExistingExpenseEntries', 'GetExistingExpenseEntry',
  'GetExistingExpenseEntryForReceipts', 'GetExistingExpenseForm', 'GetExistingItemizationForm',
  'GetExpenseAssistantSettings', 'GetExpenseEntryComments', 'GetExpenseEntryForAttendees',
  'GetExpenseEntryForCardSource', 'GetExpenseEntryForExpenseSource', 'GetExpenseFormExpenseTypes', 'GetExpenseImage',
  'GetExpenseProviderData', 'GetExpenseReportDetails', 'GetExpenseReportForAddModal', 'GetExpenseTimelineSummary',
  'GetExpenseTypes', 'GetExpenseTypesForReport', 'GetExternalListItemId', 'GetFormListItems',
  'GetGroupSettingsForReceipts', 'GetHomepageSettings', 'GetItemizationDetails', 'GetItemizationWizardForm',
  'GetLaunchExternalUrlConfig', 'GetLineItemImage', 'GetLineItemImageForExpenseSource', 'GetLineItemImages',
  'GetListItems', 'GetLocations', 'GetManageAIGroupingData', 'GetMissingReceiptDeclarationLinkData',
  'GetMRUAttendees', 'GetNewEntryTaxForms', 'GetNewExpenseEntry', 'GetNewItemizationExpenseTypesForm',
  'GetNewItemizationForm', 'GetNewReportFormFields', 'GetOmnisearchLocations', 'GetPaymentTypes', 'GetPolicies',
  'GetPolicyTravelAllowanceDisabled', 'GetPopoverEntry', 'GetPopoverEntryAllocation', 'GetPrintReportTemplate',
  'GetProcessingReceipts', 'GetReceiptData', 'GetReceiptProcessingStatus', 'GetReceiptTypes',
  'GetRecentExpenseTypes', 'GetRecentLists', 'GetRecentLocations', 'GetReportAttachments',
  'GetReportDetailsForTimeline', 'GetReportEmployee', 'GetReportExceptionsAndEntries', 'GetReportFormFields',
  'GetReportForRequests', 'GetReportHeaderExceptions', 'GetReportIdAndKey', 'GetReportMeta', 'GetReportPageData',
  'GetReportPageSecondaryData', 'GetReportPayments', 'GetReportRequests', 'GetReportsForUser',
  'GetReportSuggestions', 'GetReportTotals', 'GetReportTravelAllowanceStatus', 'GetRptKey', 'GetSearchSettings',
  'GetSiteSettings', 'GetSponsors', 'GetSuggestedAttendees', 'GetTaxLocationCategory', 'GetTextAppStatus',
  'GetTimelineWorkflow', 'GetTravelAllowanceConfig', 'GetTravelAllowancePolicies', 'GetTravelDiaries',
  'GetTravelDiaryLabels', 'GetTravelRequests', 'GetTripDetails', 'GetUserAIPermissions', 'GetUserPermissions',
  'GetXmlReceipt',
];

const SPEND_MUTATIONS: readonly string[] = [
  'AcceptAvailableExpenseMatch', 'AcceptSuggestedAttendees', 'AddBulkSysEmpAttendeesByEmail',
  'AddMultipleRecentLists', 'AppendImage', 'AssociateCashAdvancesWithReport', 'AssociateRequestsWithReport',
  'AttachImage', 'CombineAvailableExpenses', 'CombineExpenseEntries', 'CopyExpenseEntry', 'CopyExpenseReport',
  'CopyItemization', 'CreateAffidavits', 'CreateCBSReportAndMoveCCTransactionsToReport',
  'CreateCBSReportAndMoveExpensesToReport', 'CreateDifferentRoomRateMutation', 'CreateItemizationsFromWizard',
  'CreateNewReportComment', 'CreateReport', 'CreateReportFromTrip', 'CreateReportHeader',
  'CreateSameRoomRateMutation', 'CreateTravelDiary', 'DeclineAvailableExpenseMatch', 'DeleteAllocationFavorite',
  'DeleteAvailableExpenses', 'DeleteExpenseEntries', 'DeleteExpenseReport', 'DeleteReceipt',
  'DeleteReportAttachments', 'DeleteTravelDiaries', 'DeleteXmlReceipt', 'DetachImage',
  'DissociateCashAdvancesFromReport', 'EditExpenseIt', 'ExportReportAsEmail', 'FindMatchingAvailableExpenses',
  'MarkDelegateReviewed', 'MarkReportAsSeen', 'MatchAvailableExpensesToReport', 'MoveAvailableExpensesToReport',
  'MoveCCTransactionsToReport', 'MoveExpense', 'RecalculateTaReport', 'RecallReport', 'RefreshYodleeTransactions',
  'RemoveSuggestedAttendees', 'ReopenReport', 'SaveAllocationFavorite', 'SaveAllocations', 'SaveBulkEditExpenses',
  'SaveExpenseAttendees', 'SaveExpenseTypeMRUs', 'SaveNewExpenseEntry', 'SaveNewItemization',
  'SaveRecurringItemizations', 'SeparateAvailableExpense', 'SetAgenticReportGrouping',
  'SetDisableAgenticReportUntil', 'SubmitExpenseReport', 'TabTracking', 'UnmarkDelegateReviewed',
  'UpdateComplianceResponse', 'UpdateExistingExpenseEntry', 'UpdateExistingItemization', 'UpdateExpenseAssistant',
  'UpdateReport', 'UpdateReportHeader', 'UpdateTimelineWorkflow', 'UpdateTravelDiary',
];

const SPEND_DOCUMENTED: Readonly<Record<string, string>> = {
  GetReportsForUser: 'spend-reads.graphql',
  GetReportPageData: 'spend-reads.graphql',
  GetReportPageSecondaryData: 'spend-reads.graphql',
  GetAvailableExpenses: 'spend-reads.graphql',
  GetAvailableExpense: 'spend-reads.graphql',
  GetExistingExpenseEntry: 'spend-reads.graphql',
  GetExpenseEntryComments: 'spend-reads.graphql',
  GetExpenseTypesForReport: 'spend-reads.graphql',
  GetPaymentTypes: 'spend-reads.graphql',
  GetCurrencies: 'spend-reads.graphql',
  GetLocations: 'spend-reads.graphql',
  GetAttendees: 'spend-reads.graphql',
  GetAllocations: 'spend-reads.graphql',
  GetItemizationDetails: 'spend-reads.graphql',
  GetAuditTrails: 'spend-reads.graphql',
  GetExpenseTimelineSummary: 'spend-reads.graphql',
  GetReportExceptionsAndEntries: 'spend-reads.graphql',
  GetTravelRequests: 'spend-reads.graphql',
  GetCardTransaction: 'spend-reads.graphql',
  GetCardAccounts: 'spend-reads.graphql',
  GetApproversList: 'spend-reads.graphql',
  GetUserPermissions: 'spend-reads.graphql',
  CreateReport: 'spend-operations.graphql',
  CreateReportHeader: 'spend-operations.graphql',
  UpdateReportHeader: 'spend-operations.graphql',
  UpdateReport: 'spend-operations.graphql',
  DeleteExpenseReport: 'spend-operations.graphql',
  SaveNewExpenseEntry: 'spend-operations.graphql',
  UpdateExistingExpenseEntry: 'spend-operations.graphql',
  DeleteExpenseEntries: 'spend-operations.graphql',
  MoveAvailableExpensesToReport: 'spend-operations.graphql',
  DeleteAvailableExpenses: 'spend-operations.graphql',
  SubmitExpenseReport: 'spend-operations.graphql',
  RecallReport: 'spend-operations.graphql',
  CreateNewReportComment: 'spend-operations.graphql',
  AttachImage: 'spend-operations.graphql',
  DetachImage: 'spend-operations.graphql',
  AppendImage: 'spend-operations.graphql',
  DeleteReceipt: 'spend-operations.graphql',
  CopyExpenseEntry: 'spend-operations.graphql',
  MoveExpense: 'spend-operations.graphql',
  GetNewReportFormFields: 'spend-operations.graphql',
  GetNewExpenseEntry: 'spend-operations.graphql',
  GetLineItemImage: 'spend-operations.graphql',
  GetLineItemImages: 'spend-operations.graphql',
  GetAvailableReceipts: 'spend-operations.graphql',
  GetTripDetails: 'spend-operations.graphql',
  GetReportFormFields: 'spend-forms.graphql',
  GetListItems: 'spend-forms.graphql',
  GetFormListItems: 'spend-forms.graphql',
};

// ── CDS travel (docs/api/travel-operations.graphql) ──────────────────────

const TRAVEL: ReadonlyArray<Omit<OperationEntry, 'endpoint' | 'text'>> = [
  { name: 'loadTripList', kind: 'query', purpose: 'List trips (upcoming/past, name, status, date range; nextToken paging).' },
  { name: 'loadOverviewTrip', kind: 'query', purpose: "One trip's overview: header, bookings (air, hotel, car, rail), custom fields." },
  { name: 'loadTripHistory', kind: 'query', purpose: "A trip's history events (created, approved, booking changes, emails)." },
  { name: 'booking', kind: 'query', purpose: 'One booking of a trip by tripId + bookingId.' },
  { name: 'sendItinerary', kind: 'mutation', purpose: "Email a trip's itinerary to recipients." },
  { name: 'tryCancelTripOrBooking', kind: 'mutation', purpose: 'Cancel a trip or some of its bookings.' },
  { name: 'cancelSummary', kind: 'query', purpose: 'What cancelling a trip or bookings would cancel (read-only summary).' },
  { name: 'loadTripActivities', kind: 'query', purpose: "A trip's activity feed." },
  { name: 'holdTrip', kind: 'mutation', purpose: 'Put a trip on hold.' },
  { name: 'confirmTrip', kind: 'mutation', purpose: 'Confirm (book) a held trip.' },
  { name: 'commitChange', kind: 'mutation', purpose: 'Commit a pending trip change.' },
  { name: 'saveBookingSelections', kind: 'mutation', purpose: 'Save seat / fare selections on an air booking.' },
  { name: 'startSearch', kind: 'mutation', purpose: 'Start a travel search for a trip plan.' },
  { name: 'processApproval', kind: 'mutation', purpose: 'Approve or reject a travel approval.' },
  { name: 'updateWorkItemStatus', kind: 'mutation', purpose: "Change a delegate dashboard work item's status." },
];

/** Operations a dedicated tool already runs (operation → tool). */
const WIRED: Readonly<Record<string, string>> = {
  GetReportsForUser: 'concur_list_reports',
  GetReportPageData: 'concur_get_report',
  GetExpenseTimelineSummary: 'concur_get_report_timeline',
  GetExistingExpenseEntry: 'concur_get_expense',
  GetAvailableExpenses: 'concur_list_available_expenses',
  GetExpenseTypesForReport: 'concur_list_expense_types',
  GetPaymentTypes: 'concur_list_payment_types',
  GetCurrencies: 'concur_list_currencies',
  GetLocations: 'concur_search_locations',
  GetAvailableReceipts: 'concur_list_available_receipts',
  GetLineItemImage: 'concur_get_receipt',
  CreateReportHeader: 'concur_create_report',
  UpdateReportHeader: 'concur_update_report',
  DeleteExpenseReport: 'concur_delete_report',
  CreateNewReportComment: 'concur_add_report_comment',
  SubmitExpenseReport: 'concur_submit_report',
  RecallReport: 'concur_recall_report',
  SaveNewExpenseEntry: 'concur_create_expense',
  UpdateExistingExpenseEntry: 'concur_update_expense',
  DeleteExpenseEntries: 'concur_delete_expenses',
  CopyExpenseEntry: 'concur_copy_expense',
  MoveAvailableExpensesToReport: 'concur_move_available_expenses_to_report',
  DeleteAvailableExpenses: 'concur_delete_available_expenses',
  AttachImage: 'concur_attach_receipt',
  AppendImage: 'concur_append_receipt',
  DetachImage: 'concur_detach_receipt',
  DeleteReceipt: 'concur_delete_receipt',
  loadTripList: 'concur_list_trips',
  loadOverviewTrip: 'concur_get_trip',
  loadTripHistory: 'concur_get_trip_history',
  sendItinerary: 'concur_send_itinerary',
};

/** Not wrapped by design (docs/CONCUR-API.md "Out of build scope"). */
const OUT_OF_SCOPE: Readonly<Record<string, string>> = {
  GetApproversList: 'Approvals',
  UpdateTimelineWorkflow: 'Approvals',
  GetCardAccounts: 'Card transactions',
  GetCardTransaction: 'Card transactions',
  MoveCCTransactionsToReport: 'Card transactions',
  CreateCBSReportAndMoveCCTransactionsToReport: 'Card transactions',
  RefreshYodleeTransactions: 'Card transactions',
};

/** `GetAirlineFeeTypes` → `Get airline fee types.` — the bundle names are descriptive. */
function fromName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ');
  const text = words.map((w, i) => (i === 0 || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
  return `${text}.`;
}

function refusal(name: string): string | undefined {
  return DENIED_MUTATIONS.find((d) => d.operationNames.some((n) => n.toLowerCase() === name.toLowerCase()))?.reason;
}

function entry(base: Omit<OperationEntry, 'tool' | 'refused'>): OperationEntry {
  const tool = WIRED[base.name];
  const refused = base.kind === 'mutation' ? refusal(base.name) : undefined;
  const scope = OUT_OF_SCOPE[base.name];
  let purpose = base.purpose;
  if (scope) purpose += ` ${scope} are out of scope for this MCP's dedicated tools.`;
  if (refused) purpose += ` Refused by concur_graphql_mutation: ${refused}`;
  else if (tool) purpose += ` Prefer ${tool}.`;
  return { ...base, purpose, ...(tool ? { tool } : {}), ...(refused ? { refused: true as const } : {}) };
}

/** The whole index: spend queries, spend mutations, then CDS travel. */
export function operationIndex(): OperationEntry[] {
  const spend = (kind: 'query' | 'mutation') => (name: string) =>
    entry({
      name,
      endpoint: 'spend',
      kind,
      purpose: fromName(name),
      ...(SPEND_DOCUMENTED[name] ? { text: `docs/api/${SPEND_DOCUMENTED[name]}` } : {}),
    });
  return [
    ...SPEND_QUERIES.map(spend('query')),
    ...SPEND_MUTATIONS.map(spend('mutation')),
    ...TRAVEL.map((t) => entry({ ...t, endpoint: 'cds', text: 'docs/api/travel-operations.graphql' })),
  ];
}
