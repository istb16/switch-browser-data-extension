// content script — no ES module syntax
// Exposes indexedDBHandler global to content-script.js

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

var indexedDBHandler = {
  // How long a deletion the page's open connection blocks may still go through
  // (pages that close their connection on "versionchange" do so right away).
  blockedWaitMs: 3000,

  async readAll() {
    const databases = await indexedDB.databases();
    const result = {};
    for (const { name } of databases) {
      result[name] = await this._readDB(name);
    }
    return result;
  },

  _readDB(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => reject(req.error);
      req.onsuccess = async (e) => {
        const db = e.target.result;
        const snapshot = { version: db.version, stores: {} };
        for (const storeName of Array.from(db.objectStoreNames)) {
          const tx    = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          snapshot.stores[storeName] = {
            keyPath:       store.keyPath,
            autoIncrement: store.autoIncrement,
            records:       await this._getAllRecords(store),
          };
        }
        db.close();
        resolve(snapshot);
      };
    });
  },

  _getAllRecords(store) {
    return idbRequest(store.getAll());
  },

  /**
   * Deletes every database. Resolves with the names of the databases whose
   * deletion is still waiting for the page to close its connection; those go
   * away once the page lets go, at the latest when it is reloaded.
   */
  async clearAll() {
    const databases = await indexedDB.databases();
    const blocked = [];
    for (const { name } of databases) {
      if (await this._deleteDB(name)) blocked.push(name);
    }
    return blocked;
  },

  // Resolves true when the page still holds the database open, so the deletion is
  // only queued; waiting for it could hang for as long as the page stays open.
  _deleteDB(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(dbName);
      let timer = null;
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(false);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error);
      };
      req.onblocked = () => {
        timer = setTimeout(() => resolve(true), this.blockedWaitMs);
      };
    });
  },

  async writeAll(snapshot) {
    for (const [dbName, dbSnapshot] of Object.entries(snapshot)) {
      await this._restoreDB(dbName, dbSnapshot);
    }
  },

  // Refills the stores in place when the schema is unchanged: unlike deleting the
  // database, that never waits on the page's own open connection.
  async _restoreDB(dbName, dbSnapshot) {
    const existing = await idbRequest(indexedDB.open(dbName));
    if (this._sameSchema(existing, dbSnapshot)) {
      await this._fill(existing, dbSnapshot, true);
      return;
    }
    existing.close();
    if (await this._deleteDB(dbName)) {
      throw new Error(`IndexedDB "${dbName}" is in use by the page`);
    }
    const req = indexedDB.open(dbName, dbSnapshot.version);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [storeName, storeSnapshot] of Object.entries(dbSnapshot.stores)) {
        const opts = {};
        if (storeSnapshot.keyPath)       opts.keyPath       = storeSnapshot.keyPath;
        if (storeSnapshot.autoIncrement) opts.autoIncrement = storeSnapshot.autoIncrement;
        db.createObjectStore(storeName, opts);
      }
    };
    await this._fill(await idbRequest(req), dbSnapshot, false);
  },

  _sameSchema(db, dbSnapshot) {
    const names = Array.from(db.objectStoreNames).sort();
    const wanted = Object.keys(dbSnapshot.stores).sort();
    if (db.version !== dbSnapshot.version || JSON.stringify(names) !== JSON.stringify(wanted)) return false;
    if (names.length === 0) return true;
    const tx = db.transaction(names, 'readonly');
    return names.every(name => {
      const store = tx.objectStore(name);
      const saved = dbSnapshot.stores[name];
      return JSON.stringify(store.keyPath ?? null) === JSON.stringify(saved.keyPath ?? null)
        && store.autoIncrement === Boolean(saved.autoIncrement);
    });
  },

  async _fill(db, dbSnapshot, clearFirst) {
    try {
      for (const [storeName, storeSnapshot] of Object.entries(dbSnapshot.stores)) {
        const tx    = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        if (clearFirst) store.clear();
        for (const record of storeSnapshot.records) {
          store.add(record);
        }
        await new Promise((res, rej) => {
          tx.oncomplete = res;
          tx.onerror    = () => rej(tx.error);
        });
      }
    } finally {
      // store.add() can throw synchronously (e.g. DataError when a record is
      // missing its declared keyPath); the connection must still be closed.
      db.close();
    }
  },
};
