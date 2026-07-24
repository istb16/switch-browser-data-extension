function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createChromeMock() {
  const state = {
    storage: {},
    cookies: [],
    tabs: [],
    messageHandlers: [],
    grantedOrigins: new Set(),
    uiLanguage: 'ja',
    manifest: { version: '1.0.1' },
  };

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(state.storage);
          if (typeof keys === 'string') {
            return keys in state.storage ? { [keys]: clone(state.storage[keys]) } : {};
          }
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) if (key in state.storage) result[key] = clone(state.storage[key]);
            return result;
          }
          const result = {};
          for (const [key, defaultValue] of Object.entries(keys)) {
            result[key] = key in state.storage ? clone(state.storage[key]) : defaultValue;
          }
          return result;
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) state.storage[key] = clone(value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state.storage[key];
        },
        async clear() {
          state.storage = {};
        },
      },
    },

    cookies: {
      async getAll(details = {}) {
        return clone(state.cookies).filter(c => !details.domain || c.domain === details.domain);
      },
      async set(details) {
        // Real chrome.cookies.set() derives `domain` from `url` when the
        // caller doesn't pass one explicitly — cookie-handler.js relies on
        // exactly that, so the mock must replicate it.
        const domain = details.domain ?? new URL(details.url).hostname;
        const cookie = { storeId: '0', ...details, domain };
        state.cookies = state.cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain));
        state.cookies.push(cookie);
        return clone(cookie);
      },
      async remove(details) {
        state.cookies = state.cookies.filter(c => c.name !== details.name);
        return { url: details.url, name: details.name };
      },
    },

    tabs: {
      async query() {
        return clone(state.tabs);
      },
      // Overridden per-test with vi.fn() where message round-tripping matters.
      sendMessage: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },

    runtime: {
      onMessage: {
        addListener(fn) { state.messageHandlers.push(fn); },
        removeListener(fn) { state.messageHandlers = state.messageHandlers.filter(h => h !== fn); },
      },
      openOptionsPage() {},
      getManifest() { return clone(state.manifest); },
    },

    i18n: {
      getUILanguage: () => state.uiLanguage,
    },

    permissions: {
      async contains({ origins }) {
        return origins.every(origin => state.grantedOrigins.has(origin));
      },
      async request({ origins }) {
        origins.forEach(origin => state.grantedOrigins.add(origin));
        return true;
      },
    },

    _state: state,
  };

  return chrome;
}

export function installChromeMock() {
  const chrome = createChromeMock();
  globalThis.chrome = chrome;
  return chrome;
}
