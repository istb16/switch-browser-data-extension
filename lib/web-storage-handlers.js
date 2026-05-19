// content script — no ES module syntax
// Exposes localStorageHandler and sessionStorageHandler globals to content-script.js

function makeWebStorageHandler(storage) {
  return {
    read() {
      const result = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        result[key] = storage.getItem(key);
      }
      return result;
    },

    write(data) {
      storage.clear();
      for (const [key, value] of Object.entries(data)) {
        storage.setItem(key, value);
      }
    },
  };
}

var localStorageHandler   = makeWebStorageHandler(localStorage);
var sessionStorageHandler = makeWebStorageHandler(sessionStorage);
