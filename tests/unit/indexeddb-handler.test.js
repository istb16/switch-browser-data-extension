import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadGlobalScript } from '../support/load-script.js';

describe('lib/indexeddb-handler (non-module content script)', () => {
  let indexedDBHandler;
  let indexedDB;

  beforeEach(() => {
    // A fresh IDBFactory per test avoids databases leaking across tests.
    indexedDB = new IDBFactory();
    ({ indexedDBHandler } = loadGlobalScript('lib/indexeddb-handler.js', { indexedDB }, ['indexedDBHandler']));
  });

  async function createDb(name, version, storeName, keyPath, records) {
    const req = indexedDB.open(name, version);
    await new Promise((resolve, reject) => {
      req.onupgradeneeded = e => {
        const db = e.target.result;
        db.createObjectStore(storeName, keyPath ? { keyPath } : { autoIncrement: true });
      };
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    const db = req.result;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const record of records) store.add(record);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  it('readAll() returns {} when there are no databases', async () => {
    expect(await indexedDBHandler.readAll()).toEqual({});
  });

  it('readAll() serializes every database, store, schema and record', async () => {
    await createDb('mydb', 1, 'items', 'id', [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

    const snapshot = await indexedDBHandler.readAll();

    expect(snapshot.mydb.version).toBe(1);
    expect(snapshot.mydb.stores.items.keyPath).toBe('id');
    expect(snapshot.mydb.stores.items.autoIncrement).toBe(false);
    expect(snapshot.mydb.stores.items.records).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  });

  it('clearAll() deletes every database', async () => {
    await createDb('one', 1, 'items', 'id', [{ id: 1 }]);
    await createDb('two', 1, 'items', 'id', [{ id: 2 }]);

    await indexedDBHandler.clearAll();

    expect(await indexedDBHandler.readAll()).toEqual({});
  });

  // A connection that, like many apps, ignores "versionchange" and stays open.
  function holdOpen(name, version) {
    return new Promise(resolve => {
      const req = indexedDB.open(name, version);
      req.onsuccess = () => resolve(req.result);
    });
  }

  it('clearAll() names a database the page keeps open instead of waiting on it', async () => {
    indexedDBHandler.blockedWaitMs = 20;
    await createDb('open', 1, 'items', 'id', [{ id: 1 }]);
    await createDb('free', 1, 'items', 'id', [{ id: 2 }]);
    const held = await holdOpen('open', 1);

    expect(await indexedDBHandler.clearAll()).toEqual(['open']);
    held.close();
  });

  it('writeAll() refills the stores in place when the schema is the same, even with the page holding the database open', async () => {
    indexedDBHandler.blockedWaitMs = 20;
    await createDb('mydb', 1, 'items', 'id', [{ id: 1, name: 'stale' }, { id: 2, name: 'gone' }]);
    const held = await holdOpen('mydb', 1);

    await indexedDBHandler.writeAll({
      mydb: { version: 1, stores: { items: { keyPath: 'id', autoIncrement: false, records: [{ id: 1, name: 'fresh' }] } } },
    });

    const snapshot = await indexedDBHandler.readAll();
    expect(snapshot.mydb.stores.items.records).toEqual([{ id: 1, name: 'fresh' }]);
    held.close();
  });

  it('writeAll() fails, instead of hanging, when the schema changed and the page keeps the database open', async () => {
    indexedDBHandler.blockedWaitMs = 20;
    await createDb('mydb', 1, 'items', 'id', [{ id: 1 }]);
    const held = await holdOpen('mydb', 1);

    await expect(indexedDBHandler.writeAll({
      mydb: { version: 2, stores: { items: { keyPath: 'id', autoIncrement: false, records: [] } } },
    })).rejects.toThrow('in use');
    held.close();
  });

  it('writeAll() recreates a database from a snapshot, replacing any existing one', async () => {
    await createDb('mydb', 1, 'items', 'id', [{ id: 1, name: 'stale' }]);

    await indexedDBHandler.writeAll({
      mydb: {
        version: 2,
        stores: {
          items: { keyPath: 'id', autoIncrement: false, records: [{ id: 9, name: 'fresh' }] },
        },
      },
    });

    const snapshot = await indexedDBHandler.readAll();
    expect(snapshot.mydb.version).toBe(2);
    expect(snapshot.mydb.stores.items.records).toEqual([{ id: 9, name: 'fresh' }]);
  });

  it('writeAll() restores an autoIncrement store without a keyPath', async () => {
    await indexedDBHandler.writeAll({
      mydb: {
        version: 1,
        stores: {
          logs: { keyPath: undefined, autoIncrement: true, records: [{ msg: 'hello' }] },
        },
      },
    });

    const snapshot = await indexedDBHandler.readAll();
    expect(snapshot.mydb.stores.logs.autoIncrement).toBe(true);
    expect(snapshot.mydb.stores.logs.records).toEqual([{ msg: 'hello' }]);
  });
});
