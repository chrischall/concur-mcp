// Expense-entry writes and the forms they are built from. Mutation texts are
// the web app's own (docs/api/spend-operations.graphql), trimmed: the
// `@include(if: $isTrexEnabled)` response blocks are dropped (the tools re-read
// with GetExistingExpenseEntry instead), and with them the `$isTrexEnabled` /
// `$shouldIncludeRpeKey` variables they alone used.

import { FORM_FIELD } from './forms.js';
import { ENTRY_SUMMARY_FIELDS } from './reports.js';

/**
 * `GetNewExpenseEntry`, trimmed: the report's policy, currency and expense
 * types, plus (when `$shouldFetchExpenseForm`) the new-expense form for one
 * expense type with each field's default.
 */
export const NEW_EXPENSE_FORM = `query GetNewExpenseEntry(
  $reportId: String!
  $userId: String!
  $reportIdAsID: ID!
  $userIdAsID: ID!
  $expenseTypeId: ID!
  $contextRole: ContextRoleType!
  $shouldFetchExpenseForm: Boolean! = true
  $showAttendeeField: Boolean! = false
) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        name
        currencyCode
        policy { id expenseListDetailFormId }
        expenseTypes { id code name parentName }
        meta { isSubmitted canAddExpense }
      }
    }
  }
  newExpenseForm(
    dataContext: { reportId: $reportIdAsID, expenseTypeId: $expenseTypeId }
    userContext: { userId: $userIdAsID, contextType: $contextRole }
  ) @include(if: $shouldFetchExpenseForm) {
    mainForm(showAttendeeField: $showAttendeeField) {
      fields {
        ${FORM_FIELD}
      }
    }
  }
}`;

/**
 * `GetExistingExpenseEntry`, trimmed to what an update needs: the entry's
 * current summary, the report's policy, and the existing form (with list ids).
 */
export const EXPENSE_FORM = `query GetExistingExpenseEntry(
  $expenseId: String!
  $reportId: String!
  $userId: String!
  $contextRole: ContextRoleType!
  $expenseIdAsID: ID!
  $reportIdAsID: ID!
  $userIdAsID: ID!
  $showAttendeeField: Boolean! = false
) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        name
        currencyCode
        policy { id expenseListDetailFormId }
      }
      entry(expenseId: $expenseId) {
        ${ENTRY_SUMMARY_FIELDS}
      }
    }
  }
  existingExpenseForm(
    dataContext: { expenseId: $expenseIdAsID, reportId: $reportIdAsID }
    userContext: { userId: $userIdAsID, contextType: $contextRole }
  ) {
    expenseId
    expenseTypeId
    mainForm(showAttendeeField: $showAttendeeField) {
      isFormEditable
      fields {
        ${FORM_FIELD}
      }
    }
  }
}`;

/** `SaveNewExpenseEntry`, trimmed to the new id (+ the web app's recent-type bookkeeping). */
export const CREATE_EXPENSE = `mutation SaveNewExpenseEntry(
  $reportId: ID!
  $contextRole: ContextRoleType!
  $userId: ID!
  $fields: CreateExpenseFieldsInput!
  $taxFields: [TaxField!] = null
  $expenseTypeId: String!
  $policyId: String!
  $expenseListDetailFormId: String
) {
  createExpense(
    dataContext: {
      reportId: $reportId
      fields: $fields
      taxFields: $taxFields
      expenseListDetailFormId: $expenseListDetailFormId
    }
    userContext: { userId: $userId, contextType: $contextRole }
  ) {
    id
  }
  CDS_addRecentExpenseTypes(policyId: $policyId, expenseTypeId: $expenseTypeId)
}`;

/** `UpdateExistingExpenseEntry`, trimmed to the id. */
export const UPDATE_EXPENSE = `mutation UpdateExistingExpenseEntry(
  $reportId: ID!
  $expenseId: ID!
  $contextRole: ContextRoleType!
  $userId: ID!
  $fields: UpdateExpenseFieldsInput!
  $taxFields: [TaxField!] = null
  $expenseTypeId: String!
  $policyId: String!
  $updateRecentExpenseType: Boolean!
  $shouldCopyDownFields: Boolean!
  $expenseListDetailFormId: String
) {
  updateExpense(
    dataContext: {
      reportId: $reportId
      expenseId: $expenseId
      fields: $fields
      taxFields: $taxFields
      shouldCopyDownFields: $shouldCopyDownFields
      expenseListDetailFormId: $expenseListDetailFormId
    }
    userContext: { userId: $userId, contextType: $contextRole }
  ) {
    id
  }
  CDS_addRecentExpenseTypes(policyId: $policyId, expenseTypeId: $expenseTypeId) @include(if: $updateRecentExpenseType)
}`;

/** `MoveAvailableExpensesToReport`, trimmed to the status (the tool re-reads both sides). */
export const MOVE_AVAILABLE_EXPENSES = `mutation MoveAvailableExpensesToReport(
  $userId: String!
  $contextRole: ContextRoleType!
  $ids: [String!]!
  $reportId: String!
) {
  employee(userId: $userId, contextRole: $contextRole) {
    moveAvailableExpensesToReport(ids: $ids, reportId: $reportId) {
      status { success }
      errors
    }
  }
}`;

/** `DeleteAvailableExpenses`, trimmed to the status (the tool re-reads the list). */
export const DELETE_AVAILABLE_EXPENSES = `mutation DeleteAvailableExpenses($userId: String!, $contextRole: ContextRoleType!, $ids: [String!]!) {
  employee(userId: $userId, contextRole: $contextRole) {
    deleteAvailableExpenses(ids: $ids) {
      status { success }
    }
  }
}`;

/** `CopyExpenseEntry`, trimmed to the status and the copy's id. */
export const COPY_EXPENSE = `mutation CopyExpenseEntry(
  $userId: String!
  $contextRole: ContextRoleType!
  $reportId: String!
  $expenseId: String!
  $expenseListDetailFormId: String
) {
  employee(userId: $userId, contextRole: $contextRole) {
    expenseReport(reportId: $reportId) {
      copyExpenseEntry(expenseId: $expenseId, expenseListDetailFormId: $expenseListDetailFormId) {
        status { success }
        expenseId
      }
    }
  }
}`;
