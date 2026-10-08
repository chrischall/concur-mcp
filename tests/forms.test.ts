import { afterEach, describe, expect, it } from 'vitest';
import type { TestHarness } from '@chrischall/mcp-utils/test';
import { z } from 'zod';
import type { ConcurClient } from '../src/client.js';
import { LIST_ITEMS } from '../src/graphql/forms.js';
import {
  NotAListItemError,
  businessPurposeList,
  chooseField,
  fieldsNamed,
  isEditable,
  isListField,
  labelOf,
  parentItemOf,
  pickedOf,
  resolveListValue,
  type FormField,
} from '../src/tools/forms.js';
import { textOf, toolHarness } from './helpers.js';

const f = (over: Partial<FormField> = {}): FormField => ({ id: 'custom1', ...over });

describe('pickedOf', () => {
  it('reads a list item value, falling back from text to code to id', () => {
    expect(pickedOf(f({ value: { code: 'US', id: 'C1', listItemValue: 'United States' } }))).toEqual({
      sent: 'C1',
      display: 'United States',
      code: 'US',
    });
    expect(pickedOf(f({ value: { code: 'US', id: 'C1', listItemValue: null } }))).toEqual({ sent: 'C1', display: 'US', code: 'US' });
    expect(pickedOf(f({ value: { code: null, id: 'C1', listItemValue: null } }))).toEqual({ sent: 'C1', display: 'C1' });
  });

  it('reads scalars as strings (an empty string is a value)', () => {
    expect(pickedOf(f({ value: { stringValue: 'Trip' } }))).toEqual({ sent: 'Trip', display: 'Trip' });
    expect(pickedOf(f({ value: { stringValue: '' } }))).toEqual({ sent: '', display: '' });
    expect(pickedOf(f({ value: { booleanValue: false, isValid: true } }))).toEqual({ sent: 'false', display: 'false' });
  });

  it('falls back to the default value when the field holds nothing (or an id-less object)', () => {
    expect(pickedOf(f({ value: { isValid: true, listValue: { id: null, code: null, value: null } } }))).toBeUndefined();
    const listDefault = { list: { id: 'L' }, defaultValue: { value: 'Engineering', code: 'ENG', listItemId: 'ORG1' } };
    expect(pickedOf(f({ value: null, ...listDefault }))).toEqual({ sent: 'ORG1', display: 'Engineering', code: 'ENG' });
    expect(pickedOf(f({ defaultValue: { value: null, code: 'ENG', listItemId: 'ORG1' } }))).toEqual({
      sent: 'ORG1',
      display: 'ENG',
      code: 'ENG',
    });
    expect(pickedOf(f({ defaultValue: { value: null, code: null, listItemId: 'ORG1' } }))).toEqual({ sent: 'ORG1', display: 'ORG1' });
    expect(pickedOf(f({ defaultValue: { value: '2026-10-08', code: null, listItemId: null } }))).toEqual({
      sent: '2026-10-08',
      display: '2026-10-08',
    });
  });

  it('never treats a list default without an item id as a value', () => {
    expect(pickedOf(f({ list: { id: 'L' }, defaultValue: { value: 'Engineering', listItemId: null } }))).toBeUndefined();
    expect(pickedOf(f({ defaultValue: { value: null } }))).toBeUndefined();
    expect(pickedOf(f())).toBeUndefined();
  });
});

describe('field helpers', () => {
  const fields = [f({ id: 'name', label: 'Report Name' }), f({ id: 'custom5', label: 'Business Purpose' }), f({ id: 'custom9', label: null })];

  it('finds by label first, then id, ignoring case and padding — every match', () => {
    expect(fieldsNamed(fields, ' business purpose ').map((x) => x.id)).toEqual(['custom5']);
    expect(fieldsNamed(fields, 'NAME').map((x) => x.id)).toEqual(['name']);
    expect(fieldsNamed(fields, 'custom9').map((x) => x.id)).toEqual(['custom9']);
    expect(fieldsNamed(fields, 'nope')).toEqual([]);
    const twins = [f({ id: 'businessPurpose', label: 'Business Purpose' }), f({ id: 'custom5', label: 'Business Purpose' })];
    expect(fieldsNamed(twins, 'Business Purpose').map((x) => x.id)).toEqual(['businessPurpose', 'custom5']);
  });

  it('treats only explicit read-only / hidden access modes as not editable', () => {
    for (const mode of ['RO', 'ro', 'READ_ONLY', 'ReadOnly', 'HD', 'HIDDEN', ' RO ']) expect(isEditable(f({ accessMode: mode }))).toBe(false);
    for (const mode of ['READ_WRITE', 'RW', 'REQUIRED', 'SOMETHING_NEW', null]) expect(isEditable(f({ accessMode: mode }))).toBe(true);
  });

  it('businessPurposeList finds the required, editable, settable "Business Purpose" dropdown only', () => {
    const text = f({ id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', isRequired: false });
    const list = f({ id: 'custom5', label: 'Business Purpose', dataType: 'LIST', isRequired: true, list: { id: 'LST_BP' } });
    const all = () => true;
    expect(businessPurposeList([text, list], all)?.id).toBe('custom5');
    expect(businessPurposeList([text], all)).toBeUndefined();
    expect(businessPurposeList([{ ...list, isRequired: false }], all)).toBeUndefined();
    expect(businessPurposeList([{ ...list, accessMode: 'RO' }], all)).toBeUndefined();
    expect(businessPurposeList([list], () => false)).toBeUndefined();
  });

  it('labels, list-ness and editability', () => {
    expect(labelOf(fields[2]!)).toBe('custom9');
    expect(labelOf(fields[1]!)).toBe('Business Purpose');
    expect(isListField(f({ options: [{ id: 'Y' }] }))).toBe(true);
    expect(isListField(f({ options: [] }))).toBe(false);
    expect(isListField(f({ list: { id: 'L' } }))).toBe(true);
    expect(isEditable(f())).toBe(true);
    expect(isEditable(f({ accessMode: 'READ_WRITE' }))).toBe(true);
    expect(isEditable(f({ accessMode: 'RO' }))).toBe(false);
  });

  it('a connected list level takes the item chosen one level up', () => {
    const top = f({ id: 'orgUnit1', list: { id: 'ORG', level: 1 } });
    const mid = f({ id: 'orgUnit2', list: { id: 'ORG', level: 2 } });
    const low = f({ id: 'orgUnit3', list: { id: 'ORG', level: 3 } });
    const all = [top, mid, low];
    const chosen = (x: FormField) => (x === top ? { sent: 'ORG1', display: 'Eng' } : undefined);
    expect(parentItemOf(all, top, chosen)).toBeNull();
    expect(parentItemOf(all, f({ list: { id: 'X' } }), chosen)).toBeNull();
    expect(parentItemOf(all, mid, chosen)).toBe('ORG1');
    expect(parentItemOf(all, low, chosen)).toBeNull(); // level 2 not chosen yet
    expect(parentItemOf([low], low, chosen)).toBeNull(); // no level-2 field at all
  });
});

describe('chooseField (same-label twins)', () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function choose(fields: FormField[], name: string, text: string, script: unknown[], settable: (x: FormField) => boolean = () => true) {
    const t = await toolHarness(
      (server, client: ConcurClient) =>
        server.registerTool('probe', { inputSchema: z.object({}) }, async () => {
          const choice = await chooseField(client, fields, name, text, { settable, parentOf: () => null });
          return { content: [{ type: 'text' as const, text: JSON.stringify(choice ?? null) }] };
        }),
      script,
    );
    harness = t.harness;
    const result = await t.harness.callTool('probe', {});
    const answer = textOf(result);
    const out = (result as { isError?: boolean }).isError ? null : (JSON.parse(answer) as { field: FormField; picked?: unknown } | null);
    return { out, sent: t.sent, text: answer };
  }

  // The live new-report form: a free-text twin and the required dropdown the web app shows.
  const freeText: FormField = { id: 'businessPurpose', label: 'Business Purpose', dataType: 'STRING', isRequired: false, accessMode: 'READ_WRITE' };
  const dropdown: FormField = {
    id: 'custom5',
    label: 'Business Purpose',
    dataType: 'LIST',
    isRequired: true,
    accessMode: 'READ_WRITE',
    list: { id: 'LST_BP', level: 1, defaultSearchBy: 'TEXT' },
  };

  it('"Business Purpose" picks the required editable dropdown (custom5) over the free-text field, in either order', async () => {
    expect((await choose([freeText, dropdown], 'Business Purpose', 'Internal Meetings/Expenses', [])).out?.field.id).toBe('custom5');
    await harness?.close();
    expect((await choose([dropdown, freeText], 'business purpose', 'x', [])).out?.field.id).toBe('custom5');
  });

  it('a single match or none needs no tie-break', async () => {
    expect((await choose([freeText], 'Business Purpose', 'x', [])).out?.field.id).toBe('businessPurpose');
    await harness?.close();
    expect((await choose([freeText], 'Nope', 'x', [])).out).toBeNull();
  });

  it('when no twin is settable, all of them still compete (the caller then refuses the pick)', async () => {
    const { out } = await choose([freeText, dropdown], 'Business Purpose', 'x', [], () => false);
    expect(out?.field.id).toBe('custom5');
  });

  it('only settable twins compete when any is settable', async () => {
    const ro = { ...dropdown, id: 'custom6', accessMode: 'RO' };
    const { out } = await choose([ro, freeText], 'Business Purpose', 'x', [], (x) => x.accessMode !== 'RO');
    expect(out?.field.id).toBe('businessPurpose');
  });

  it('with no required twin, a list the text resolves in wins — and its item is returned', async () => {
    const a = { ...dropdown, id: 'custom5', isRequired: false, list: { id: 'LST_A', level: 1 } };
    const b = { ...dropdown, id: 'custom6', isRequired: false, list: { id: 'LST_B', level: 1 } };
    const { out, sent } = await choose([freeText, a, b], 'Business Purpose', 'Team lunch', [
      { CDS_spend: { list: { items: [{ id: 'A1', value: 'Other' }] } } },
      { CDS_spend: { list: { items: [{ id: 'B1', value: 'Team lunch' }] } } },
    ]);
    expect(sent).toHaveLength(2);
    expect(out?.field.id).toBe('custom6');
    expect(out?.picked).toEqual({ sent: 'B1', display: 'Team lunch' });
  });

  it('falls back to the first match when no list resolves the text', async () => {
    const a = { ...dropdown, isRequired: false };
    const { out } = await choose([freeText, a], 'Business Purpose', 'zzz', [{ CDS_spend: { list: { items: [] } } }]);
    expect(out?.field.id).toBe('businessPurpose');
  });

  it('two required twins: the list the text resolves in wins', async () => {
    const req = { ...freeText, isRequired: true };
    const { out } = await choose([req, dropdown], 'Business Purpose', 'Client visit', [
      { CDS_spend: { list: { items: [{ id: 'BP_CV', value: 'Client visit' }] } } },
    ]);
    expect(out?.field.id).toBe('custom5');
  });

  it('a lookup failure that is not "no such item" is not swallowed', async () => {
    const a = { ...dropdown, isRequired: false };
    const { text } = await choose([freeText, a], 'Business Purpose', 'x', [
      new Response(JSON.stringify({ data: null, errors: [{ message: 'boom', extensions: { correlationId: 'c' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(text).toContain('correlationId=c');
  });

  it('NotAListItemError is an McpToolError with a hint', () => {
    const err = new NotAListItemError('m', 'h');
    expect(err.name).toBe('NotAListItemError');
    expect(err.hint).toBe('h');
  });
});

describe('resolveListValue', () => {
  let harness: TestHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** Run resolveListValue through a real ConcurClient (fetch scripted) via a throwaway tool. */
  async function resolve(field: FormField, text: string, parent: string | null, script: unknown[]) {
    const t = await toolHarness(
      (server, client: ConcurClient) =>
        server.registerTool('probe', { inputSchema: z.object({}) }, async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify(await resolveListValue(client, field, text, parent)) }],
        })),
      script,
    );
    harness = t.harness;
    const result = await t.harness.callTool('probe', {});
    return { text: textOf(result), sent: t.sent, isError: (result as { isError?: boolean }).isError };
  }

  it('matches a pick list option by text, code or id without a network call', async () => {
    const field = f({ label: 'Billable', options: [{ id: 'Y', code: 'YES', value: 'Yes' }, { id: 'N', code: null, value: null }] });
    expect(JSON.parse((await resolve(field, 'yes', null, [])).text)).toEqual({ sent: 'Y', display: 'Yes', code: 'YES' });
    expect(JSON.parse((await resolve(field, 'n', null, [])).text)).toEqual({ sent: 'N', display: 'N' });
  });

  it('searches a list with the variables the web app sends and picks the exact match', async () => {
    const field = f({ label: 'Department', list: { id: 'LST_ORG', level: 2, defaultSearchBy: 'TEXT' } });
    const items = { CDS_spend: { list: { items: [{ id: 'D1', code: 'QA2', value: 'QA Tools' }, { id: 'D2', code: null, shortCode: 'QA', value: null }] } } };
    const { text, sent } = await resolve(field, 'qa', 'ORG1', [items]);
    expect(sent[0]!.query).toBe(LIST_ITEMS);
    expect(sent[0]!.variables).toEqual({
      listInformation: { id: 'LST_ORG', parentListItemId: 'ORG1', searchBy: 'TEXT', searchByCriteria: 'qa' },
    });
    expect(JSON.parse(text)).toEqual({ sent: 'D2', display: 'D2' });
  });

  it('sends a null searchBy when the list has none', async () => {
    const field = f({ list: { id: 'LST' } });
    const { sent } = await resolve(field, 'x', null, [{ CDS_spend: { list: { items: [{ id: 'X1', value: 'x' }] } } }]);
    expect((sent[0]!.variables.listInformation as { searchBy: unknown }).searchBy).toBeNull();
  });

  it('refuses a near miss, listing what the list did return', async () => {
    const field = f({ label: 'Business Purpose', list: { id: 'LST_BP' } });
    const items = { CDS_spend: { list: { items: [{ id: 'B1', value: 'Client visit' }, { id: 'B2', code: 'TRN', value: null }, { id: 'B3' }] } } };
    const { text, isError } = await resolve(field, 'client', null, [items]);
    expect(isError).toBe(true);
    expect(text).toContain('"client" is not an item of the "Business Purpose" list.');
    expect(text).toContain('Close matches: Client visit; TRN. Pass one exactly.');
  });

  it('says so when the list returned nothing at all', async () => {
    const field = f({ label: 'Business Purpose', list: { id: 'LST_BP' } });
    for (const empty of [{ CDS_spend: { list: { items: null } } }, { CDS_spend: null }]) {
      const { text, isError } = await resolve(field, 'zzz', null, [empty]);
      expect(isError).toBe(true);
      expect(text).toContain('Nothing in that list matched');
      await harness?.close();
      harness = undefined;
    }
  });

  it('a pick list with no options at all refuses too', async () => {
    const { text } = await resolve(f({ label: 'Billable', options: null }), 'yes', null, []);
    expect(text).toContain('Nothing in that list matched');
  });
});
