// What `fields` may set on an expense form beyond the custom / org-unit fields,
// and in which wire shape. Everything here is read off the web app's own save
// path (the expense bundle's `outgoingTransforms`): the form library first
// normalizes each value (a pick list's `{id, value}` becomes its id, a
// checkbox a boolean, an EDIT/AMOUNT a number, an empty one ""), then the
// expense serializer renames a few ids and converts a few types before
// `SaveNewExpenseEntry` / `UpdateExistingExpenseEntry` sends them as `fields`.
// Only form ids in that serializer's allow-list are ever sent; anything else on
// the form (VAT totals, posted amount, …) is computed by Concur.

import { McpToolError } from '@chrischall/mcp-utils';
import { isEditable, isListField, labelOf, type FormField } from './forms.js';

/** How a standard field's text becomes its wire value. */
export type StandardKind = 'text' | 'date' | 'boolean' | 'integer' | 'taxLocation' | 'listItem';

export interface StandardSpec {
  /** The `CreateExpenseFieldsInput` / `UpdateExpenseFieldsInput` key. */
  wire: string;
  kind: StandardKind;
}

/**
 * Standard (non-custom) expense-form fields `fields` can set, keyed by form
 * field id. Renames (`fromLocation` → `startLocation`, …) are the serializer's.
 */
export const STANDARD_FIELDS: Readonly<Record<string, StandardSpec>> = {
  // Free text: sent as typed.
  ticketNumber: { wire: 'ticketNumber', kind: 'text' },
  fromLocation: { wire: 'startLocation', kind: 'text' },
  toLocation: { wire: 'endLocation', kind: 'text' },
  merchantTaxId: { wire: 'merchantTaxId', kind: 'text' },
  invoiceId: { wire: 'invoiceId', kind: 'text' },
  governmentInvoiceId: { wire: 'governmentInvoiceId', kind: 'text' },
  // Dates: "YYYY-MM-DD" (empty → null).
  budgetAccrualDate: { wire: 'budgetAccrualDate', kind: 'date' },
  hotelCheckinDate: { wire: 'hotelCheckinDate', kind: 'date' },
  hotelCheckoutDate: { wire: 'hotelCheckoutDate', kind: 'date' },
  // Number(…) (empty → null).
  carRentalDays: { wire: 'carRentalDays', kind: 'integer' },
  // Boolean(…).
  isExcludedFromCashAdvanceByUser: { wire: 'isExcludedFromCashAdvanceByUser', kind: 'boolean' },
  isExpenseBillable: { wire: 'isExpenseBillable', kind: 'boolean' },
  isPartOfTravelAllowance: { wire: 'isExpensePartOfTravelAllowance', kind: 'boolean' },
  // "FOREIGN" / "OUT_OF_PROVINCE", anything else "HOME".
  foreignOrDomestic: { wire: 'taxRateLocation', kind: 'taxLocation' },
  // Pick lists: the chosen item's id.
  aftCode: { wire: 'airlineFeeTypeCode', kind: 'listItem' },
  airlineSvcCode: { wire: 'airlineServiceClassCode', kind: 'listItem' },
  receiptType: { wire: 'receiptTypeId', kind: 'listItem' },
  fuelTypeListItemId: { wire: 'fuelTypeListItemId', kind: 'listItem' },
};

/** Standard fields that already have a named tool argument. */
const NAMED_ARGUMENT: Readonly<Record<string, string>> = {
  transactionDate: '`date`',
  transactionAmount: '`amount`',
  transactionCurrencyName: '`currency`',
  exchangeRate: '`exchangeRate`',
  vendor: '`vendor`',
  vendorName: '`vendor`',
  vendorAndVendorName: '`vendor`',
  location: '`locationId`',
  paymentType: '`paymentType`',
  paymentTypeId: '`paymentType`',
  businessPurpose: '`businessPurpose`',
  comment: '`comment`',
  isPersonalExpense: '`personal`',
};

/** Sent by the web app only for an approver or processor (never for your own expense). */
const APPROVER_ONLY = new Set(['adjustedAmount', 'isExpenseRejected', 'isPaperReceiptReceived']);

/**
 * In the web app's save allow-list, but its wire shape is not provable from
 * the bundle (a nested compliance object, a lookup-backed picker, mileage,
 * tax-authority amounts, …) — refused rather than guessed.
 */
const UNPROVEN = new Set([
  'companyTaxId',
  'goodsOrServicesCode',
  'placeOfSupply',
  'ctryCode',
  'countrySubDivisionCode',
  'travelRequestExpenseId',
  'taxTransactionAmount1',
  'taxTransactionAmount2',
  'totalNetAmount',
  'attendees',
  'attendeeCount',
  'allocations',
  'businessDistance',
  'personalDistance',
  'totalDistance',
  'odometerStart',
  'odometerEnd',
  'passengerCount',
  'routeId',
  'carKey',
  'vehicleId',
]);

/** The values `foreignOrDomestic` can take (the serializer sends anything else as HOME). */
const TAX_LOCATIONS = ['HOME', 'FOREIGN', 'OUT_OF_PROVINCE'] as const;

/** Custom and org-unit fields: the form-driven ones a caller sets by label. */
export const isCustomKey = (id: string) => /^(custom|orgUnit)\d+$/.test(id);

/** A standard field `fields` can set (a pick list only when the form carries its items). */
export function standardSpec(f: FormField): StandardSpec | undefined {
  const spec = STANDARD_FIELDS[f.id];
  if (!spec) return undefined;
  if (spec.kind === 'listItem' && !isListField(f)) return undefined;
  return spec;
}

/** A field `fields` can set: an editable custom / org-unit field or a supported standard one. */
export function isSettable(f: FormField): boolean {
  return isEditable(f) && (isCustomKey(f.id) || standardSpec(f) !== undefined);
}

/** Why `fields` cannot set this field — one sentence for the refusal's hint. */
export function whyNotSettable(f: FormField): string {
  const label = labelOf(f);
  if (!isEditable(f)) return `"${label}" is read-only on this form (Concur computes or locks it).`;
  const named = NAMED_ARGUMENT[f.id];
  if (named) return `Use the ${named} argument for "${label}".`;
  if (f.id === 'expenseType') return 'To change the expense type, delete the expense and create a new one.';
  if (APPROVER_ONLY.has(f.id)) return `Only an approver or expense processor sets "${label}".`;
  if (STANDARD_FIELDS[f.id]) return `"${label}" picks from a lookup this form does not carry, so this tool cannot resolve it.`;
  if (UNPROVEN.has(f.id)) return `This tool cannot set "${label}" yet: its wire shape is not proven from the web app.`;
  return `Concur computes "${label}"; the web app never sends it when saving.`;
}

/**
 * The longest text the web app lets a person type into this field, if any:
 * the form's `maximumLength`; for a custom / org-unit field at most 48 (the
 * bundle's text input caps custom fields there).
 */
export function maxLengthOf(f: FormField | undefined): number | undefined {
  const max = f?.maximumLength;
  if (max === null || max === undefined) return undefined;
  if (f && isCustomKey(f.id)) return max <= 0 || max > 48 ? 48 : max;
  return max > 0 ? max : undefined;
}

/** Refuse text longer than the field allows, before Concur answers a bare HTTP 400. */
export function checkLength(f: FormField | undefined, text: string, label = f ? labelOf(f) : ''): void {
  const max = maxLengthOf(f);
  if (max !== undefined && text.length > max) {
    throw new McpToolError(`"${label}" is ${text.length} characters; this expense form allows at most ${max}.`, {
      hint: `Shorten it to ${max} characters or fewer (Concur rejects a longer value with a bare HTTP 400).`,
    });
  }
}

const BOOLEAN_TEXT: Readonly<Record<string, boolean>> = { true: true, yes: true, y: true, '1': true, false: false, no: false, n: false, '0': false };

function refuse(f: FormField, text: string, expected: string): never {
  throw new McpToolError(`"${text}" is not a valid value for "${labelOf(f)}".`, { hint: `Pass ${expected}.` });
}

/** A standard field's caller text as its wire value (list items are resolved by the caller). */
export function standardWire(f: FormField, kind: Exclude<StandardKind, 'listItem'>, text: string): string | number | boolean {
  const trimmed = text.trim();
  switch (kind) {
    case 'text':
      checkLength(f, text);
      return text;
    case 'date': {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`));
      if (!ok) refuse(f, text, 'a date as YYYY-MM-DD');
      return trimmed;
    }
    case 'integer':
      if (!/^\d+$/.test(trimmed)) refuse(f, text, 'a whole number, e.g. "3"');
      return Number(trimmed);
    case 'boolean': {
      const b = BOOLEAN_TEXT[trimmed.toLowerCase()];
      if (b === undefined) refuse(f, text, '"true" or "false"');
      return b;
    }
    case 'taxLocation': {
      const want = trimmed.toLowerCase();
      const option = (f.options ?? []).find((o) => [o.id, o.code, o.value].some((s) => s && s.trim().toLowerCase() === want));
      const key = (option?.id ?? option?.code ?? trimmed).trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (!(TAX_LOCATIONS as readonly string[]).includes(key)) refuse(f, text, `one of ${TAX_LOCATIONS.join(', ')}`);
      return key;
    }
  }
}
