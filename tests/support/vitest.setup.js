import { beforeEach } from 'vitest';
import { installChromeMock } from './chrome-mock.js';
import { installDialogShim } from './dialog-shim.js';

installDialogShim();

beforeEach(() => {
  installChromeMock();
});
