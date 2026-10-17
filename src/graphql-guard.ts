// The raw-GraphQL deny-list: mutations concur_graphql_mutation refuses.
//
// What a caller-supplied document actually does (its operations, fragments and
// every field name and alias it selects) is read by mcp-utils'
// inspectGraphqlDocument, lifted from this file (fleet-audit#1231): a small
// tokenizer, so string, block-string and comment contents can never look like a
// field, and anything it cannot read is thrown, never guessed.
// isReadOnlyGraphqlDocument decides "query or not"; this module decides
// "which mutation".

import { inspectGraphqlDocument } from '@chrischall/mcp-utils/graphql';

// ── deny-list ─────────────────────────────────────────────────────────────

export interface DeniedMutation {
  /** The web app's operation name. */
  id: string;
  /** Operation names refused outright (case-insensitive). */
  operationNames: readonly string[];
  /** Field names refused wherever they are selected (case-insensitive). */
  fields: readonly string[];
  /** The refusal, shown to the caller. */
  reason: string;
}

const outOfScope = (what: string) =>
  `${what} is out of scope for this MCP and is refused by the raw-GraphQL escape hatch; do it in the Concur web app.`;

/**
 * Mutations concur_graphql_mutation refuses, matched by operation name AND by
 * the field the web app's text selects (docs/api/*.graphql), so renaming the
 * operation or aliasing the field does not get one through.
 */
export const DENIED_MUTATIONS: readonly DeniedMutation[] = [
  {
    id: 'submit',
    operationNames: ['SubmitExpenseReport'],
    fields: ['submit'],
    reason:
      'Submitting an expense report (CDS_expense.report.submit) sends it to your approver — use concur_submit_report, ' +
      'which validates the report and shows what will be submitted first.',
  },
  {
    id: 'tryCancelTripOrBooking',
    operationNames: ['tryCancelTripOrBooking'],
    fields: ['tryCancel'],
    reason: outOfScope('Cancelling a trip or booking (travel.trip.tryCancel)'),
  },
  {
    id: 'holdTrip',
    operationNames: ['holdTrip'],
    fields: ['hold'],
    reason: outOfScope('Putting a trip on hold (travel.trip.hold)'),
  },
  {
    id: 'confirmTrip',
    operationNames: ['confirmTrip'],
    fields: ['confirmV2', 'confirm'],
    reason: outOfScope('Confirming (booking) a trip (travel.trip.confirmV2)'),
  },
  {
    id: 'commitChange',
    operationNames: ['commitChange'],
    fields: ['commitChange'],
    reason: outOfScope('Committing a trip change (travel.trip.commitChange)'),
  },
  {
    id: 'saveBookingSelections',
    operationNames: ['saveBookingSelections'],
    fields: ['saveBookingSelections'],
    reason: outOfScope('Saving booking selections (travel.air.saveBookingSelections)'),
  },
  {
    id: 'startSearch',
    operationNames: ['startSearch'],
    fields: ['startSearch'],
    reason: outOfScope('Starting a travel search (travel.trip.tripPlan.startSearch)'),
  },
  {
    id: 'processApproval',
    operationNames: ['processApproval'],
    fields: ['processApproval'],
    reason: outOfScope('Approving or rejecting (travel.approval.processApproval)'),
  },
  {
    id: 'updateWorkItemStatus',
    operationNames: ['updateWorkItemStatus'],
    fields: ['updateDelegatesDashboardWorkItemStatus'],
    reason: outOfScope("Changing a delegate dashboard work item's status (travel.trip.updateDelegatesDashboardWorkItemStatus)"),
  },
];

/** The first deny-list entry the document hits, or undefined. Throws on an unreadable document. */
export function findDeniedMutation(doc: string): DeniedMutation | undefined {
  const info = inspectGraphqlDocument(doc);
  const names = new Set(info.operations.map((o) => o.name?.toLowerCase()).filter((n): n is string => !!n));
  const fields = new Set([...info.fields].map((f) => f.toLowerCase()));
  return DENIED_MUTATIONS.find(
    (d) => d.operationNames.some((n) => names.has(n.toLowerCase())) || d.fields.some((f) => fields.has(f.toLowerCase())),
  );
}
