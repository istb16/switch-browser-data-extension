import { describe, it, expect } from 'vitest';
import { encryptText, MIN_ITERATIONS } from '../../lib/crypto.js';
import {
  IMPORT_MAX_BYTES, buildExport, parseImport, findConflicts, uniqueName, mergeImport, exportFileName,
} from '../../lib/transfer.js';

const SAVED_AT = '2026-01-01T00:00:00.000Z';
const snap = (extra = {}) => ({ savedAt: SAVED_AT, cookies: [], localStorage: {}, ...extra });
const parse = value => parseImport(JSON.stringify(value));

describe('lib/transfer parseImport', () => {
  it('accepts the legacy plain shape', () => {
    const file = { 'example.com': { A: snap({ cookies: [{ name: 'sid', value: '1' }], sessionStorage: { k: 'v' } }) } };
    expect(parse(file)).toEqual({ encrypted: false, data: file });
  });

  it('accepts an entry without memo, color, cookieDomain or indexedDBDigest', () => {
    const file = { 'example.com': { A: { savedAt: SAVED_AT } } };
    expect(parse(file).data).toEqual(file);
  });

  it('flags an encrypted envelope', async () => {
    const envelope = await encryptText('{}', 'passphrase', MIN_ITERATIONS);
    const result = parse(envelope);
    expect(result.encrypted).toBe(true);
    expect(result.envelope).toEqual(envelope);
  });

  it('rejects invalid JSON, other arrays, non-objects and non-object snapshots', () => {
    expect(() => parseImport('{')).toThrow('invalid');
    for (const value of [[], [1, 2], ['switch-browser-data-encrypted', {}], 'text', 1, null,
      { 'example.com': [] }, { 'example.com': 'x' }, { 'example.com': { A: null } }, { 'example.com': { A: [] } }]) {
      expect(() => parse(value)).toThrow('invalid');
    }
  });

  it('rejects __proto__, constructor and prototype as domain or name', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => parseImport(`{"${key}": {"A": ${JSON.stringify(snap())}}}`)).toThrow('invalid');
      expect(() => parseImport(`{"example.com": {"${key}": ${JSON.stringify(snap())}}}`)).toThrow('invalid');
    }
    expect(Object.prototype.A).toBeUndefined();
    expect({}.savedAt).toBeUndefined();
  });

  it('rejects cookies that are not an array of objects', () => {
    for (const cookies of ['sid=1', { sid: '1' }, [1]]) {
      expect(() => parse({ 'example.com': { A: snap({ cookies }) } })).toThrow('invalid');
    }
  });

  it('rejects a non-object localStorage, sessionStorage or indexedDB', () => {
    for (const type of ['localStorage', 'sessionStorage', 'indexedDB']) {
      for (const value of ['x', [], null]) {
        expect(() => parse({ 'example.com': { A: snap({ [type]: value }) } })).toThrow('invalid');
      }
    }
  });

  it('rejects a missing or unparseable savedAt', () => {
    expect(() => parse({ 'example.com': { A: { cookies: [] } } })).toThrow('invalid');
    expect(() => parse({ 'example.com': { A: snap({ savedAt: 'yesterday-ish' }) } })).toThrow('invalid');
    expect(() => parse({ 'example.com': { A: snap({ savedAt: 0 }) } })).toThrow('invalid');
  });

  it('cleans memo and color and drops a non-string cookieDomain', () => {
    const { data } = parse({ 'example.com': {
      A: snap({ memo: 123, color: 'pink', cookieDomain: 5 }),
      B: snap({ memo: 'x'.repeat(300), color: 'green', cookieDomain: 'example.com' }),
    } });
    expect(data['example.com'].A).toEqual(snap());
    expect(data['example.com'].B.memo).toBe('x'.repeat(100));
    expect(data['example.com'].B.color).toBe('green');
    expect(data['example.com'].B.cookieDomain).toBe('example.com');
  });

  it('of decrypted text that is itself an envelope throws invalid', async () => {
    const envelope = await encryptText('{}', 'passphrase', MIN_ITERATIONS);
    expect(() => parseImport(JSON.stringify(envelope), { decrypted: true })).toThrow('invalid');
  });

  it('IMPORT_MAX_BYTES is 256 MB', () => {
    expect(IMPORT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('lib/transfer buildExport', () => {
  const all = { 'a.com': { A: snap(), B: snap() }, 'b.com': { C: snap() } };

  it('scopes to all, one domain, one snapshot', () => {
    expect(buildExport(all)).toEqual(all);
    expect(buildExport(all, { domain: 'a.com' })).toEqual({ 'a.com': all['a.com'] });
    expect(buildExport(all, { domain: 'a.com', name: 'B' })).toEqual({ 'a.com': { B: all['a.com'].B } });
  });

  it('import keeps memo, color and cookieDomain', () => {
    const file = { 'a.com': { A: snap({ memo: 'note', color: 'red', cookieDomain: 'a.com' }) } };
    expect(parseImport(JSON.stringify(buildExport(file))).data).toEqual(file);
  });

  it('exportFileName names the scope', () => {
    expect(exportFileName({}, 1)).toBe('browser-data-snapshots-1.json');
    expect(exportFileName({ domain: 'a.com' }, 1)).toBe('browser-data-snapshots-a.com-1.json');
  });
});

describe('lib/transfer findConflicts / uniqueName', () => {
  it('lists same domain+name pairs only', () => {
    const existing = { 'a.com': { A: snap(), B: snap() }, 'b.com': { A: snap() } };
    const imported = { 'a.com': { A: snap(), C: snap(), toString: snap() }, 'c.com': { A: snap() } };
    expect(findConflicts(existing, imported)).toEqual([{ domain: 'a.com', name: 'A' }]);
  });

  it('uniqueName skips taken numbers', () => {
    expect(uniqueName('A', { A: 1 })).toBe('A (2)');
    expect(uniqueName('A', { A: 1, 'A (2)': 1 })).toBe('A (3)');
  });
});

describe('lib/transfer mergeImport', () => {
  const existing = () => ({ 'a.com': { A: snap({ memo: 'old' }), B: snap() } });
  const orders = () => ({ 'a.com': ['B', 'A'] });

  it('overwrite keeps the existing order position', () => {
    const result = mergeImport(existing(), orders(), { 'a.com': { A: snap({ memo: 'new' }) } }, 'overwrite');
    expect(result.snapshots['a.com'].A.memo).toBe('new');
    expect(result.orders['a.com']).toEqual(['B', 'A']);
  });

  it('into a new domain creates its order in file order', () => {
    const result = mergeImport(existing(), orders(), { 'b.com': { Z: snap(), Y: snap() } }, 'overwrite');
    expect(result.orders['b.com']).toEqual(['Z', 'Y']);
    expect(Object.keys(result.snapshots['b.com'])).toEqual(['Z', 'Y']);
  });

  it('skip leaves snapshots and order unchanged', () => {
    const result = mergeImport(existing(), orders(), { 'a.com': { A: snap({ memo: 'new' }) } }, 'skip');
    expect(result.snapshots).toEqual(existing());
    expect(result.orders).toEqual(orders());
  });

  it('keepBoth adds name (2), then (3) when (2) exists, appended to the order', () => {
    let result = mergeImport(existing(), orders(), { 'a.com': { A: snap({ memo: 'new' }) } }, 'keepBoth');
    expect(result.snapshots['a.com']['A (2)'].memo).toBe('new');
    expect(result.snapshots['a.com'].A.memo).toBe('old');
    expect(result.orders['a.com']).toEqual(['B', 'A', 'A (2)']);
    result = mergeImport(result.snapshots, result.orders, { 'a.com': { A: snap() } }, 'keepBoth');
    expect(result.orders['a.com']).toEqual(['B', 'A', 'A (2)', 'A (3)']);
  });

  it('reports counts', () => {
    const imported = { 'a.com': { A: snap(), C: snap() }, 'b.com': { D: snap() } };
    expect(mergeImport(existing(), orders(), imported, 'overwrite').counts)
      .toEqual({ added: 2, overwritten: 1, skipped: 0, renamed: 0 });
    expect(mergeImport(existing(), orders(), imported, 'skip').counts)
      .toEqual({ added: 2, overwritten: 0, skipped: 1, renamed: 0 });
    expect(mergeImport(existing(), orders(), imported, 'keepBoth').counts)
      .toEqual({ added: 2, overwritten: 0, skipped: 0, renamed: 1 });
  });

  it('keeps the file domain keys', () => {
    const result = mergeImport({ 'example.com': { A: snap() } }, {}, { 'app.example.com': { A: snap() } }, 'overwrite');
    expect(Object.keys(result.snapshots['app.example.com'])).toEqual(['A']);
    expect(Object.keys(result.snapshots['example.com'])).toEqual(['A']);
  });

  it('treats an inherited property name as new, not a conflict', () => {
    const result = mergeImport(existing(), orders(), { 'a.com': { toString: snap() } }, 'skip');
    expect(result.counts.added).toBe(1);
    expect(result.orders['a.com']).toEqual(['B', 'A', 'toString']);
  });

  it('starts an unordered existing domain from its sorted names', () => {
    const result = mergeImport(existing(), {}, { 'a.com': { C: snap() } }, 'overwrite');
    expect(result.orders['a.com']).toEqual(['A', 'B', 'C']);
  });

  it('places added names after existing names missing from an incomplete saved order', () => {
    const result = mergeImport(
      { 'a.com': { A: snap(), B: snap(), D: snap() } },
      { 'a.com': ['A', 'gone'] },
      { 'a.com': { C: snap() } },
      'overwrite',
    );
    expect(result.orders['a.com']).toEqual(['A', 'B', 'D', 'C']);
  });

  it('does not modify its inputs', () => {
    const ex = existing();
    const or = orders();
    mergeImport(ex, or, { 'a.com': { C: snap() } }, 'overwrite');
    expect(ex).toEqual(existing());
    expect(or).toEqual(orders());
  });
});
