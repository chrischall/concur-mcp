// Report reads, trimmed from the web app's own operations (docs/api/spend-reads.graphql)
// to the fields the tools return. Field names are the bundle's; nothing here is invented.
// The legacy numeric keys (`rptKey`, `rpeKey`) are NOT selected: no tool uses them,
// and they are served by Concur's legacy services, whose failure (a stale session
// cookie) answered errors[] that sank the whole read.

/** `GetReportsForUser`, trimmed. */
export const LIST_REPORTS = `query GetReportsForUser(
  $contextRole: ContextRoleType!
  $dateRange: InputDateRange
  $filterByStatus: InputFilterBy
  $paging: InputPagination
  $userId: String!
) {
  employee(contextRole: $contextRole, userId: $userId) {
    userId
    reportsForUser(input: { dateRange: $dateRange, filterByStatus: $filterByStatus, paging: $paging }) {
      list {
        reportId: id
        name
        reportNumber
        reportDate
        startDate
        endDate
        submitDate
        paidDate
        sentBackDate
        approvalStatus
        approvalStatusId
        paymentStatus
        exceptionLevel
        reportType
        wasSentForPayment: isSentForPayment
        reportTotal { currencyCode value }
        claimedAmount { currencyCode value }
        approvedAmount { currencyCode value }
        totalAmountDueEmployee { currencyCode value }
        approver { firstName: first lastName: last preferredName }
        meta {
          canAddExpense
          isApproved
          isPendingApproval
          isSentForPayment
          isPaymentConfirmed
          isSentBack
          isSubmitted
          isReopened
        }
      }
      pagination { number size totalElements totalPages }
    }
  }
}`;

const MONEY = '{ value currencyCode }';

const EXCEPTION_FIELDS = `exceptionCode
  expenseId
  parentExpenseId
  isBlocking
  message
  parameters { missingFields { fields fieldIds } }`;

/** The entry summary shared by the report and expense reads (`ExpenseEntrySummaryFragment`, trimmed). */
export const ENTRY_SUMMARY_FIELDS = `id
  transactionDate
  isPersonalExpense
  isImageRequired
  isPaperReceiptRequired
  receiptImageId
  eReceiptImageId
  parentExpenseId
  allocationState
  attendeeCount
  expenseType { id code name }
  paymentType { id code name }
  vendor { id description name }
  location { id name city countryCode countrySubDivisionCode }
  transactionAmount ${MONEY}
  postedAmount ${MONEY}
  approvedAmount ${MONEY}
  claimedAmount ${MONEY}
  meta {
    canDelete
    hasAllocation
    hasAttendees
    hasBlockingExceptions
    hasComments
    hasExceptions
    hasItemizations
    hasReceiptImage
    hasSourceCreditCard
    hasSourceEReceipt
  }`;

/** `GetReportPageData` (summary + policy + entries + exceptions), trimmed. */
export const GET_REPORT = `query GetReportPageData($userId: String!, $reportId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        name
        reportNumber
        reportType
        policyId
        currencyCode
        countryCode
        startDate
        endDate
        submitDate
        approvalStatus
        paymentStatus
        reportOwnerUserId
        employee { firstName lastName preferredName }
        claimedAmount ${MONEY}
        approvedAmount ${MONEY}
        reportTotal ${MONEY}
        meta {
          isApproved
          isSubmitted
          isReopened
          isSentForPayment
          isPaymentConfirmed
          isNotPaid
          isSentBack
          hasExpenses
          isPaperReceiptRequired
          isReceiptImageAvailable
          canRecall
          canAddExpense
          canReopen
        }
        policy { id expenseListDetailFormId }
      }
    }
  }
  reportEntriesDetails(userId: $userId, reportId: $reportId, contextRole: $contextRole) {
    reportId
    entries {
      expenseId
      summary {
        ${ENTRY_SUMMARY_FIELDS}
      }
    }
  }
  reportExceptions(reportId: $reportId, userId: $userId, contextRole: $contextRole) {
    reportId
    countOfExceptions
    hasBlockingExceptions
    reportExceptions {
      ${EXCEPTION_FIELDS}
    }
    entryExceptions {
      expenseId
      countOfExceptions
      hasBlockingExceptions
      entryExceptions {
        ${EXCEPTION_FIELDS}
      }
    }
  }
}`;

/**
 * The report name + `GetExpenseTimelineSummary` + `GetAuditTrails`, in one read.
 * Report comments live in the top-level `timelineSummary` (verified live
 * 2026-10-08), NOT in `reportDetails.comments`, which stayed `[]` after a
 * successful `createNewReportComment`.
 */
export const GET_REPORT_TIMELINE = `query GetReportTimeline($userId: String!, $reportId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        name
      }
    }
  }
  timelineSummary(userId: $userId, reportId: $reportId, contextRole: $contextRole) {
    summaryDate
    summaryItems {
      id
      action
      authorName
      createdForEmployeeName
      comment
      commentSource
      commentType
      creationDate
      expenseType
      isDelegateSubmission
      transactionDate
      transactionAmount ${MONEY}
      viewLink
    }
  }
  auditTrails(reportId: $reportId, contextRole: $contextRole, userId: $userId) {
    report { action date description authorName author { fullName } externalUpdate auditUpdatedBy }
    expense { action date description authorName author { fullName } externalUpdate auditUpdatedBy }
  }
}`;

/** The two report-header ids `GetExpenseTypesForReport` needs. */
export const GET_REPORT_POLICY = `query GetReportPolicy($userId: String!, $reportId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails { id policyId reportOwnerUserId }
    }
  }
}`;
