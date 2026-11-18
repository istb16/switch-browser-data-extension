import { describe, it, expect } from 'vitest';
import { hasChanges, summarizeIndexedDB } from '../../lib/data-compare.js';

const ALL = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };

describe('lib/data-compare', () => {
  it('reports no change when the data is the same, whatever the key order', () => {
    const snapshot = { localStorage: { a: '1', b: '2' } };
    const current  = { localStorage: { b: '2', a: '1' } };
    expect(hasChanges(snapshot, current, ALL)).toBe(false);
  });

  it('reports a change in a storage value', () => {
    expect(hasChanges({ localStorage: { a: '1' } }, { localStorage: { a: '2' } }, ALL)).toBe(true);
    expect(hasChanges({ sessionStorage: {} }, { sessionStorage: { a: '1' } }, ALL)).toBe(true);
  });

  it('compares which cookies exist, not their values, expiry or order', () => {
    const sid   = { name: 'sid', value: 'abc', domain: 'a.com', path: '/', expirationDate: 1 };
    const other = { name: '__cf_bm', value: 'x', domain: 'a.com', path: '/' };
    expect(hasChanges(
      { cookies: [sid, other] },
      { cookies: [{ ...other, value: 'rotated' }, { ...sid, value: 'new', expirationDate: 999 }] },
      ALL,
    )).toBe(false);
    expect(hasChanges({ cookies: [sid, other] }, { cookies: [other] }, ALL)).toBe(true);
    expect(hasChanges({ cookies: [other] }, { cookies: [other, sid] }, ALL)).toBe(true);
  });

  it('compares IndexedDB by record counts, against full data or a summary', () => {
    const full = { db: { version: 1, stores: { s: { keyPath: 'id', autoIncrement: false, records: [{ id: 1 }, { id: 2 }] } } } };
    expect(summarizeIndexedDB(full)).toEqual({ db: { version: 1, stores: { s: 2 } } });
    expect(hasChanges({ indexedDB: full }, { indexedDBSummary: { db: { version: 1, stores: { s: 2 } } } }, ALL)).toBe(false);
    expect(hasChanges({ indexedDB: full }, { indexedDBSummary: { db: { version: 1, stores: { s: 3 } } } }, ALL)).toBe(true);
    expect(hasChanges({ indexedDB: full }, { indexedDBSummary: {} }, ALL)).toBe(true);
  });

  it('skips types that are disabled or missing on either side', () => {
    expect(hasChanges({ localStorage: { a: '1' } }, { localStorage: { a: '2' } }, { ...ALL, localStorage: false })).toBe(false);
    expect(hasChanges({ cookies: [{ name: 'a' }] }, {}, ALL)).toBe(false);
    expect(hasChanges({}, { localStorage: { a: '1' } }, ALL)).toBe(false);
  });
});
