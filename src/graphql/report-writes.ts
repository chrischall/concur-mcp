// Report-header writes and the forms they are built from. Mutation texts are
// the web app's own (docs/api/spend-operations.graphql); the form reads are
// `GetNewReportFormFields` / `GetReportFormFields` (docs/api/spend-forms.graphql)
// trimmed to `FORM_FIELD`.

import { FORM_FIELD } from './forms.js';

/** `GetNewReportFormFields` — the new-report header form, with each field's default. */
export const NEW_REPORT_FORM = `query GetNewReportFormFields($userId: String!, $contextRole: ContextRoleType!, $policyId: String) {
  newReportForm(contextRole: $contextRole, policyId: $policyId, userId: $userId) {
    fields {
      ${FORM_FIELD}
    }
    policyId
  }
}`;

/** `GetReportFormFields` — an existing report's header form, with each field's current value. */
export const REPORT_FORM = `query GetReportFormFields($userId: String!, $contextRole: ContextRoleType!, $reportId: String!) {
  existingReportForm(contextRole: $contextRole, reportId: $reportId, userId: $userId) {
    fields {
      ${FORM_FIELD}
    }
    policyId
  }
}`;

/** `CreateReportHeader`, verbatim. */
export const CREATE_REPORT = `mutation CreateReportHeader(
  $userId: String!
  $contextRole: ContextRoleType!
  $fields: CreateReportFieldsInput!
) {
  createReport(contextRole: $contextRole, fields: $fields, userId: $userId) {
    reportId
  }
}`;

/** `UpdateReportHeader`, verbatim. */
export const UPDATE_REPORT = `mutation UpdateReportHeader(
  $userId: String!
  $contextRole: ContextRoleType!
  $reportId: String!
  $fields: UpdateReportFieldsInput!
) {
  updateReport(userId: $userId, contextRole: $contextRole, reportId: $reportId, fields: $fields) {
    reportId
  }
}`;

/** `DeleteExpenseEntries`, verbatim. */
export const DELETE_EXPENSE_ENTRIES = `mutation DeleteExpenseEntries(
  $userId: String!
  $contextRole: ContextRoleType!
  $reportId: String!
  $expenseIds: [String!]
) {
  employee(userId: $userId, contextRole: $contextRole) {
    expenseReport(reportId: $reportId) {
      deleteExpenseEntries(expenseIds: $expenseIds) {
        status { success }
      }
    }
  }
}`;

/** `DeleteExpenseReport`, verbatim. */
export const DELETE_REPORT = `mutation DeleteExpenseReport($userId: String!, $contextRole: ContextRoleType!, $reportId: String!) {
  employee(userId: $userId, contextRole: $contextRole) {
    expenseReport(reportId: $reportId) {
      deleteReport {
        status { success }
      }
    }
  }
}`;

/**
 * `CreateNewReportComment`, trimmed to the status and the comment fields of
 * the report timeline it answers with (the tool verifies the comment there,
 * else re-reads the timeline).
 */
export const CREATE_REPORT_COMMENT = `mutation CreateNewReportComment(
  $userId: String!
  $reportId: String!
  $contextRole: ContextRoleType!
  $comment: String!
) {
  createNewReportComment(userId: $userId, contextRole: $contextRole, reportId: $reportId, comment: $comment) {
    status { success }
    timelineSummary { summaryItems { id comment commentType authorName creationDate } }
  }
}`;

/**
 * `SubmitExpenseReport`, verbatim — CDS-namespaced on the spend endpoint. The
 * web app sends `validate: true` first; a report with warnings answers with a
 * non-completed status (or an `errors[]` whose `extensions.exception` carries
 * `key` + `data.errorMessage`) instead of submitting.
 */
export const SUBMIT_REPORT = `mutation SubmitExpenseReport(
  $contextRole: CDS_SmartExpenseContextTypes!
  $reportId: ID!
  $userId: ID
  $reportSource: CDS_ReportSource
  $validate: Boolean
  $approverValidated: Boolean
) {
  CDS_expense {
    report {
      submit(
        contextType: $contextRole
        id: $reportId
        userId: $userId
        validate: $validate
        reportSource: $reportSource
        approverValidated: $approverValidated
      ) {
        status
      }
    }
  }
}`;

/** `RecallReport`, trimmed to the id (the tool re-reads the report). */
export const RECALL_REPORT = `mutation RecallReport($contextRole: ContextRoleType!, $reportId: String!, $userId: String!) {
  recallReport(reportId: $reportId, contextRole: $contextRole, userId: $userId) {
    id
    approvalStatus
  }
}`;
