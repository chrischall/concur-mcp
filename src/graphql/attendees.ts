// Attendee documents, trimmed from docs/api/spend-reads.graphql
// (GetAttendeesByPredictiveSearch, GetReportPageData) and
// docs/api/spend-operations.graphql (SaveExpenseAttendees).

/**
 * `GetAttendeesByPredictiveSearch`, trimmed: the `details` sub-selection (and
 * the `$includeAttendeeDetails` / `$userId` / `$allowedAtnTypeKeys` variables
 * only it used) dropped, the two fragments inlined.
 */
export const SEARCH_ATTENDEES = `query GetAttendeesByPredictiveSearch(
  $searchTerms: String!
  $includeInactiveEmp: Boolean!
  $includeAtnTypeKeys: [Int!]!
  $excludeKeys: [String!]!
) {
  attendeesByPredictiveSearch(
    searchTerms: $searchTerms
    includeInactiveEmp: $includeInactiveEmp
    includeAtnTypeKeys: $includeAtnTypeKeys
    excludeKeys: $excludeKeys
  ) {
    attendees {
      ... on CompactAttendee {
        atnKey
        atnTypeKey
        atnTypeId
        atnTypeName
        atnTypeCode
        id
        lastName
        company
        firstName
        mi
        preferredName
        emailAddress
        title
        suffix
        isFavorite
        versionNumber
        __typename
      }
      ... on AttendeeGroup {
        id
        name
        category
        __typename
      }
    }
  }
}`;

/** `GetReportPageData`, trimmed to the report owner's name (who "me" is as an attendee). */
export const GET_REPORT_OWNER = `query GetReportOwner($userId: String!, $reportId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    expenseReport(reportId: $reportId) {
      reportId
      reportDetails {
        id
        employee { firstName lastName preferredName }
      }
    }
  }
}`;

/** `SaveExpenseAttendees`, verbatim. `params.attendees` is the COMPLETE list — it replaces. */
export const SAVE_EXPENSE_ATTENDEES = `mutation SaveExpenseAttendees(
  $userId: String!
  $contextRole: ContextRoleType!
  $params: SaveAttendeesLegacyParams!
) {
  employee(userId: $userId, contextRole: $contextRole) {
    saveAttendeesLegacy(params: $params) {
      status
    }
  }
}`;
