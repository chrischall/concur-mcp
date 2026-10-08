import { describe, expect, it } from 'vitest';
import { graphqlOperationKinds, isReadOnlyGraphqlDocument } from '@chrischall/mcp-utils/graphql';
import * as expenseWrites from '../src/graphql/expense-writes.js';
import * as expenses from '../src/graphql/expenses.js';
import * as lookups from '../src/graphql/lookups.js';
import * as forms from '../src/graphql/forms.js';
import * as reportWrites from '../src/graphql/report-writes.js';
import * as receipts from '../src/graphql/receipts.js';
import * as reports from '../src/graphql/reports.js';
import * as travel from '../src/graphql/travel.js';

const documents = Object.entries({ ...reports, ...expenses, ...lookups }).filter(
  ([, value]) => typeof value === 'string' && /^\s*query\b/.test(value),
) as Array<[string, string]>;

describe('read documents', () => {
  it('covers every read tool document', () => {
    expect(documents.map(([name]) => name).sort()).toEqual(
      [
        'GET_EXPENSE',
        'GET_REPORT',
        'GET_REPORT_POLICY',
        'GET_REPORT_TIMELINE',
        'LIST_AVAILABLE_EXPENSES',
        'LIST_CURRENCIES',
        'LIST_EXPENSE_TYPES',
        'LIST_PAYMENT_TYPES',
        'LIST_REPORTS',
        'SEARCH_LOCATIONS',
        'WHOAMI',
      ].sort(),
    );
  });

  it.each(documents)('%s lexes as a single read-only query', (_name, doc) => {
    expect(isReadOnlyGraphqlDocument(doc)).toBe(true);
    expect(graphqlOperationKinds(doc)).toEqual(['query']);
  });

  it.each(documents)('%s has balanced braces and parentheses', (_name, doc) => {
    const count = (ch: string) => doc.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
  });

  it('no tool document selects the unused legacy keys rptKey / rpeKey', () => {
    const all = Object.values({ ...reports, ...expenses, ...lookups, ...forms, ...reportWrites, ...receipts, ...expenseWrites, ...travel });
    for (const doc of all) {
      if (typeof doc !== 'string') continue;
      expect(doc).not.toMatch(/\brptKey\b/);
      expect(doc).not.toMatch(/\brpeKey\b/);
    }
  });

  it('the shared entry-summary selection is a fragment body, not a document', () => {
    expect(reports.ENTRY_SUMMARY_FIELDS).not.toMatch(/^\s*query/);
    expect(reports.GET_REPORT).toContain('vendor { id description name }');
    expect(expenses.GET_EXPENSE).toContain('vendor { id description name }');
  });
});

const writeModuleDocs = Object.entries({ ...forms, ...reportWrites }).filter(
  ([, value]) => typeof value === 'string' && /^\s*(query|mutation)\b/.test(value),
) as Array<[string, string]>;

describe('report write documents', () => {
  it('covers the form reads and every report-header mutation', () => {
    expect(writeModuleDocs.map(([name]) => name).sort()).toEqual(
      [
        'CREATE_REPORT',
        'CREATE_REPORT_COMMENT',
        'DELETE_EXPENSE_ENTRIES',
        'DELETE_REPORT',
        'LIST_ITEMS',
        'NEW_REPORT_FORM',
        'RECALL_REPORT',
        'REPORT_FORM',
        'SUBMIT_REPORT',
        'UPDATE_REPORT',
      ].sort(),
    );
  });

  it.each(writeModuleDocs)('%s lexes as exactly one operation of the kind its keyword says', (_name, doc) => {
    const kind = /^\s*(query|mutation)/.exec(doc)![1];
    expect(graphqlOperationKinds(doc)).toEqual([kind]);
    expect(isReadOnlyGraphqlDocument(doc)).toBe(kind === 'query');
  });

  it.each(writeModuleDocs)('%s has balanced braces and parentheses', (_name, doc) => {
    const count = (ch: string) => doc.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
  });

  it('the form-field selection is a fragment body, not a document', () => {
    expect(forms.FORM_FIELD).not.toMatch(/^\s*(query|mutation)/);
    expect(forms.FORM_VALUE).toMatch(/^value \{/);
  });
});

const expenseWriteDocs = Object.entries(expenseWrites) as Array<[string, string]>;

describe('expense write documents', () => {
  it('covers the expense forms and every expense mutation', () => {
    expect(expenseWriteDocs.map(([name]) => name).sort()).toEqual(
      [
        'COPY_EXPENSE',
        'CREATE_EXPENSE',
        'DELETE_AVAILABLE_EXPENSES',
        'EXPENSE_FORM',
        'MOVE_AVAILABLE_EXPENSES',
        'NEW_EXPENSE_FORM',
        'UPDATE_EXPENSE',
      ].sort(),
    );
  });

  it.each(expenseWriteDocs)('%s lexes as exactly one operation of the kind its keyword says', (_name, doc) => {
    const kind = /^\s*(query|mutation)/.exec(doc)![1];
    expect(graphqlOperationKinds(doc)).toEqual([kind]);
    expect(isReadOnlyGraphqlDocument(doc)).toBe(kind === 'query');
  });

  it.each(expenseWriteDocs)('%s has balanced braces and parentheses and declares every variable it uses', (_name, doc) => {
    const count = (ch: string) => doc.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
    const declared = new Set([...doc.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...doc.matchAll(/\$(\w+)\b(?!\s*:)/g)].map((m) => m[1]));
    expect([...used].filter((v) => !declared.has(v))).toEqual([]);
    expect([...declared].filter((v) => !used.has(v))).toEqual([]);
  });

  it('trims the trex response blocks the tools never read', () => {
    for (const [, doc] of expenseWriteDocs) expect(doc).not.toContain('isTrexEnabled');
  });
});

const receiptDocs = Object.entries(receipts).filter(
  ([, value]) => typeof value === 'string' && /^\s*(query|mutation)\b/.test(value),
) as Array<[string, string]>;

describe('receipt documents', () => {
  it('covers the receipt reads and every receipt mutation', () => {
    expect(receiptDocs.map(([name]) => name).sort()).toEqual(
      [
        'APPEND_RECEIPT',
        'ATTACH_RECEIPT',
        'DELETE_RECEIPT',
        'DETACH_RECEIPT',
        'GET_RECEIPT',
        'LIST_AVAILABLE_RECEIPTS',
      ].sort(),
    );
    expect(receipts.RECEIPT_FIELDS).not.toMatch(/^\s*(query|mutation)/);
  });

  it.each(receiptDocs)('%s lexes as exactly one operation of the kind its keyword says', (_name, doc) => {
    const kind = /^\s*(query|mutation)/.exec(doc)![1];
    expect(graphqlOperationKinds(doc)).toEqual([kind]);
    expect(isReadOnlyGraphqlDocument(doc)).toBe(kind === 'query');
  });

  it.each(receiptDocs)('%s has balanced braces and parentheses and declares every variable it uses', (_name, doc) => {
    const count = (ch: string) => doc.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
    const declared = new Set([...doc.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...doc.matchAll(/\$(\w+)\b(?!\s*:)/g)].map((m) => m[1]));
    expect([...used].filter((v) => !declared.has(v))).toEqual([]);
    expect([...declared].filter((v) => !used.has(v))).toEqual([]);
  });

  it('names each operation as the bundle does', () => {
    expect(receipts.ATTACH_RECEIPT).toMatch(/mutation AttachImage\(/);
    expect(receipts.ATTACH_RECEIPT).toContain('attachImage(imageId: $imageId)');
    expect(receipts.APPEND_RECEIPT).toContain('appendImage(imageId: $imageId)');
    expect(receipts.DETACH_RECEIPT).toMatch(/detachImage \{/);
    expect(receipts.DETACH_RECEIPT).not.toContain('$imageId');
    expect(receipts.GET_RECEIPT).toMatch(/query GetLineItemImage\(/);
    expect(receipts.LIST_AVAILABLE_RECEIPTS).toMatch(/query GetAvailableReceipts\(/);
  });
});

const travelDocs = Object.entries(travel) as Array<[string, string]>;

describe('travel documents', () => {
  it('covers the three trip reads and the itinerary email', () => {
    expect(travelDocs.map(([name]) => name).sort()).toEqual(
      ['GET_TRIP', 'GET_TRIP_HISTORY', 'LIST_TRIPS', 'SEND_ITINERARY'].sort(),
    );
  });

  it.each(travelDocs)('%s lexes as exactly one operation of the kind its keyword says', (_name, doc) => {
    const kind = /^\s*(query|mutation)/.exec(doc)![1];
    expect(graphqlOperationKinds(doc)).toEqual([kind]);
    expect(isReadOnlyGraphqlDocument(doc)).toBe(kind === 'query');
  });

  it.each(travelDocs)('%s has balanced braces and parentheses and declares every variable it uses', (_name, doc) => {
    const count = (ch: string) => doc.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
    const declared = new Set([...doc.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...doc.matchAll(/\$(\w+)\b(?!\s*:)/g)].map((m) => m[1]));
    expect([...used].filter((v) => !declared.has(v))).toEqual([]);
    expect([...declared].filter((v) => !used.has(v))).toEqual([]);
  });

  it('names each operation as the bundle does and uses no unresolved fragments', () => {
    expect(travel.LIST_TRIPS).toMatch(/^query loadTripList\(/);
    expect(travel.GET_TRIP).toMatch(/^query loadOverviewTrip\(/);
    expect(travel.GET_TRIP_HISTORY).toMatch(/^query loadTripHistory\(/);
    expect(travel.SEND_ITINERARY).toMatch(/^mutation sendItinerary\(\$input: TravelTripSendItineraryEmailInput!\)/);
    for (const [, doc] of travelDocs) expect(doc).not.toMatch(/\.\.\.[A-Za-z]/);
  });
});
