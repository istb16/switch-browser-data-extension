import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadGlobalScript } from '../support/load-script.js';

const PAGE_ORIGIN = 'https://example.com';

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

    loadGlobalScript('content/content-script.js', { chrome: chromeStub, location: { origin: PAGE_ORIGIN }, localStorageHandler, sessionStorageHandler, indexedDBHandler, storageDigest }, []);
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

  it('getStorageData with digest returns only a digest of IndexedDB, matching one taken from the full data', async () => {
    const types = { localStorage: false, sessionStorage: false, indexedDB: true };
    const full = await sendAndAwait({ type: 'getStorageData', types });
    const result = await sendAndAwait({ type: 'getStorageData', digest: true, types });
    expect(Object.keys(result)).toEqual(['indexedDBDigest']);
    expect(result.indexedDBDigest).toBe(storageDigest.digest(full.indexedDB));
  });

  it('answers ping', () => {
    let reply;
    onMessage({ type: 'ping' }, r => { reply = r; });
    expect(reply).toEqual({ ok: true });
  });

  it('clearStorageData empties only the requested storage types', async () => {
    localStorage.setItem('a', '1');
    sessionStorage.setItem('b', '2');

    const result = await sendAndAwait({ type: 'clearStorageData', types: { localStorage: true, sessionStorage: false, indexedDB: true } });

    expect(result).toEqual({ success: true, blockedIndexedDB: [] });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem('b')).toBe('2');
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

  it('refuses getStorageData and setStorageData for another origin, without reading or writing', () => {
    localStorage.setItem('kept', '1');
    const types = { localStorage: true, sessionStorage: false, indexedDB: false };
    const replies = [];

    const keepGet = onMessage({ type: 'getStorageData', types, origin: 'https://other.example' }, r => replies.push(r));
    const keepSet = onMessage({ type: 'setStorageData', data: { localStorage: { fresh: 'y' } }, types, origin: 'https://other.example' }, r => replies.push(r));

    expect(keepGet).toBe(false);
    expect(keepSet).toBe(false);
    expect(replies).toEqual([{ error: expect.any(String) }, { error: expect.any(String) }]);
    expect(localStorage.getItem('kept')).toBe('1');
    expect(localStorage.getItem('fresh')).toBeNull();
  });

  it('reads and writes as before with a matching origin or none', async () => {
    const types = { localStorage: true, sessionStorage: false, indexedDB: false };
    localStorage.setItem('a', '1');

    expect(await sendAndAwait({ type: 'getStorageData', types, origin: PAGE_ORIGIN })).toEqual({ localStorage: { a: '1' } });
    expect(await sendAndAwait({ type: 'setStorageData', data: { localStorage: { b: '2' } }, types, origin: PAGE_ORIGIN })).toEqual({ success: true });
    expect(localStorage.getItem('b')).toBe('2');
    expect(await sendAndAwait({ type: 'setStorageData', data: { localStorage: { c: '3' } }, types })).toEqual({ success: true });
    expect(await sendAndAwait({ type: 'getStorageData', types })).toEqual({ localStorage: { c: '3' } });
  });

  it('checks the origin only on the read and write messages', () => {
    let reply;
    onMessage({ type: 'ping', origin: 'https://other.example' }, r => { reply = r; });
    expect(reply).toEqual({ ok: true });
  });

  it('ignores unknown message types and does not keep the channel open', () => {
    const responses = [];
    const keepChannelOpen = onMessage({ type: 'somethingElse' }, r => responses.push(r));
    expect(keepChannelOpen).toBeUndefined();
    expect(responses).toEqual([]);
  });
});
