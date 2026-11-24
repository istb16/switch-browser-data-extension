import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadGlobalScript } from '../support/load-script.js';
import { rowsOf, recordKey, previewOf, diffSnapshots, narrowerScope } from '../../lib/snapshot-diff.js';
import { parseImport } from '../../lib/transfer.js';
import { cookieDomainFor } from '../../lib/data-bridge.js';
import { resolveScope } from '../../lib/groups.js';

const HOST = 'example.com';
const EXACT = { domain: HOST, exact: true };

function cookie(name, value, extra = {}) {
  return { name, value, domain: HOST, path: '/', secure: false, httpOnly: false, sameSite: 'lax', ...extra };
}

function statuses(result) {
  return Object.fromEntries(result.rows.map(row => [row.key, row.status]));
}

function diff(base, other, scopes = { loadScope: EXACT, compareScope: EXACT }) {
  return diffSnapshots(base, other, scopes);
}

describe('lib/snapshot-diff rows', () => {
  it('rowsOf lists each type and null for absent types', () => {
    const rows = rowsOf({ cookies: [], localStorage: {}, savedAt: '2024-01-01T00:00:00Z' });
    expect(rows).toEqual({ cookies: [], localStorage: [], sessionStorage: null, indexedDB: null });

    const full = rowsOf({
      cookies: [cookie('sid', 'a')],
      sessionStorage: { k: 'v' },
      indexedDB: { db: { version: 2, stores: { items: { keyPath: 'id', autoIncrement: false, records: [{ id: 1 }] } } } },
    });
    expect(full.cookies[0]).toMatchObject({ key: 'example.com|/|sid', value: 'a' });
    expect(full.sessionStorage).toEqual([{ key: 'k', value: 'v' }]);
    expect(full.indexedDB).toEqual([{
      name: 'db', version: 2,
      stores: [{ name: 'items', keyPath: 'id', autoIncrement: false, records: [{ key: '1', value: '{"id":1}', maskKey: false }] }],
    }]);
  });

  it('rowsOf tolerates malformed data', () => {
    const rows = rowsOf({
      cookies: [null, 'x', 3, cookie('ok', 'v')],
      localStorage: { n: 1, o: { a: 1 }, u: null },
      sessionStorage: 'nope',
      indexedDB: { noStores: { version: 1 }, badRecords: { stores: { s: { keyPath: 'id', records: 'x' } } }, nul: null },
    });
    expect(rows.cookies.map(row => row.key)).toEqual(['example.com|/|ok']);
    expect(rows.localStorage).toEqual([{ key: 'n', value: '1' }, { key: 'o', value: '{"a":1}' }, { key: 'u', value: 'null' }]);
    expect(rows.sessionStorage).toBeNull();
    expect(rows.indexedDB.map(db => db.stores.length)).toEqual([0, 1, 0]);
    expect(rows.indexedDB[1].stores[0].records).toEqual([]);
    expect(() => rowsOf(null)).not.toThrow();
    expect(() => diff({ cookies: [null, cookie('a', 'b')], indexedDB: { d: 'x' } }, { cookies: 'x', indexedDB: [] })).not.toThrow();
  });

  it('recordKey reads dotted and array keyPaths and returns null when the key is missing', () => {
    expect(recordKey({ a: { b: 'x' } }, 'a.b')).toBe('"x"');
    expect(recordKey({ a: 1, b: 2 }, ['a', 'b'])).toBe('[1,2]');
    expect(recordKey({ a: 1 }, ['a', 'b'])).toBeNull();
    expect(recordKey({ a: 1 }, null)).toBeNull();
    expect(recordKey({}, 'constructor')).toBeNull();
    expect(recordKey('v', '')).toBe('"v"');
  });

  it('a malformed keyPath from an importable file is treated as keyless', () => {
    const snapshot = {
      savedAt: '2024-01-01T00:00:00Z',
      indexedDB: {
        d: {
          version: 1,
          stores: {
            num: { keyPath: [1], records: [{}] },
            mixed: { keyPath: ['a', 2], records: [{ a: 1 }] },
            empty: { keyPath: [], records: [{ a: 1 }] },
            obj: { keyPath: { a: 1 }, records: [{ a: 1 }] },
            n: { keyPath: 5, records: [{ 5: 1 }] },
          },
        },
      },
    };
    const imported = parseImport(JSON.stringify({ [HOST]: { bad: snapshot } })).data[HOST].bad;
    expect(() => rowsOf(imported)).not.toThrow();
    const stores = rowsOf(imported).indexedDB[0].stores;
    expect(stores.flatMap(store => store.records.map(record => record.key))).toEqual([null, null, null, null, null]);
    for (const keyPath of [[1], ['a', 2], [], { a: 1 }, 5]) expect(recordKey({ a: 1 }, keyPath)).toBeNull();

    const changed = structuredClone(imported);
    changed.indexedDB.d.stores.num.records = [{ x: 1 }];
    const [num] = diff(imported, changed).indexedDB.databases[0].stores;
    expect(num.rows.map(row => row.status)).toEqual(['removed', 'added']);
  });

  it('records keyed by the whole record are flagged to mask their key', () => {
    const rows = rowsOf({
      indexedDB: {
        d: {
          stores: {
            whole: { keyPath: '', records: ['token-a'] },
            part: { keyPath: ['id', ''], records: [{ id: 1 }] },
            plain: { keyPath: 'id', records: [{ id: 1 }] },
            none: { records: ['x'] },
          },
        },
      },
    });
    expect(rows.indexedDB[0].stores.map(store => store.records[0].maskKey)).toEqual([true, true, false, false]);
  });

  it('previewOf truncates text past the limit', () => {
    expect(previewOf('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(previewOf('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('lib/snapshot-diff web storage and types', () => {
  it('diff marks added, removed, changed and same web-storage keys', () => {
    const result = diff(
      { localStorage: { same: '1', changed: 'old', removed: 'x' } },
      { localStorage: { same: '1', changed: 'new', added: 'y' } },
    );
    expect(statuses(result.localStorage)).toEqual({ same: 'same', changed: 'changed', removed: 'removed', added: 'added' });
    const changed = result.localStorage.rows.find(row => row.key === 'changed');
    expect(changed.base.value).toBe('old');
    expect(changed.other.value).toBe('new');
    expect(result.localStorage.counts).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('keys named __proto__ and constructor diff like any other', () => {
    const storage = JSON.parse('{"__proto__":"a","constructor":"b"}');
    const other = JSON.parse('{"__proto__":"z","constructor":"b"}');
    const db = keyPathValue => ({ d: { version: 1, stores: { s: { keyPath: 'id', records: [{ id: '__proto__', v: keyPathValue }] } } } });
    const result = diff(
      { localStorage: storage, cookies: [cookie('__proto__', '1')], indexedDB: db(1) },
      { localStorage: other, cookies: [cookie('__proto__', '2')], indexedDB: db(2) },
    );
    expect(result.localStorage.rows.map(row => [row.key, row.status])).toEqual([['__proto__', 'changed'], ['constructor', 'same']]);
    expect(result.cookies.rows.map(row => row.status)).toEqual(['changed']);
    expect(result.indexedDB.databases[0].stores[0].rows.map(row => [row.key, row.status])).toEqual([['"__proto__"', 'changed']]);
  });

  it('a type missing on one side is not comparable', () => {
    const result = diff({ localStorage: { a: '1' }, cookies: [cookie('a', '1')] }, { sessionStorage: { a: '1' } });
    expect(result.localStorage).toBeNull();
    expect(result.cookies).toBeNull();
    expect(result.sessionStorage).toBeNull();
    expect(result.indexedDB).toBeNull();
  });

  it('an empty type on the other side is all removed', () => {
    const result = diff(
      { localStorage: { a: '1', b: '2' }, cookies: [cookie('sid', '1')], indexedDB: { d: { version: 1, stores: {} } } },
      { localStorage: {}, cookies: [], indexedDB: {} },
    );
    expect(result.localStorage.rows.map(row => row.status)).toEqual(['removed', 'removed']);
    expect(result.cookies.rows.map(row => row.status)).toEqual(['removed']);
    expect(result.indexedDB.databases[0]).toMatchObject({ name: 'd', other: null });
  });

  it('without other the rows have no status', () => {
    const result = diffSnapshots({ localStorage: { a: '1' }, indexedDB: { d: { stores: { s: { records: [1] } } } } }, null, { loadScope: EXACT });
    expect(result.localStorage).toEqual({ rows: [{ key: 'a', status: null, base: { key: 'a', value: '1' }, other: null }], counts: null });
    expect(result.indexedDB.databases[0].stores[0].rows[0].status).toBeNull();
    expect(result.cookies).toBeNull();
  });
});

describe('lib/snapshot-diff cookies', () => {
  it('cookie diff keys by domain|path|name and ignores expirationDate', () => {
    const base = [
      cookie('a', '1', { expirationDate: 1 }),
      cookie('b', '1'),
      cookie('c', '1'),
      cookie('d', '1'),
      cookie('e', '1'),
      cookie('a', '1', { path: '/x' }),
    ];
    const other = [
      cookie('a', '1', { expirationDate: 999 }),
      cookie('b', '2'),
      cookie('c', '1', { secure: true }),
      cookie('d', '1', { httpOnly: true }),
      cookie('e', '1', { sameSite: 'strict' }),
      cookie('a', '1', { path: '/y' }),
    ];
    expect(statuses(diff({ cookies: base }, { cookies: other }).cookies)).toEqual({
      'example.com|/|a': 'same',
      'example.com|/|b': 'changed',
      'example.com|/|c': 'changed',
      'example.com|/|d': 'changed',
      'example.com|/|e': 'changed',
      'example.com|/x|a': 'removed',
      'example.com|/y|a': 'added',
    });
  });

  it('a cookie domain in another case is out of scope and not loaded alike', () => {
    const upper = cookie('u', '1', { domain: 'Example.com' });
    const result = diff({ cookies: [cookie('a', '1'), upper] }, { cookies: [cookie('a', '1')] });
    const row = result.cookies.rows.find(r => r.base?.cookie === upper);
    expect(row.status).toBe('notCompared');
    expect(row.notLoaded).toBe(true);
    expect(result.cookies.skipped).toEqual({ base: 1, other: 0 });
  });

  it('a cookie outside its own load scope is notLoaded', () => {
    const snapshot = { cookies: [cookie('own', '1'), cookie('sub', '1', { domain: `sub.${HOST}` }), { name: 'bad', domain: HOST }] };
    const alone = diffSnapshots(snapshot, null, { loadScope: EXACT });
    expect(alone.cookies.rows.map(row => row.notLoaded)).toEqual([false, true, true]);
    const compared = diff(snapshot, { cookies: [] }, { loadScope: EXACT, compareScope: { domain: HOST, exact: false } });
    expect(compared.cookies.rows.map(row => row.notLoaded)).toEqual([false, true, true]);
  });

  it('a cookie outside the compare scope is notCompared, not removed', () => {
    const group = { domain: HOST, exact: false };
    const groupSaved = {
      cookieDomain: HOST,
      cookies: [cookie('own', '1'), cookie('sib', '1', { domain: `other.${HOST}` }), cookie('dot', '1', { domain: `.${HOST}` })],
    };
    const hostOnly = { cookies: [cookie('own', '2'), cookie('dot', '1', { domain: `.${HOST}` })] };
    const compareScope = narrowerScope(group, EXACT);
    expect(compareScope).toBe(EXACT);
    const result = diff(groupSaved, hostOnly, { loadScope: group, compareScope });
    expect(result.cookies.rows.map(row => [row.key, row.status, row.notLoaded])).toEqual([
      ['example.com|/|own', 'changed', false],
      ['other.example.com|/|sib', 'notCompared', false],
      ['.example.com|/|dot', 'same', false],
    ]);
    expect(result.cookies.counts).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  it("the other side's cookies outside the compare scope give no rows and are counted", () => {
    const result = diff(
      { cookies: [cookie('own', '1'), cookie('sib', '1', { domain: `a.${HOST}` })] },
      { cookies: [cookie('own', '1'), cookie('x', '1', { domain: `b.${HOST}` }), cookie('y', '1', { domain: `c.${HOST}` })] },
    );
    expect(result.cookies.rows.map(row => row.status)).toEqual(['same', 'notCompared']);
    expect(result.cookies.skipped).toEqual({ base: 1, other: 2 });
  });

  it('a cookie repeated in one snapshot gives one row', () => {
    const result = diff(
      { cookies: [cookie('sid', '1'), cookie('sid', '2'), cookie('x', '1')] },
      { cookies: [cookie('sid', '2'), cookie('x', '1')] },
    );
    expect(result.cookies.rows.map(row => [row.key, row.status])).toEqual([
      ['example.com|/|sid', 'same'],
      ['example.com|/|x', 'same'],
    ]);
  });

  it('a malformed cookie inside the compare scope is compared, not out of scope', () => {
    const malformed = { name: 'bad', domain: HOST, path: '/', value: 7 };
    const result = diff({ cookies: [malformed, cookie('ok', '1')] }, { cookies: [cookie('ok', '1')] });
    expect(result.cookies.rows.map(row => [row.key, row.status, row.notLoaded])).toEqual([
      ['example.com|/|bad', 'removed', true],
      ['example.com|/|ok', 'same', false],
    ]);
    expect(result.cookies.skipped).toEqual({ base: 0, other: 0 });

    const noDomain = diff({ cookies: [{ name: 'n', value: 'v', path: '/' }] }, { cookies: [] });
    expect(noDomain.cookies.rows.map(row => row.status)).toEqual(['notCompared']);
    expect(noDomain.cookies.skipped).toEqual({ base: 1, other: 0 });
  });

  it('narrowerScope returns the inner scope', () => {
    const wide = { domain: HOST, exact: false };
    const sub = { domain: `app.${HOST}`, exact: false };
    const exactSub = { domain: `app.${HOST}`, exact: true };
    expect(narrowerScope(wide, sub)).toBe(sub);
    expect(narrowerScope(sub, wide)).toBe(sub);
    expect(narrowerScope(exactSub, wide)).toBe(exactSub);
    expect(narrowerScope(wide, exactSub)).toBe(exactSub);
    expect(narrowerScope(EXACT, { ...EXACT })).toBe(EXACT);
    expect(narrowerScope(wide, { ...wide })).toBe(wide);
  });

  it('narrowerScope returns null when neither contains the other', () => {
    expect(narrowerScope(EXACT, { domain: 'example.org', exact: true })).toBeNull();
    expect(narrowerScope({ domain: 'a.com', exact: false }, { domain: 'b.com', exact: false })).toBeNull();
    expect(narrowerScope({ domain: 'example.org', exact: true }, { domain: HOST, exact: false })).toBeNull();
  });

  it('narrowerScope picks the scope cookieDomainFor narrows to', () => {
    const app = resolveScope(`app.${HOST}`, [HOST]);
    const groupScope = cookieDomainFor({ cookieDomain: HOST }, `app.${HOST}`, app);
    const hostScope = cookieDomainFor({}, `app.${HOST}`, app);
    expect(groupScope).toEqual({ domain: HOST, exact: false });
    expect(hostScope).toEqual({ domain: `app.${HOST}`, exact: true });
    expect(narrowerScope(hostScope, groupScope)).toBe(hostScope);
    expect(narrowerScope(groupScope, hostScope)).toBe(hostScope);
  });

  it('a cookie with a non-string domain is notCompared and notLoaded, and does not throw', () => {
    const odd = { name: 'odd', value: '1', domain: 5, path: '/' };
    const missing = { name: 'none', value: '1', path: '/' };
    const result = diff({ cookies: [cookie('a', '1'), odd, missing] }, { cookies: [cookie('a', '1'), { ...odd }] });
    const rowOf = c => result.cookies.rows.find(row => row.base?.cookie === c);
    for (const c of [odd, missing]) {
      expect(rowOf(c).status).toBe('notCompared');
      expect(rowOf(c).notLoaded).toBe(true);
    }
    expect(result.cookies.skipped).toEqual({ base: 2, other: 1 });
  });

  it('cookies are not comparable when the compare scope is null', () => {
    const result = diff(
      { cookies: [cookie('a', '1')], localStorage: { k: '1' } },
      { cookies: [cookie('a', '2')], localStorage: { k: '2' } },
      { loadScope: EXACT, compareScope: null },
    );
    expect(result.cookies).toBeNull();
    expect(statuses(result.localStorage)).toEqual({ k: 'changed' });
  });
});

describe('lib/snapshot-diff IndexedDB', () => {
  const store = (keyPath, records, extra = {}) => ({ keyPath, autoIncrement: false, records, ...extra });
  const dbOf = (stores, version = 1) => ({ indexedDB: { d: { version, stores } } });
  const storeDiff = (base, other) => diff(base, other).indexedDB.databases[0].stores;

  it('IndexedDB diff keys records by keyPath', () => {
    const [plain, dotted, array] = storeDiff(
      dbOf({
        plain: store('id', [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]),
        dotted: store('m.id', [{ m: { id: 'x' }, v: 1 }]),
        array: store(['a', 'b'], [{ a: 1, b: 2, v: 1 }, { a: 1, b: 3, v: 1 }]),
      }),
      dbOf({
        plain: store('id', [{ id: 2, v: 'b' }, { id: 1, v: 'z' }, { id: 3, v: 'c' }]),
        dotted: store('m.id', [{ m: { id: 'x' }, v: 2 }]),
        array: store(['a', 'b'], [{ a: 1, b: 2, v: 1 }]),
      }),
    );
    expect(statuses(plain)).toEqual({ 1: 'changed', 2: 'same', 3: 'added' });
    expect(statuses(dotted)).toEqual({ '"x"': 'changed' });
    expect(statuses(array)).toEqual({ '[1,2]': 'same', '[1,3]': 'removed' });
    expect(plain.counts).toEqual({ added: 1, removed: 0, changed: 1 });
  });

  it('IndexedDB diff of keyless stores is a multiset', () => {
    const [keyless] = storeDiff(
      dbOf({ s: store(null, ['a', 'a', 'b'], { autoIncrement: true }) }),
      dbOf({ s: store(null, ['a', 'c', 'c'], { autoIncrement: true }) }),
    );
    expect(keyless.rows.map(row => row.status)).toEqual(['same', 'removed', 'removed', 'added', 'added']);
    expect(keyless.counts).toEqual({ added: 2, removed: 2, changed: 0 });
  });

  it('keyless records in a keyed store are only added or removed', () => {
    const [mixed] = storeDiff(
      dbOf({ s: store('id', [{ id: 1, v: 'a' }, { v: 'loose' }, { v: 'gone' }]) }),
      dbOf({ s: store('id', [{ id: 1, v: 'b' }, { v: 'loose' }, { v: 'new' }]) }),
    );
    expect(mixed.rows.map(row => [row.key, row.status])).toEqual([
      ['1', 'changed'],
      [null, 'same'],
      [null, 'removed'],
      [null, 'added'],
    ]);
    expect(mixed.counts).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('a keyPath that differs between the sides falls back to content matching', () => {
    const [s] = storeDiff(
      dbOf({ s: store('id', [{ id: 1, key: 9, v: 'a' }, { id: 2, key: 8, v: 'same' }]) }),
      dbOf({ s: store('key', [{ id: 1, key: 9, v: 'b' }, { id: 2, key: 8, v: 'same' }]) }),
    );
    expect(s.schemaChanged).toBe(true);
    expect(s.rows.map(row => row.status)).toEqual(['removed', 'same', 'added']);
    expect(s.counts).toEqual({ added: 1, removed: 1, changed: 0 });
  });

  it('a store or database only on the other side is all added', () => {
    const result = diff(
      { indexedDB: { d: { version: 1, stores: { s: store('id', [{ id: 1 }]) } } } },
      {
        indexedDB: {
          d: { version: 1, stores: { s: store('id', [{ id: 1 }]), fresh: store('id', [{ id: 1 }, { id: 2 }]), empty: store('id', []) } },
          newDb: { version: 3, stores: { t: store(null, ['x']) } },
        },
      },
    );
    const [d, newDb] = result.indexedDB.databases;
    const [, fresh, empty] = d.stores;
    expect(fresh).toMatchObject({ name: 'fresh', base: null, schemaChanged: false, counts: { added: 2, removed: 0, changed: 0 } });
    expect(fresh.rows.every(row => row.status === 'added' && row.base === null)).toBe(true);
    expect(empty).toMatchObject({ name: 'empty', base: null, rows: [] });
    expect(newDb).toMatchObject({ name: 'newDb', base: null, versionChanged: false, counts: { added: 1, removed: 0, changed: 0 } });
    expect(newDb.stores[0]).toMatchObject({ base: null, rows: [{ status: 'added', base: null }] });
    expect(result.indexedDB.counts).toEqual({ added: 3, removed: 0, changed: 0 });
  });

  it('store schema differences are flagged', () => {
    const result = diff(
      dbOf({ a: store('id', []), b: store('id', []), c: store('id', []) }, 1),
      dbOf({ a: store('key', []), b: store('id', [], { autoIncrement: true }), c: store('id', []) }, 2),
    );
    const [db] = result.indexedDB.databases;
    expect(db.versionChanged).toBe(true);
    expect(db.stores.map(s => s.schemaChanged)).toEqual([true, true, false]);
  });

  it('diffs what the real indexedDBHandler.readAll returns', async () => {
    async function readAllOf(records) {
      const indexedDB = new IDBFactory();
      const req = indexedDB.open('app', 1);
      await new Promise((resolve, reject) => {
        req.onupgradeneeded = e => {
          const db = e.target.result;
          db.createObjectStore('users', { keyPath: 'id' });
          db.createObjectStore('pairs', { keyPath: ['a', 'b'] });
          db.createObjectStore('log', { autoIncrement: true });
        };
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      const db = req.result;
      const tx = db.transaction(['users', 'pairs', 'log'], 'readwrite');
      for (const [name, list] of Object.entries(records)) for (const record of list) tx.objectStore(name).add(record);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      const { indexedDBHandler } = loadGlobalScript('lib/indexeddb-handler.js', { indexedDB }, ['indexedDBHandler']);
      return JSON.parse(JSON.stringify({ indexedDB: await indexedDBHandler.readAll() }));
    }

    const before = await readAllOf({
      users: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      pairs: [{ a: 1, b: 1, v: 'x' }],
      log: [{ msg: 'one' }, { msg: 'two' }],
    });
    const after = await readAllOf({
      users: [{ id: 1, name: 'a' }, { id: 2, name: 'B' }],
      pairs: [{ a: 1, b: 1, v: 'y' }],
      log: [{ msg: 'one' }, { msg: 'TWO' }],
    });
    const stores = Object.fromEntries(diff(before, after).indexedDB.databases[0].stores.map(s => [s.name, s]));
    expect(statuses(stores.users)).toEqual({ 1: 'same', 2: 'changed' });
    expect(statuses(stores.pairs)).toEqual({ '[1,1]': 'changed' });
    expect(stores.log.rows.map(row => row.status)).toEqual(['same', 'removed', 'added']);
    expect(Object.values(stores).map(s => s.schemaChanged)).toEqual([false, false, false]);
  });
});
