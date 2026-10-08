import { afterEach, describe, expect, it, vi } from 'vitest';
import { money, personName, prune, respond, trueFlags, withWarnings } from '../src/tools/shared.js';

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe('money', () => {
  it('formats value + currency, value alone, and absent amounts', () => {
    expect(money({ value: 12.5, currencyCode: 'USD' })).toBe('12.5 USD');
    expect(money({ value: 0, currencyCode: 'EUR' })).toBe('0 EUR');
    expect(money({ value: 3, currencyCode: null })).toBe('3');
    expect(money({ value: null, currencyCode: 'USD' })).toBeUndefined();
    expect(money({})).toBeUndefined();
    expect(money(null)).toBeUndefined();
    expect(money(undefined)).toBeUndefined();
  });
});

describe('withWarnings', () => {
  const w = [{ path: 'a.b', message: 'An error occurred' }];
  it('adds warnings to an object, wraps anything else, and is a no-op without warnings', () => {
    expect(withWarnings({ x: 1 }, w)).toEqual({ x: 1, warnings: w });
    expect(withWarnings([1, 2], w)).toEqual({ result: [1, 2], warnings: w });
    expect(withWarnings('s', w)).toEqual({ result: 's', warnings: w });
    expect(withWarnings(null, w)).toEqual({ result: null, warnings: w });
    const same = { x: 1 };
    expect(withWarnings(same, [])).toBe(same);
  });
});

describe('personName', () => {
  it('prefers the preferred name, falls back to first, and is undefined when empty', () => {
    expect(personName({ firstName: 'Robert', lastName: 'Smith', preferredName: 'Bob' })).toBe('Bob Smith');
    expect(personName({ firstName: 'Robert', lastName: 'Smith', preferredName: null })).toBe('Robert Smith');
    expect(personName({ lastName: 'Smith' })).toBe('Smith');
    expect(personName({})).toBeUndefined();
    expect(personName(null)).toBeUndefined();
  });
});

describe('prune / trueFlags', () => {
  it('prune drops null and undefined but keeps false, 0 and ""', () => {
    expect(prune({ a: null, b: undefined, c: false, d: 0, e: '' })).toEqual({ c: false, d: 0, e: '' });
  });

  it('trueFlags lists keys that are exactly true', () => {
    expect(trueFlags({ a: true, b: false, c: 'true', d: ['x'] })).toEqual(['a']);
    expect(trueFlags({ a: false })).toBeUndefined();
    expect(trueFlags(null)).toBeUndefined();
  });
});

describe('respond', () => {
  afterEach(() => vi.restoreAllMocks());
  const raw = { wrapper: { items: [1, 2] } };
  const projections = { compact: (r: typeof raw) => ({ n: r.wrapper.items.length }), full: (r: typeof raw) => r.wrapper };

  it('defaults to compact, minified', () => {
    expect(text(respond(undefined, raw, projections, { context: 't' }))).toBe('{"n":2}');
  });

  it('full unwraps; raw is the data untouched and indented', () => {
    expect(text(respond('full', raw, projections, { context: 't' }))).toBe('{"items":[1,2]}');
    expect(JSON.parse(text(respond('raw', raw, projections, { context: 't' })))).toEqual(raw);
    expect(text(respond('raw', raw, projections, { context: 't' }))).toContain('\n');
  });

  it('untrusted frames every rung, raw included', () => {
    for (const view of ['compact', 'full', 'raw']) {
      const body = JSON.parse(text(respond(view, raw, projections, { context: 't', untrusted: true })));
      expect(JSON.stringify(body)).toMatch(/untrusted/i);
    }
  });

  it('a projector that throws falls back to the raw value (with a stderr note)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = respond(
      'compact',
      raw,
      {
        compact: () => {
          throw new Error('shape changed');
        },
        full: (r) => r,
      },
      { context: 'Op' },
    );
    expect(JSON.parse(text(result))).toEqual(raw);
    err.mockRestore();
  });
});
