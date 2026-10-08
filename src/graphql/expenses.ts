// Expense reads, trimmed from docs/api/spend-reads.graphql to the fields the tools return.

import { FORM_VALUE } from './forms.js';
import { ENTRY_SUMMARY_FIELDS } from './reports.js';

const MONEY = '{ value currencyCode }';

const EXCEPTION_FIELDS = `exceptionCode
  expenseId
  isBlocking
  message
  parameters { missingFields { fields fieldIds } }`;

/** `GetExistingExpenseEntry` (+ the entry's comments from `GetExpenseEntryComments`), trimmed. */
export const GET_EXPENSE = `query GetExistingExpenseEntry(
  $expenseId: String!
  $reportId: String!
  $userId: String!
  $contextRole: ContextRoleType!
  $expenseIdAsID: ID!
  $reportIdAsID: ID!
  $userIdAsID: ID!
  $showAttendeeField: Boolean! = false
) {
  entryExceptions(expenseId: $expenseId, reportId: $reportId, userId: $userId, contextRole: $contextRole) {
    expenseId
    countOfExceptions
    hasBlockingExceptions
    entryExceptions {
      ${EXCEPTION_FIELDS}
    }
    itemizationsExceptions {
      itemizationId
      exceptions {
        ${EXCEPTION_FIELDS}
      }
    }
  }
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
        travel { hotelCheckinDate hotelCheckoutDate }
        itemizations {
          id
          isPersonalExpense
          expenseType { id code name }
          transactionAmount ${MONEY}
          approvedAmount ${MONEY}
          transactionDate
        }
        entryComments {
          author { firstName lastName preferredName }
          comment
          creationDate
          isLatest
        }
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
        id
        label
        formFieldId
        dataType
        control
        accessMode
        isRequired
        ${FORM_VALUE}
      }
    }
  }
}`;

/** `GetAvailableExpenses`, trimmed (no `params` — its input shape is not in the bundle texts). */
export const LIST_AVAILABLE_EXPENSES = `query GetAvailableExpenses($userId: String!, $contextRole: ContextRoleType!, $page: Int, $size: Int) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    availableExpensesWithPagination(pagination: { size: $size, page: $page }) {
      availableExpenses {
        id
        transactionDate
        vendor
        confirmationCode
        exchangeRate
        expenseType { id code name }
        paymentType { id code name }
        location { id name city countrySubDivisionCode countryCode }
        transactionAmount ${MONEY}
        postedAmount ${MONEY}
        estimatedAmount ${MONEY}
        creditCard { cardLastSegment creditCardAccountId creditCardTransactionId }
        eReceipt { eReceiptId receiptImageId }
        receiptImageId
        meta {
          hasSourceCreditCard
          hasSourcePersonalCard
          hasSourceEReceipt
          hasSourceExpenseIt
          hasSourceItinerary
          hasSourceMobile
          missingData
        }
      }
      pagination { number size totalElements totalPages }
    }
  }
}`;
