import { describe, it, expect, beforeEach } from 'vitest';
import { loadGlobalScript } from '../support/load-script.js';

describe('lib/web-storage-handlers (non-module content script)', () => {
  let localStorageHandler;
  let sessionStorageHandler;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    ({ localStorageHandler, sessionStorageHandler } = loadGlobalScript(
      'lib/web-storage-handlers.js',
      { localStorage, sessionStorage },
      ['localStorageHandler', 'sessionStorageHandler'],
    ));
  });

  it('read() returns all key/value pairs currently in the storage', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    expect(localStorageHandler.read()).toEqual({ a: '1', b: '2' });
  });

  it('read() returns {} for empty storage', () => {
    expect(sessionStorageHandler.read()).toEqual({});
  });

  it('write() replaces the entire storage contents', () => {
    localStorage.setItem('stale', 'x');
    localStorageHandler.write({ fresh: 'y' });
    expect(localStorageHandler.read()).toEqual({ fresh: 'y' });
  });

  it('localStorageHandler and sessionStorageHandler operate on independent stores', () => {
    localStorageHandler.write({ a: '1' });
    sessionStorageHandler.write({ b: '2' });
    expect(localStorageHandler.read()).toEqual({ a: '1' });
    expect(sessionStorageHandler.read()).toEqual({ b: '2' });
  });
});
