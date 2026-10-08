import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DENIED_MUTATIONS, findDeniedMutation, inspectGraphqlDocument } from '../src/graphql-guard.js';
import { SUBMIT_REPORT } from '../src/graphql/report-writes.js';
import { SEND_ITINERARY } from '../src/graphql/travel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** One `### name` section of a docs/api file, verbatim. */
function docOperation(file: string, name: string): string {
  const text = readFileSync(join(ROOT, 'docs/api', file), 'utf8');
  const start = text.indexOf(`### ${name}\n`);
  if (start < 0) throw new Error(`${name} not in ${file}`);
  const body = text.slice(start + name.length + 5);
  const end = body.search(/^#{2,3} /m);
  return end < 0 ? body : body.slice(0, end);
}

describe('inspectGraphqlDocument', () => {
  it('reads operations, field names and aliases, skipping arguments, variables, directives and fragments refs', () => {
    const doc = `# a comment mentioning submit
      mutation Save($submit: Boolean = true, $obj: In = {submit: 1}) {
        travel @skip(if: $submit) {
          renamed: trip(note: "submit hold") {
            ...TripBits
            ... on TravelTrip { tripId }
          }
        }
      }
      fragment TripBits on TravelTrip { name description }`;
    const info = inspectGraphqlDocument(doc);
    expect(info.operations).toEqual([{ kind: 'mutation', name: 'Save' }]);
    expect(info.fragments).toEqual(['TripBits']);
    expect([...info.fields].sort()).toEqual(['description', 'name', 'renamed', 'travel', 'trip', 'tripId'].sort());
  });

  it('treats a `{ … }` shorthand as an anonymous query', () => {
    expect(inspectGraphqlDocument('{ employee { userId } }').operations).toEqual([{ kind: 'query', name: undefined }]);
  });

  it('ignores block-string contents (with escaped triple quotes)', () => {
    const info = inspectGraphqlDocument('mutation { x(a: """ hold \\""" submit """) { y } }');
    expect([...info.fields].sort()).toEqual(['x', 'y']);
  });

  it('reads a leading BOM, escaped quotes, directive arguments and untyped inline fragments', () => {
    const info = inspectGraphqlDocument(
      '\uFEFFquery { a(s: "q\\"hold\\"") @include(if: true) { ... @skip(if: false) { b } ... { c @client } } }',
    );
    expect(info.operations).toEqual([{ kind: 'query', name: undefined }]);
    expect([...info.fields].sort()).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['unterminated string', 'mutation { x(a: "oops) { y } }'],
    ['unterminated block string', 'mutation { x(a: """ oops) { y } }'],
    ['a missing selection set', 'query X }'],
    ['mismatched brackets in arguments', 'query X($a: [Int) { y }'],
    ['an empty selection set', 'query { }'],
    ['a fragment without a type condition', 'fragment F X { a }'],
    ['unbalanced braces', 'mutation { x { y }'],
    ['stray closer', 'mutation { x } }'],
    ['unknown character', 'mutation { x % y }'],
    ['empty document', '   # only a comment'],
    ['unknown top-level word', 'extend type X { y: Int }'],
  ])('throws on a malformed document (%s)', (_label, doc) => {
    expect(() => inspectGraphqlDocument(doc)).toThrow();
  });
});

describe('findDeniedMutation — one test per deny-list entry', () => {
  it('lists exactly the planned entries', () => {
    expect(DENIED_MUTATIONS.map((d) => d.id)).toEqual([
      'submit',
      'tryCancelTripOrBooking',
      'holdTrip',
      'confirmTrip',
      'commitChange',
      'saveBookingSelections',
      'startSearch',
      'processApproval',
      'updateWorkItemStatus',
    ]);
  });

  it('submit: CDS_expense.report.submit points at concur_submit_report', () => {
    const hit = findDeniedMutation(SUBMIT_REPORT);
    expect(hit?.id).toBe('submit');
    expect(hit?.reason).toMatch(/concur_submit_report/);
    // Renamed operation and an alias still hit the field.
    expect(findDeniedMutation('mutation Anything { CDS_expense { report { s: submit(id: "R") { status } } } }')?.id).toBe(
      'submit',
    );
    // The operation name alone (field hidden in a fragment spread is still a field in the doc).
    expect(
      findDeniedMutation(
        'mutation X { CDS_expense { report { ...S } } } fragment S on CDS_ExpenseReportMutation { submit(id: "R") { status } }',
      )?.id,
    ).toBe('submit');
  });

  const outOfScope: Array<[string, string, string]> = [
    ['tryCancelTripOrBooking', 'travel-operations.graphql', 'tryCancelTripOrBooking'],
    ['holdTrip', 'travel-operations.graphql', 'holdTrip'],
    ['confirmTrip', 'travel-operations.graphql', 'confirmTrip'],
    ['commitChange', 'travel-operations.graphql', 'commitChange'],
    ['saveBookingSelections', 'travel-operations.graphql', 'saveBookingSelections'],
    ['startSearch', 'travel-operations.graphql', 'startSearch'],
    ['processApproval', 'travel-operations.graphql', 'processApproval'],
    ['updateWorkItemStatus', 'travel-operations.graphql', 'updateWorkItemStatus'],
  ];

  it.each(outOfScope)('%s: the web app’s own text is refused as out of scope', (id, file, name) => {
    const hit = findDeniedMutation(docOperation(file, name));
    expect(hit?.id).toBe(id);
    expect(hit?.reason).toMatch(/out of scope/i);
  });

  it.each(outOfScope)('%s: refused even when the operation is renamed', (id, file, name) => {
    const renamed = docOperation(file, name).replace(new RegExp(`mutation ${name}\\b`), 'mutation Innocent');
    expect(renamed).not.toContain(`mutation ${name}`);
    expect(findDeniedMutation(renamed)?.id).toBe(id);
  });

  it.each(outOfScope.map(([id]) => [id]))('%s: refused by operation name alone', (id) => {
    expect(findDeniedMutation(`mutation ${id} { travel { noop } }`)?.id).toBe(id);
  });

  it('lets an unrelated mutation through', () => {
    expect(findDeniedMutation(SEND_ITINERARY)).toBeUndefined();
    expect(findDeniedMutation(docOperation('spend-operations.graphql', 'DeleteExpenseEntries'))).toBeUndefined();
  });

  it('does not match a denied word inside a string argument or a comment', () => {
    expect(findDeniedMutation('mutation { x(note: "holdTrip submit") { y } } # tryCancel')).toBeUndefined();
  });
});
