// Thin message router — actual storage logic lives in lib/*-handler.js,
// which are injected before this script via manifest content_scripts.

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'getStorageData') {
      handleGet(message.types, message.digest).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    }
    if (message.type === 'ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'clearStorageData') {
      handleClear(message.types).then(blocked => sendResponse({ success: true, blockedIndexedDB: blocked })).catch(e => sendResponse({ error: e.message }));
      return true;
    }
    if (message.type === 'setStorageData') {
      handleSet(message.data, message.types).then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
      return true;
    }
  });

  async function handleGet(types, digest) {
    const data = {};
    if (types.localStorage)  data.localStorage  = localStorageHandler.read();
    if (types.sessionStorage) data.sessionStorage = sessionStorageHandler.read();
    if (types.indexedDB) {
      const indexedDB = await indexedDBHandler.readAll();
      // Only the digest crosses to the popup; the records are passed through the
      // same JSON round trip messaging applies, to hash what a snapshot holds.
      if (digest) data.indexedDBDigest = storageDigest.digest(JSON.parse(JSON.stringify(indexedDB)));
      else        data.indexedDB       = indexedDB;
    }
    return data;
  }

  async function handleClear(types) {
    if (types.localStorage)   localStorageHandler.clear();
    if (types.sessionStorage) sessionStorageHandler.clear();
    return types.indexedDB ? indexedDBHandler.clearAll() : [];
  }

  async function handleSet(data, types) {
    if (types.localStorage  && data.localStorage  != null) localStorageHandler.write(data.localStorage);
    if (types.sessionStorage && data.sessionStorage != null) sessionStorageHandler.write(data.sessionStorage);
    if (types.indexedDB     && data.indexedDB      != null) await indexedDBHandler.writeAll(data.indexedDB);
  }
})();
