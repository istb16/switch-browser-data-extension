import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadGlobalScript } from '../support/load-script.js';

describe('content/content-script (non-module message router)', () => {
  let onMessage;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();

    const { localStorageHandler, sessionStorageHandler } = loadGlobalScript(
      'lib/web-storage-handlers.js',
      { localStorage, sessionStorage },
      ['localStorageHandler', 'sessionStorageHandler'],
    );
    const { indexedDBHandler } = loadGlobalScript('lib/indexeddb-handler.js', { indexedDB: new IDBFactory() }, ['indexedDBHandler']);

    let listener;
    const chromeStub = { runtime: { onMessage: { addListener: fn => { listener = fn; } } } };

    loadGlobalScript('content/content-script.js', { chrome: chromeStub, localStorageHandler, sessionStorageHandler, indexedDBHandler }, []);
    onMessage = (message, sendResponse) => listener(message, {}, sendResponse);
  });

  function sendAndAwait(message) {
    return new Promise(resolve => {
      const keepChannelOpen = onMessage(message, resolve);
      expect(keepChannelOpen).toBe(true);
    });
  }

  it('getStorageData returns only the requested storage types', async () => {
    localStorage.setItem('a', '1');
    sessionStorage.setItem('b', '2');

    const result = await sendAndAwait({ type: 'getStorageData', types: { localStorage: true, sessionStorage: false, indexedDB: false } });

    expect(result).toEqual({ localStorage: { a: '1' } });
  });

  it('getStorageData includes indexedDB when requested', async () => {
    const result = await sendAndAwait({ type: 'getStorageData', types: { localStorage: false, sessionStorage: false, indexedDB: true } });
    expect(result).toEqual({ indexedDB: {} });
  });

  it('setStorageData writes only the requested + present storage types', async () => {
    localStorage.setItem('stale', 'x');

    const result = await sendAndAwait({
      type: 'setStorageData',
      data: { localStorage: { fresh: 'y' }, sessionStorage: { untouched: 'z' } },
      types: { localStorage: true, sessionStorage: false, indexedDB: false },
    });

    expect(result).toEqual({ success: true });
    expect(localStorage.getItem('fresh')).toBe('y');
    expect(localStorage.getItem('stale')).toBeNull();
    expect(sessionStorage.getItem('untouched')).toBeNull();
  });

  it('responds with an error when restoring indexedDB data fails', async () => {
    // A record missing the declared keyPath fails IDBObjectStore.add(),
    // which should surface as { error } instead of rejecting silently.
    const result = await sendAndAwait({
      type: 'setStorageData',
      data: {
        indexedDB: {
          mydb: { version: 1, stores: { items: { keyPath: 'id', autoIncrement: false, records: [{ noId: true }] } } },
        },
      },
      types: { localStorage: false, sessionStorage: false, indexedDB: true },
    });

    expect(result.error).toBeTruthy();
  });

  it('ignores unknown message types and does not keep the channel open', () => {
    const responses = [];
    const keepChannelOpen = onMessage({ type: 'somethingElse' }, r => responses.push(r));
    expect(keepChannelOpen).toBeUndefined();
    expect(responses).toEqual([]);
  });
});
