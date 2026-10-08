// What a caller-supplied GraphQL document actually does, for the raw escape
// hatches: its operations, the fragments it defines, and every field name (and
// alias) it selects. A small tokenizer, so string, block-string and comment
// contents can never look like a field, and argument / variable / directive
// names are never counted. Anything it cannot read is thrown, never guessed.
//
// mcp-utils' isReadOnlyGraphqlDocument decides "query or not"; this module
// decides "which mutation" for the deny-list.

export interface GraphqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  /** The operation name; undefined for an anonymous operation. */
  name: string | undefined;
}

export interface GraphqlDocumentInfo {
  operations: GraphqlOperation[];
  /** Names of the fragments the document defines. */
  fragments: string[];
  /** Every field name and alias selected anywhere (operations and fragments). */
  fields: Set<string>;
}

type Token = { type: 'name'; value: string } | { type: 'punct'; value: string };

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;
const NUMBER_PART = /[-+.0-9eE]/;

function tokenize(doc: string): Token[] {
  const tokens: Token[] = [];
  let i = doc.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = doc.length;
  while (i < n) {
    const c = doc[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
    } else if (c === '#') {
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (doc.startsWith('"""', i)) {
      i += 3;
      for (;;) {
        if (i >= n) throw new Error('unterminated block string');
        if (doc.startsWith('\\"""', i)) i += 4;
        else if (doc.startsWith('"""', i)) {
          i += 3;
          break;
        } else i++;
      }
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= n || doc[i] === '\n' || doc[i] === '\r') throw new Error('unterminated string');
        if (doc[i] === '\\') i += 2;
        else if (doc[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (doc.startsWith('...', i)) {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
    } else if (PUNCT.has(c)) {
      tokens.push({ type: 'punct', value: c });
      i++;
    } else if (NAME_START.test(c)) {
      const start = i;
      while (i < n && NAME_PART.test(doc[i]!)) i++;
      tokens.push({ type: 'name', value: doc.slice(start, i) });
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      while (i < n && NUMBER_PART.test(doc[i]!)) i++;
    } else {
      throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
    }
  }
  return tokens;
}

const OPERATION_KINDS = new Set(['query', 'mutation', 'subscription']);

/** A cursor over the token list with the few reads the grammar needs. */
class Cursor {
  private k = 0;
  constructor(private readonly tokens: Token[]) {}
  get done(): boolean {
    return this.k >= this.tokens.length;
  }
  peek(offset = 0): Token | undefined {
    return this.tokens[this.k + offset];
  }
  isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.type === 'punct' && t.value === value;
  }
  isName(offset = 0): boolean {
    return this.peek(offset)?.type === 'name';
  }
  next(): Token {
    const t = this.tokens[this.k++];
    if (!t) throw new Error('unexpected end of document');
    return t;
  }
  name(): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t.value)}`);
    return t.value;
  }
  expect(value: string): void {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t.value)}`);
  }
  /** Skip a balanced `( … )` group (arguments, variable definitions) without reading it. */
  skipGroup(): void {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const stack: string[] = [];
    do {
      const t = this.next();
      if (t.type !== 'punct') continue;
      if (pairs[t.value]) stack.push(pairs[t.value]!);
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        if (stack.pop() !== t.value) throw new Error(`unbalanced ${t.value}`);
      }
    } while (stack.length > 0);
  }
}

function skipDirectives(c: Cursor): void {
  while (c.isPunct('@')) {
    c.next();
    c.name();
    if (c.isPunct('(')) c.skipGroup();
  }
}

function readSelectionSet(c: Cursor, fields: Set<string>): void {
  c.expect('{');
  let empty = true;
  while (!c.isPunct('}')) {
    empty = false;
    if (c.isPunct('...')) {
      c.next();
      if (c.isName() && (c.peek() as { value: string }).value === 'on') {
        c.next();
        c.name(); // type condition
        skipDirectives(c);
        readSelectionSet(c, fields);
      } else if (c.isName()) {
        c.name(); // fragment spread
        skipDirectives(c);
      } else {
        skipDirectives(c);
        readSelectionSet(c, fields);
      }
      continue;
    }
    fields.add(c.name());
    if (c.isPunct(':')) {
      c.next();
      fields.add(c.name()); // the field behind an alias
    }
    if (c.isPunct('(')) c.skipGroup();
    skipDirectives(c);
    if (c.isPunct('{')) readSelectionSet(c, fields);
  }
  if (empty) throw new Error('empty selection set');
  c.expect('}');
}

/**
 * Read a GraphQL document. Throws on anything it cannot parse: an unterminated
 * string, unbalanced brackets, an unknown character or top-level word, or a
 * document with no definitions.
 */
export function inspectGraphqlDocument(doc: string): GraphqlDocumentInfo {
  const c = new Cursor(tokenize(doc));
  const operations: GraphqlOperation[] = [];
  const fragments: string[] = [];
  const fields = new Set<string>();

  while (!c.done) {
    if (c.isPunct('{')) {
      operations.push({ kind: 'query', name: undefined });
      readSelectionSet(c, fields);
      continue;
    }
    const keyword = c.name();
    if (OPERATION_KINDS.has(keyword)) {
      const name = c.isName() ? c.name() : undefined;
      if (c.isPunct('(')) c.skipGroup();
      skipDirectives(c);
      operations.push({ kind: keyword as GraphqlOperation['kind'], name });
      readSelectionSet(c, fields);
    } else if (keyword === 'fragment') {
      fragments.push(c.name());
      if (c.name() !== 'on') throw new Error('fragment without a type condition');
      c.name();
      skipDirectives(c);
      readSelectionSet(c, fields);
    } else {
      throw new Error(`unexpected word ${JSON.stringify(keyword)} at the top level`);
    }
  }

  if (operations.length === 0 && fragments.length === 0) throw new Error('no definitions');
  return { operations, fragments, fields };
}

// ── deny-list ─────────────────────────────────────────────────────────────

export interface DeniedMutation {
  /** The web app's operation name. */
  id: string;
  /** Operation names refused outright (case-insensitive). */
  operationNames: readonly string[];
  /** Field names refused wherever they are selected (case-insensitive). */
  fields: readonly string[];
  /** The refusal, shown to the caller. */
  reason: string;
}

const outOfScope = (what: string) =>
  `${what} is out of scope for this MCP and is refused by the raw-GraphQL escape hatch; do it in the Concur web app.`;

/**
 * Mutations concur_graphql_mutation refuses, matched by operation name AND by
 * the field the web app's text selects (docs/api/*.graphql), so renaming the
 * operation or aliasing the field does not get one through.
 */
export const DENIED_MUTATIONS: readonly DeniedMutation[] = [
  {
    id: 'submit',
    operationNames: ['SubmitExpenseReport'],
    fields: ['submit'],
    reason:
      'Submitting an expense report (CDS_expense.report.submit) sends it to your approver — use concur_submit_report, ' +
      'which validates the report and shows what will be submitted first.',
  },
  {
    id: 'tryCancelTripOrBooking',
    operationNames: ['tryCancelTripOrBooking'],
    fields: ['tryCancel'],
    reason: outOfScope('Cancelling a trip or booking (travel.trip.tryCancel)'),
  },
  {
    id: 'holdTrip',
    operationNames: ['holdTrip'],
    fields: ['hold'],
    reason: outOfScope('Putting a trip on hold (travel.trip.hold)'),
  },
  {
    id: 'confirmTrip',
    operationNames: ['confirmTrip'],
    fields: ['confirmV2', 'confirm'],
    reason: outOfScope('Confirming (booking) a trip (travel.trip.confirmV2)'),
  },
  {
    id: 'commitChange',
    operationNames: ['commitChange'],
    fields: ['commitChange'],
    reason: outOfScope('Committing a trip change (travel.trip.commitChange)'),
  },
  {
    id: 'saveBookingSelections',
    operationNames: ['saveBookingSelections'],
    fields: ['saveBookingSelections'],
    reason: outOfScope('Saving booking selections (travel.air.saveBookingSelections)'),
  },
  {
    id: 'startSearch',
    operationNames: ['startSearch'],
    fields: ['startSearch'],
    reason: outOfScope('Starting a travel search (travel.trip.tripPlan.startSearch)'),
  },
  {
    id: 'processApproval',
    operationNames: ['processApproval'],
    fields: ['processApproval'],
    reason: outOfScope('Approving or rejecting (travel.approval.processApproval)'),
  },
  {
    id: 'updateWorkItemStatus',
    operationNames: ['updateWorkItemStatus'],
    fields: ['updateDelegatesDashboardWorkItemStatus'],
    reason: outOfScope("Changing a delegate dashboard work item's status (travel.trip.updateDelegatesDashboardWorkItemStatus)"),
  },
];

/** The first deny-list entry the document hits, or undefined. Throws on an unreadable document. */
export function findDeniedMutation(doc: string): DeniedMutation | undefined {
  const info = inspectGraphqlDocument(doc);
  const names = new Set(info.operations.map((o) => o.name?.toLowerCase()).filter((n): n is string => !!n));
  const fields = new Set([...info.fields].map((f) => f.toLowerCase()));
  return DENIED_MUTATIONS.find(
    (d) => d.operationNames.some((n) => names.has(n.toLowerCase())) || d.fields.some((f) => fields.has(f.toLowerCase())),
  );
}
