// Thin message router — actual storage logic lives in lib/*-handler.js,
// which are injected before this script via manifest content_scripts.

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'getStorageData') {
      handleGet(message.types).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    }
    if (message.type === 'setStorageData') {
      handleSet(message.data, message.types).then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
      return true;
    }
  });

  async function handleGet(types) {
    const data = {};
    if (types.localStorage)  data.localStorage  = localStorageHandler.read();
    if (types.sessionStorage) data.sessionStorage = sessionStorageHandler.read();
    if (types.indexedDB)     data.indexedDB      = await indexedDBHandler.readAll();
    return data;
  }

  async function handleSet(data, types) {
    if (types.localStorage  && data.localStorage  != null) localStorageHandler.write(data.localStorage);
    if (types.sessionStorage && data.sessionStorage != null) sessionStorageHandler.write(data.sessionStorage);
    if (types.indexedDB     && data.indexedDB      != null) await indexedDBHandler.writeAll(data.indexedDB);
  }
})();
