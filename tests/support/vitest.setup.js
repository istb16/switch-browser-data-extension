import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';
import { installChromeMock } from './chrome-mock.js';
import { installDialogShim } from './dialog-shim.js';
import { loadGlobalScript } from './load-script.js';

installDialogShim();

// jsdom's crypto has no subtle; export encryption needs the real Web Crypto.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

// popup.html loads this classic script before its modules; do the same here.
globalThis.storageDigest = loadGlobalScript('lib/storage-digest.js', {}, ['storageDigest']).storageDigest;

// jsdom does no layout, so it has no scrollIntoView.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  installChromeMock();
});
