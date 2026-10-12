// Missing Receipt Declaration (Concur's internal name: affidavit). Trimmed from
// docs/api: the policy switch and its two texts come from `GetReportPageData`'s
// `ReportPolicyFragment` (spend-reads.graphql), the per-expense flags from its
// `ExpenseEntrySummaryFragment`, and the write is `CreateAffidavits`
// (spend-operations.graphql) verbatim. Nothing here is invented.

const MONEY = '{ value currencyCode }';

/**
 * `GetReportPageData`, trimmed to what the declaration needs: whether the
 * report's policy allows declarations, the explanation + acceptance text the
 * web app shows in its modal, and each entry's receipt / declaration flags.
 */
export const GET_AFFIDAVIT_CONTEXT = `query GetReportAffidavitData($userId: String!, $reportId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        name
        reportNumber
        policy {
          id
          allowReceiptAffidavits
          receiptAffidavitExplanation
          receiptAffidavitAcceptance
        }
      }
    }
  }
  reportEntriesDetails(userId: $userId, reportId: $reportId, contextRole: $contextRole) {
    reportId
    entries {
      expenseId
      summary {
        id
        transactionDate
        isImageRequired
        isPaperReceiptRequired
        receiptImageId
        expenseType { id name }
        vendor { id description name }
        transactionAmount ${MONEY}
        meta { hasAffidavit hasReceiptImage }
      }
    }
  }
}`;

/** `CreateAffidavits` — declare the receipt missing for expenses on a report. */
export const CREATE_AFFIDAVITS = `mutation CreateAffidavits(
  $userId: String!
  $contextRole: ContextRoleType!
  $reportId: String!
  $expenseIds: [String!]!
) {
  createAffidavits(userId: $userId, contextRole: $contextRole, reportId: $reportId, expenseIds: $expenseIds) {
    status { success }
  }
}`;
