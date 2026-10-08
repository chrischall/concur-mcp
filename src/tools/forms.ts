// Form-driven writes: Concur's header and expense forms are tenant-specific, so
// a write reads the form, starts from each field's current/default value, and
// overlays what the caller asked for — by the field's LABEL (what a person sees)
// or its id. A list-valued field takes the item's text and is resolved to the
// list item id the API wants, through the form's own list (`GetListItems`).
//
// Labels are NOT unique. A real new-report form carries both
// `{id: businessPurpose, label: "Business Purpose", dataType: STRING}` and
// `{id: custom5, label: "Business Purpose", dataType: LIST, isRequired: true}` —
// the dropdown the web app shows. `chooseField` picks between such twins.

import { McpToolError } from '@chrischall/mcp-utils';
import type { ConcurClient } from '../client.js';
import { LIST_ITEMS } from '../graphql/forms.js';
import { formValue } from './expenses.js';

type Rec = Record<string, unknown>;

export interface FormField {
  id: string;
  label?: string | null;
  formFieldId?: string | null;
  dataType?: string | null;
  control?: string | null;
  accessMode?: string | null;
  isRequired?: boolean | null;
  value?: Rec | null;
  defaultValue?: { value?: string | null; code?: string | null; listItemId?: string | null } | null;
  options?: Array<{ id?: string | null; code?: string | null; value?: string | null }> | null;
  list?: { id?: string | null; level?: number | null; defaultSearchBy?: string | null } | null;
}

/** A field's value as the API takes it (`sent`) and as a person reads it (`display`). */
export interface Picked {
  sent: string;
  display: string;
  /** A list item's code (e.g. a country's "US"), when it has one. */
  code?: string;
}

interface ListItem {
  id?: string | null;
  code?: string | null;
  shortCode?: string | null;
  value?: string | null;
}

interface ListItemsData {
  CDS_spend: { list: { items: ListItem[] | null } | null } | null;
}

/** The field's label, or its id when the form gives none. */
export const labelOf = (f: FormField): string => f.label || f.id;

/** A list-valued field: a pick list (`options`) or a searchable list (`list.id`). */
export function isListField(f: FormField): boolean {
  return Boolean(f.list?.id) || (f.options?.length ?? 0) > 0;
}

/** The value a field holds now: its `value`, else the form's `defaultValue`. */
export function pickedOf(f: FormField): Picked | undefined {
  const v = formValue(f.value);
  if (typeof v === 'object' && v !== null) {
    const item = v as { id?: string | null; value?: string | null; code?: string | null };
    if (item.id) return { sent: item.id, display: item.value || item.code || item.id, ...(item.code ? { code: item.code } : {}) };
  } else if (v !== undefined) {
    return { sent: String(v), display: String(v) };
  }
  const d = f.defaultValue;
  if (d?.listItemId) {
    return { sent: d.listItemId, display: d.value || d.code || d.listItemId, ...(d.code ? { code: d.code } : {}) };
  }
  if (typeof d?.value === 'string' && !isListField(f)) return { sent: d.value, display: d.value };
  return undefined;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Every field a caller's name could mean: the label matches (case-insensitive), else the id. */
export function fieldsNamed(fields: readonly FormField[], name: string): FormField[] {
  const want = norm(name);
  const byLabel = fields.filter((f) => norm(f.label) === want);
  return byLabel.length > 0 ? byLabel : fields.filter((f) => norm(f.id) === want);
}

/**
 * `accessMode` values that mean a person cannot edit the field. The enum is NOT
 * knowable from docs/api (the bundle only selects `accessMode`; no values are
 * spelled out), so this lists only the explicit read-only / hidden spellings —
 * `READ_WRITE` is the one value seen editable, `RO` / `HD` are Concur's form
 * access codes — and treats ANY other value (or none) as editable.
 */
const READ_ONLY_ACCESS = new Set(['RO', 'READ_ONLY', 'READONLY', 'HD', 'HIDDEN']);

/** Whether a person may edit the field (see READ_ONLY_ACCESS for what counts as read-only). */
export function isEditable(f: FormField): boolean {
  return !f.accessMode || !READ_ONLY_ACCESS.has(f.accessMode.trim().toUpperCase());
}

/** A field the caller named, plus its value when choosing it already resolved the list item. */
export interface FieldChoice {
  field: FormField;
  picked?: Picked;
}

/** Thrown when a list holds no item matching the caller's text. */
export class NotAListItemError extends McpToolError {
  constructor(message: string, hint: string) {
    super(message, { hint });
    this.name = 'NotAListItemError';
  }
}

/**
 * The one field a caller's name means. With several fields sharing the label,
 * deterministically: only the ones this write can set (when any can); among
 * them an editable REQUIRED one (the dropdown the web app makes you fill);
 * then a list field the text resolves to an item of; then the first match.
 */
export async function chooseField(
  client: ConcurClient,
  fields: readonly FormField[],
  name: string,
  text: string,
  opts: { settable: (f: FormField) => boolean; parentOf: (f: FormField) => string | null },
): Promise<FieldChoice | undefined> {
  const named = fieldsNamed(fields, name);
  if (named.length <= 1) return named[0] ? { field: named[0] } : undefined;
  const settable = named.filter(opts.settable);
  let pool = settable.length > 0 ? settable : named;
  const requiredEditable = pool.filter((f) => f.isRequired && isEditable(f));
  if (requiredEditable.length > 0) pool = requiredEditable;
  if (pool.length > 1) {
    for (const field of pool.filter(isListField)) {
      try {
        return { field, picked: await resolveListValue(client, field, text, opts.parentOf(field)) };
      } catch (err) {
        if (!(err instanceof NotAListItemError)) throw err;
      }
    }
  }
  return { field: pool[0]! };
}

/**
 * The form's "Business Purpose" DROPDOWN, when it has one: a required, editable,
 * settable list field with that label. The `businessPurpose` convenience
 * argument goes there (resolved by item text) rather than to the free-text
 * `businessPurpose` field, which the web app leaves empty on such tenants.
 */
export function businessPurposeList(fields: readonly FormField[], settable: (f: FormField) => boolean): FormField | undefined {
  return fields.find((f) => norm(f.label) === 'business purpose' && isListField(f) && f.isRequired && isEditable(f) && settable(f));
}

const matches = (item: ListItem, want: string) =>
  [item.value, item.code, item.shortCode, item.id].some((s) => s && norm(s) === want);

function pickItem(field: FormField, items: readonly ListItem[], text: string): Picked {
  const want = norm(text);
  const hit = items.find((i) => i.id && matches(i, want));
  if (!hit?.id) {
    const seen = items
      .slice(0, 10)
      .map((i) => i.value || i.code)
      .filter(Boolean);
    throw new NotAListItemError(
      `"${text}" is not an item of the "${labelOf(field)}" list.`,
      seen.length > 0 ? `Close matches: ${seen.join('; ')}. Pass one exactly.` : 'Nothing in that list matched — check the spelling.',
    );
  }
  return { sent: hit.id, display: hit.value || hit.code || hit.id, ...(hit.code ? { code: hit.code } : {}) };
}

/**
 * Resolve a list field's text to its item: a pick list from its `options`, a
 * searchable list through `GetListItems` (variables shaped as the web app sends
 * them). `parentListItemId` is the item chosen one level up a connected list.
 */
export async function resolveListValue(
  client: ConcurClient,
  field: FormField,
  text: string,
  parentListItemId: string | null,
): Promise<Picked> {
  if (!field.list?.id) return pickItem(field, field.options ?? [], text);
  const data = await client.spend<ListItemsData>(LIST_ITEMS, {
    listInformation: {
      id: field.list.id,
      parentListItemId,
      searchBy: field.list.defaultSearchBy ?? null,
      searchByCriteria: text,
    },
  }, { essential: ['CDS_spend.list'] });
  return pickItem(field, data.CDS_spend?.list?.items ?? [], text);
}

/**
 * For a connected list below its top level, the item already chosen in the
 * level above (the field on the same list one `level` up), else null.
 */
export function parentItemOf(
  fields: readonly FormField[],
  field: FormField,
  chosen: (f: FormField) => Picked | undefined,
): string | null {
  const level = field.list?.level ?? 1;
  if (level <= 1) return null;
  const parent = fields.find((f) => f.list?.id === field.list?.id && f.list?.level === level - 1);
  return (parent && chosen(parent)?.sent) ?? null;
}
