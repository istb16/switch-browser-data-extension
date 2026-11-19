function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// A chrome.events.Event stand-in whose listeners tests can fire.
function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { listeners.splice(listeners.indexOf(fn), 1); },
    dispatch(...args) { listeners.forEach(fn => fn(...args)); },
  };
}

function withinDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// "*://*.example.com/*" covers example.com and every subdomain, as in Chrome.
function originCovers(granted, requested) {
  if (granted === requested) return true;
  const g = granted.match(/^([^:]+):\/\/\*\.([^/]+)(\/.*)$/);
  const r = requested.match(/^([^:]+):\/\/([^/]+)(\/.*)$/);
  if (!g || !r || g[1] !== r[1] || g[3] !== r[3]) return false;
  return withinDomain(r[2].replace(/^\*\./, ''), g[2]);
}

export function createChromeMock() {
  const state = {
    storage: {},
    cookies: [],
    tabs: [],
    messageHandlers: [],
    reloadedTabs: [],
    badges: {},
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
      onChanged: event(),
    },

    // As in Chrome, a cookie whose domain starts with "." is a domain cookie
    // and any other is host-only.
    cookies: {
      async getAll(details = {}) {
        const filter = details.domain?.replace(/^\./, '');
        return clone(state.cookies).filter(c => !filter || withinDomain(c.domain.replace(/^\./, ''), filter));
      },
      async set(details) {
        // Real chrome.cookies.set() stores a host-only cookie for the url's
        // host when no `domain` is passed, and a "."-prefixed domain cookie
        // when one is.
        const domain = details.domain == null
          ? new URL(details.url).hostname
          : `.${details.domain.replace(/^\./, '')}`;
        const cookie = { storeId: '0', ...details, domain, path: details.path ?? '/' };
        state.cookies = state.cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
        state.cookies.push(cookie);
        return clone(cookie);
      },
      async remove(details) {
        const url = new URL(details.url);
        const index = state.cookies.findIndex(c => c.name === details.name
          && c.path === url.pathname
          && (c.domain.startsWith('.') ? withinDomain(url.hostname, c.domain.slice(1)) : c.domain === url.hostname));
        if (index === -1) return null;
        state.cookies.splice(index, 1);
        return { url: details.url, name: details.name };
      },
    },

    tabs: {
      async query() {
        return clone(state.tabs);
      },
      async reload(tabId) {
        state.reloadedTabs.push(tabId);
      },
      onUpdated: event(),
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
      onInstalled: event(),
      onStartup: event(),
      getManifest() { return clone(state.manifest); },
    },

    action: {
      async setBadgeText({ tabId, text }) { state.badges[tabId] = text; },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },

    i18n: {
      getUILanguage: () => state.uiLanguage,
    },

    permissions: {
      async contains({ origins }) {
        return origins.every(origin => [...state.grantedOrigins].some(granted => originCovers(granted, origin)));
      },
      async request({ origins }) {
        origins.forEach(origin => state.grantedOrigins.add(origin));
        return true;
      },
      async remove({ origins }) {
        origins.forEach(origin => state.grantedOrigins.delete(origin));
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
