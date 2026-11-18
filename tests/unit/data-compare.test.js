import { describe, it, expect } from 'vitest';
import { hasChanges } from '../../lib/data-compare.js';

const ALL = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };

describe('lib/data-compare', () => {
  it('reports no change when the data is the same, whatever the key order', () => {
    const snapshot = { localStorage: { a: '1', b: '2' }, indexedDB: { db: { store: [{ id: 1, v: 'x' }] } } };
    const current  = { localStorage: { b: '2', a: '1' }, indexedDB: { db: { store: [{ v: 'x', id: 1 }] } } };
    expect(hasChanges(snapshot, current, ALL)).toBe(false);
  });

  it('reports a change in a storage value', () => {
    expect(hasChanges({ localStorage: { a: '1' } }, { localStorage: { a: '2' } }, ALL)).toBe(true);
    expect(hasChanges({ sessionStorage: {} }, { sessionStorage: { a: '1' } }, ALL)).toBe(true);
  });

  it('ignores cookie expiry and order, but not values', () => {
    const cookie = { name: 'sid', value: 'abc', domain: 'a.com', path: '/', expirationDate: 1 };
    const other  = { name: 'theme', value: 'dark', domain: 'a.com', path: '/' };
    expect(hasChanges(
      { cookies: [cookie, other] },
      { cookies: [other, { ...cookie, expirationDate: 999 }] },
      ALL,
    )).toBe(false);
    expect(hasChanges({ cookies: [cookie] }, { cookies: [{ ...cookie, value: 'new' }] }, ALL)).toBe(true);
  });

  it('skips types that are disabled or missing on either side', () => {
    expect(hasChanges({ localStorage: { a: '1' } }, { localStorage: { a: '2' } }, { ...ALL, localStorage: false })).toBe(false);
    expect(hasChanges({ cookies: [{ name: 'a' }] }, {}, ALL)).toBe(false);
    expect(hasChanges({}, { localStorage: { a: '1' } }, ALL)).toBe(false);
  });
});
