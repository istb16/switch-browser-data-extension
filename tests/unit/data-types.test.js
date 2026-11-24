import { describe, it, expect } from 'vitest';
import { DATA_TYPES, PAGE_TYPES, TYPE_LABELS, isPlainObject } from '../../lib/data-types.js';

describe('lib/data-types', () => {
  it('DATA_TYPES, PAGE_TYPES and TYPE_LABELS agree', () => {
    expect(DATA_TYPES).toEqual(['cookies', 'localStorage', 'sessionStorage', 'indexedDB']);
    expect(PAGE_TYPES).toEqual(DATA_TYPES.filter(type => type !== 'cookies'));
    expect(Object.keys(TYPE_LABELS)).toEqual(DATA_TYPES);
    for (const type of DATA_TYPES) expect(TYPE_LABELS[type]).toEqual(expect.any(String));
  });

  it('isPlainObject rejects null, arrays and primitives', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], [1], 'x', 1, true]) expect(isPlainObject(value)).toBe(false);
  });
});
