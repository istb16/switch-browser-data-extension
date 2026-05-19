// content script — no ES module syntax
// Exposes indexedDBHandler global to content-script.js

var indexedDBHandler = {
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
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onerror  = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  },

  async writeAll(snapshot) {
    for (const [dbName, dbSnapshot] of Object.entries(snapshot)) {
      await this._restoreDB(dbName, dbSnapshot);
    }
  },

  _restoreDB(dbName, dbSnapshot) {
    return new Promise((resolve, reject) => {
      const delReq = indexedDB.deleteDatabase(dbName);
      delReq.onerror  = () => reject(delReq.error);
      delReq.onsuccess = () => {
        const req = indexedDB.open(dbName, dbSnapshot.version);
        req.onerror = () => reject(req.error);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          for (const [storeName, storeSnapshot] of Object.entries(dbSnapshot.stores)) {
            const opts = {};
            if (storeSnapshot.keyPath)       opts.keyPath       = storeSnapshot.keyPath;
            if (storeSnapshot.autoIncrement) opts.autoIncrement = storeSnapshot.autoIncrement;
            db.createObjectStore(storeName, opts);
          }
        };

        req.onsuccess = async (e) => {
          const db = e.target.result;
          for (const [storeName, storeSnapshot] of Object.entries(dbSnapshot.stores)) {
            const tx    = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const record of storeSnapshot.records) {
              store.add(record);
            }
            await new Promise((res, rej) => {
              tx.oncomplete = res;
              tx.onerror    = () => rej(tx.error);
            });
          }
          db.close();
          resolve();
        };
      };
    });
  },
};
