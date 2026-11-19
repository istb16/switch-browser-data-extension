import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_COLORS, MEMO_MAX, cleanDetails, byteSize, formatBytes, summarize, measureDomains, sizeOf, withBytes,
} from '../../lib/snapshot-summary.js';

const cookie = (name, extra = {}) => ({ name, value: 'v', domain: 'a.com', path: '/', ...extra });

describe('lib/snapshot-summary summarize', () => {
  it('returns counts without bytes', () => {
    const snapshot = {
      savedAt: '2026-01-01T00:00:00.000Z',
      cookies: [cookie('a'), cookie('b')],
      localStorage: { a: '1', b: '2', c: '3' },
      indexedDB: { db: { version: 1, stores: {} } },
    };
    const summary = summarize(snapshot, 0);
    expect([summary.cookies, summary.localStorage, summary.sessionStorage, summary.indexedDB]).toEqual([2, 3, null, 1]);
    expect(summary.expiredCookies).toBe(0);
    expect(summary).not.toHaveProperty('bytes');
  });

  it('returns 0 for a present empty type and null for an absent one', () => {
    const summary = summarize({ cookies: [], localStorage: {} }, 0);
    expect(summary.cookies).toBe(0);
    expect(summary.localStorage).toBe(0);
    expect(summary.indexedDB).toBeNull();
  });

  it('counts expired cookies and ignores session cookies', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const summary = summarize({
      cookies: [
        cookie('expired', { expirationDate: now / 1000 }),
        cookie('live', { expirationDate: (now + 1000) / 1000 }),
        cookie('session'),
      ],
    }, now);
    expect(summary.expiredCookies).toBe(1);
    expect(summarize({}, now).expiredCookies).toBe(0);
  });
});

describe('lib/snapshot-summary sizes', () => {
  it('byteSize measures UTF-8 bytes', () => {
    expect(byteSize('あ')).toBe(5);
    expect(byteSize({ a: 1 })).toBe(7);
  });

  it('formatBytes picks B/KB/MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('measureDomains returns per-domain and per-snapshot sizes', () => {
    const a1 = { savedAt: 'x', localStorage: { k: 'v' } };
    const a2 = { savedAt: 'y', cookies: [cookie('sid')] };
    const b1 = { savedAt: 'z' };
    const result = measureDomains({ 'a.com': { one: a1, two: a2 }, 'b.com': { one: b1 } });
    expect(result['a.com'].snapshots).toEqual({ one: byteSize(a1), two: byteSize(a2) });
    expect(result['a.com'].bytes).toBe(byteSize(a1) + byteSize(a2));
    expect(result['b.com']).toEqual({ bytes: byteSize(b1), snapshots: { one: byteSize(b1) } });
  });

  it('sizeOf prefers the recorded size', () => {
    const bare = { savedAt: 'x', localStorage: { k: 'v' } };
    expect(sizeOf(bare)).toBe(byteSize(bare));
    expect(sizeOf({ ...bare, bytes: 42 })).toBe(42);
    expect(sizeOf({ ...bare, bytes: 'x' })).toBe(byteSize(bare));
  });

  it('withBytes records the size of the snapshot without the field', () => {
    const bare = { savedAt: 'x', localStorage: { k: 'v' } };
    const recorded = withBytes({ ...bare, bytes: 1 });
    expect(recorded).toEqual({ ...bare, bytes: byteSize(bare) });
    expect(withBytes(bare)).toEqual(recorded);
    expect(bare).not.toHaveProperty('bytes');
  });

  it('measureDomains uses the recorded size when present', () => {
    const a1 = { savedAt: 'x', bytes: 10 };
    const a2 = { savedAt: 'y' };
    expect(measureDomains({ 'a.com': { one: a1, two: a2 } })['a.com'])
      .toEqual({ bytes: 10 + byteSize(a2), snapshots: { one: 10, two: byteSize(a2) } });
  });
});

describe('lib/snapshot-summary cleanDetails', () => {
  it('keeps a 100-character memo and cuts 101 to 100', () => {
    expect(MEMO_MAX).toBe(100);
    expect(cleanDetails({ memo: 'a'.repeat(100) }).memo).toHaveLength(100);
    expect(cleanDetails({ memo: 'b'.repeat(101) }).memo).toBe('b'.repeat(100));
  });

  it('turns a newline into a space and drops an empty or non-string memo', () => {
    expect(cleanDetails({ memo: 'admin\nuser' })).toEqual({ memo: 'admin user' });
    expect(cleanDetails({ memo: '  \n ' })).toEqual({});
    expect(cleanDetails({ memo: '' })).toEqual({});
    expect(cleanDetails({ memo: 123 })).toEqual({});
  });

  it('drops a colour outside SNAPSHOT_COLORS and keeps each listed one', () => {
    expect(cleanDetails({ color: 'pink' })).toEqual({});
    for (const color of SNAPSHOT_COLORS) expect(cleanDetails({ color })).toEqual({ color });
    expect(SNAPSHOT_COLORS).toEqual(['red', 'amber', 'green', 'blue']);
  });
});
