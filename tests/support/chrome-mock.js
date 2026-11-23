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
    storageEvents: [],
    cookies: [],
    tabs: [],
    messageHandlers: [],
    reloadedTabs: [],
    navigatedTabs: [],
    badges: {},
    grantedOrigins: new Set(),
    uiLanguage: 'ja',
    manifest: { version: '1.0.1' },
  };

  const heldGets = [];

  function read(keys) {
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
  }

  function keyNames(keys) {
    if (keys == null) return Object.keys(state.storage);
    if (typeof keys === 'string') return [keys];
    return Array.isArray(keys) ? keys : Object.keys(keys);
  }

  // As in Chrome, each write that changes something queues one onChanged
  // event; tests deliver them with chrome._deliverStorageEvents().
  function write(apply) {
    const before = { ...state.storage };
    apply();
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(state.storage)])) {
      const oldJson = JSON.stringify(before[key]);
      const newJson = JSON.stringify(state.storage[key]);
      if (oldJson === newJson) continue;
      changes[key] = {};
      if (key in before) changes[key].oldValue = clone(before[key]);
      if (key in state.storage) changes[key].newValue = clone(state.storage[key]);
    }
    if (Object.keys(changes).length) state.storageEvents.push(changes);
  }

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const result = read(keys);
          const index = heldGets.findIndex(held => held.match(keyNames(keys)));
          if (index === -1) return result;
          const [held] = heldGets.splice(index, 1);
          await held.released;
          return result;
        },
        async set(items) {
          write(() => {
            for (const [key, value] of Object.entries(items)) state.storage[key] = clone(value);
          });
        },
        async remove(keys) {
          write(() => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete state.storage[key];
          });
        },
        async clear() {
          write(() => { state.storage = {}; });
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
      async get(tabId) {
        const tab = state.tabs.find(t => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return clone(tab);
      },
      // Navigating a tab to a URL loads it again, so it is recorded as a reload too.
      async update(tabId, { url }) {
        state.navigatedTabs.push({ tabId, url });
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

    _deliverStorageEvents() {
      const events = state.storageEvents.splice(0);
      for (const changes of events) chrome.storage.onChanged.dispatch(changes, 'local');
    },

    // `match` gets the key names a get asks for (every stored key for get(null)).
    // The result is read at call time, so writes made while held are not in it.
    _holdGet(match) {
      let release;
      const released = new Promise(resolve => { release = resolve; });
      heldGets.push({ match, released });
      return { release };
    },
  };

  return chrome;
}

export function installChromeMock() {
  const chrome = createChromeMock();
  globalThis.chrome = chrome;
  return chrome;
}
