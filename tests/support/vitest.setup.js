import { beforeEach } from 'vitest';
import { installChromeMock } from './chrome-mock.js';
import { installDialogShim } from './dialog-shim.js';

installDialogShim();

// jsdom does no layout, so it has no scrollIntoView.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

beforeEach(() => {
  installChromeMock();
});
