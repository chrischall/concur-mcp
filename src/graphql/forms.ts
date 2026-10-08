// Form-field selections shared by the form-driven reads and writes. Aliases are
// the bundle's own (`FormFieldFragment` and its value-union fragments).

/** A form field's typed value (the bundle's value-union fragments, verbatim aliases). */
export const FORM_VALUE = `value {
  ... on AmountValue { amountValue: value { value currencyCode } }
  ... on BooleanValue { booleanValue: value }
  ... on DateValue { dateValue: value }
  ... on ExchangeRateValue { value operation }
  ... on ExpenseAmount { expenseAmountValue: value }
  ... on FloatValue { floatValue: value }
  ... on IntegerValue { integerValue: value }
  ... on ListItemValue { code id listItemValue: value }
  ... on ListValue { listValue: value { code id value } }
  ... on LocationListValue { locationValue: value { id name city value countryCode countrySubDivisionCode } }
  ... on StringValue { stringValue: value }
}`;

/** `FormFieldFragment`, trimmed to what a form-driven write needs. */
export const FORM_FIELD = `id
  label
  formFieldId
  dataType
  control
  accessMode
  isRequired
  maximumLength
  ${FORM_VALUE}
  defaultValue { value code listItemId isValid }
  options { id code value }
  list { id level parentId displayFormat defaultSearchBy: searchCriteria }`;

/** `GetListItems` — search one list (a list-valued form field's `list.id`). */
export const LIST_ITEMS = `query GetListItems($listInformation: CDS_InputListInformation!) {
  CDS_spend {
    list(listInformation: $listInformation) {
      page { totalPages }
      isExternal
      items { code id matchValue serviceVersion shortCode value }
    }
  }
}`;
