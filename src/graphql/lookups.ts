// Reference-data reads, trimmed from docs/api/spend-reads.graphql.

/** `employee` + `GetUserPermissions` (without the CDS feature-flag lookup), trimmed. */
export const WHOAMI = `query ConcurWhoami($userId: String!, $contextRole: ContextRoleType!) {
  employee(userId: $userId, contextRole: $contextRole) {
    userId
    contextRole
  }
  userPermissions {
    userId
    isRequestTraveler
    isCashAdvanceUser
    isExpenseItEnabled
  }
}`;

/** `GetExpenseTypesForReport`, trimmed to the type list. */
export const LIST_EXPENSE_TYPES = `query GetExpenseTypesForReport(
  $userId: ID!
  $contextRole: ContextRoleType!
  $policyId: ID!
  $reportId: ID!
  $reportOwnerUserId: ID!
) {
  expenseTypesForReport(
    userId: $userId
    contextRole: $contextRole
    policyId: $policyId
    reportId: $reportId
    reportOwnerUserId: $reportOwnerUserId
  ) {
    id
    code
    name
    parentName
    description
    text
    header
    visibilityCode
  }
}`;

/** `GetPaymentTypes`, verbatim. */
export const LIST_PAYMENT_TYPES = `query GetPaymentTypes($reportOwnerUserId: String) {
  paymentTypes(reportOwnerUserId: $reportOwnerUserId) {
    paymentTypeId
    paymentTypeName
    isPrePopulatedOnly
  }
}`;

/** `GetCurrencies`, verbatim. */
export const LIST_CURRENCIES = `query GetCurrencies {
  currencies {
    code
    name
  }
}`;

/** `GetLocations`, verbatim (comments dropped). */
export const SEARCH_LOCATIONS = `query GetLocations($cityName: String!, $countryCode: String = null, $subdivisionCode: String = null) {
  locations: CDS_locations(cityName: $cityName, countryCode: $countryCode, subdivisionCode: $subdivisionCode) {
    id
    locationId
    legacyKey
    name
    preferredDisplay
    country { code name currencyCode currencyName }
    subdivision { code name }
  }
}`;
