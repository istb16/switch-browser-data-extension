import { describe, it, expect } from 'vitest';
import { findChanges, findVolatileCookies, withDigests, describeChanges, isCookieExpired } from '../../lib/data-compare.js';

const ALL = { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true };
const cookie = (name, value, extra = {}) => ({ name, value, domain: 'a.com', path: '/', ...extra });
const idb = records => ({ db: { version: 1, stores: { s: { keyPath: 'id', autoIncrement: false, records } } } });

describe('lib/data-compare findChanges', () => {
  it('reports nothing when the data is the same, whatever the key order', () => {
    expect(findChanges({ localStorage: { a: '1', b: '2' } }, { localStorage: { b: '2', a: '1' } }, ALL)).toEqual([]);
  });

  it('names each storage type that changed', () => {
    expect(findChanges(
      { localStorage: { a: '1' }, sessionStorage: {} },
      { localStorage: { a: '2' }, sessionStorage: { x: '1' } },
      ALL,
    )).toEqual([{ type: 'localStorage' }, { type: 'sessionStorage' }]);
  });

  it('compares cookie values, ignoring expiry and order', () => {
    const sid = cookie('sid', 'abc', { expirationDate: 1 });
    expect(findChanges({ cookies: [sid, cookie('t', '1')] }, { cookies: [cookie('t', '1'), { ...sid, expirationDate: 9 }] }, ALL)).toEqual([]);
    expect(findChanges({ cookies: [sid] }, { cookies: [{ ...sid, value: 'other-account' }] }, ALL, {}, 0))
      .toEqual([{ type: 'cookies', key: 'a.com|/|sid', name: 'sid', kind: 'value' }]);
    expect(findChanges({ cookies: [sid] }, { cookies: [] }, ALL, {}, 0))
      .toEqual([{ type: 'cookies', key: 'a.com|/|sid', name: 'sid', kind: 'presence' }]);
  });

  it('ignores a saved cookie that has expired since, whether it was reissued or dropped', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const short = cookie('__cf_bm', 'old', { expirationDate: now / 1000 - 60 });
    const session = cookie('sid', 'a');
    expect(findChanges({ cookies: [short, session] }, { cookies: [{ ...short, value: 'new', expirationDate: now / 1000 + 1800 }, session] }, ALL, {}, now)).toEqual([]);
    expect(findChanges({ cookies: [short, session] }, { cookies: [session] }, ALL, {}, now)).toEqual([]);
    const live = { ...short, expirationDate: now / 1000 + 60 };
    expect(findChanges({ cookies: [live] }, { cookies: [{ ...live, value: 'new' }] }, ALL, {}, now)).toHaveLength(1);
  });

  it('compares only the presence of cookies learned to change by themselves, and skips ones learned to come and go', () => {
    const volatile = { 'a.com|/|csrf': 'value', 'a.com|/|__cf_bm': 'any' };
    expect(findChanges(
      { cookies: [cookie('csrf', '1'), cookie('__cf_bm', 'x')] },
      { cookies: [cookie('csrf', '2')] },
      ALL, volatile,
    )).toEqual([]);
    expect(findChanges({ cookies: [cookie('csrf', '1')] }, { cookies: [] }, ALL, volatile))
      .toEqual([{ type: 'cookies', key: 'a.com|/|csrf', name: 'csrf', kind: 'presence' }]);
  });

  it('compares IndexedDB by content, using stored digests when present', () => {
    const saved = withDigests({ indexedDB: idb([{ id: 1, v: 'a' }]) });
    expect(saved.indexedDBDigest).toMatch(/^[0-9a-f]{14}$/);
    expect(findChanges(saved, { indexedDBDigest: storageDigest.digest(idb([{ v: 'a', id: 1 }])) }, ALL)).toEqual([]);
    expect(findChanges(saved, { indexedDBDigest: storageDigest.digest(idb([{ id: 1, v: 'b' }])) }, ALL)).toEqual([{ type: 'indexedDB' }]);
    expect(findChanges({ indexedDB: idb([{ id: 1 }]) }, { indexedDB: idb([{ id: 2 }]) }, ALL)).toEqual([{ type: 'indexedDB' }]);
  });

  it('skips types that are disabled or missing on either side', () => {
    expect(findChanges({ localStorage: { a: '1' } }, { localStorage: { a: '2' } }, { ...ALL, localStorage: false })).toEqual([]);
    expect(findChanges({ cookies: [cookie('a', '1')] }, {}, ALL)).toEqual([]);
    expect(findChanges({}, { localStorage: { a: '1' }, indexedDBDigest: 'x' }, ALL)).toEqual([]);
  });
});

describe('lib/data-compare isCookieExpired', () => {
  it('is true at the expiry instant', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(isCookieExpired(cookie('a', '1', { expirationDate: now / 1000 }), now)).toBe(true);
    expect(isCookieExpired(cookie('a', '1', { expirationDate: (now + 1000) / 1000 }), now)).toBe(false);
    expect(isCookieExpired(cookie('a', '1'), now)).toBe(false);
  });
});

describe('lib/data-compare describeChanges', () => {
  it('groups changed cookies into one label, then the other types', () => {
    expect(describeChanges([
      { type: 'cookies', key: 'k1', name: 'sid', kind: 'value' },
      { type: 'indexedDB' },
      { type: 'cookies', key: 'k2', name: 'csrf', kind: 'presence' },
    ])).toEqual(['Cookie: sid, csrf', 'IndexedDB']);
  });
});

describe('lib/data-compare findVolatileCookies', () => {
  it('marks rewritten cookies "value" and cookies that came or went "any"', () => {
    expect(findVolatileCookies(
      [cookie('sid', 's'), cookie('csrf', '1'), cookie('gone', 'x')],
      [cookie('sid', 's'), cookie('csrf', '2'), cookie('new', 'y')],
    )).toEqual({ 'a.com|/|csrf': 'value', 'a.com|/|gone': 'any', 'a.com|/|new': 'any' });
  });
});

describe('lib/storage-digest', () => {
  it('gives the same digest for the same data in any key order, and a different one otherwise', () => {
    expect(storageDigest.digest({ a: 1, b: [1, { c: 'x' }] })).toBe(storageDigest.digest({ b: [1, { c: 'x' }], a: 1 }));
    expect(storageDigest.digest({ a: 1 })).not.toBe(storageDigest.digest({ a: 2 }));
    expect(storageDigest.digest(['ab'])).not.toBe(storageDigest.digest(['a', 'b']));
    expect(storageDigest.digest({ a: null })).not.toBe(storageDigest.digest({}));
  });
});
