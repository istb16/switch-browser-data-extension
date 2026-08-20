import { test, expect, openPopupFor } from './fixtures.js';
import { TEST_PAGE_URL } from './test-page.js';

async function disableCookieCollection(context, extensionId) {
  // Collecting cookies triggers chrome.permissions.request(), which shows a
  // native Chrome permission bubble Playwright can't drive. The cookie
  // collection/restore path is already covered at the unit level
  // (lib/cookie-handler.test.js, lib/data-bridge.test.js), so E2E only needs
  // to exercise the localStorage/sessionStorage path end to end.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await options.locator('#toggleCookies').uncheck();
  await options.locator('#saveSettingsBtn').click();
  await expect(options.locator('#statusMsg')).toHaveClass(/success/);
  await options.close();
}

test('detects the domain from the real active tab', async ({ context, extensionId }) => {
  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);

  await expect(popup.locator('#currentDomain')).toHaveText('localhost');
  await expect(popup.locator('#mainContent')).toBeVisible();
});

test('shows the "not available" message for a restricted page', async ({ context, extensionId }) => {
  const targetPage = await context.newPage();
  await targetPage.goto('chrome://version');

  const popup = await openPopupFor(context, extensionId, targetPage);

  await expect(popup.locator('#unavailableMsg')).toBeVisible();
  await expect(popup.locator('#mainContent')).toBeHidden();
});

test('save then load round-trips real localStorage/sessionStorage through the content script', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  const savePopup = await openPopupFor(context, extensionId, targetPage);
  await savePopup.locator('#saveBtn').click();
  await savePopup.locator('#newSnapshotName').fill('snap1');
  await savePopup.locator('#confirmSaveBtn').click();
  await expect(savePopup.locator('#statusMsg')).toHaveClass(/success/);
  await savePopup.close();

  await targetPage.evaluate(() => {
    localStorage.setItem('greeting', 'changed');
    sessionStorage.setItem('counter', '99');
  });

  const loadPopup = await openPopupFor(context, extensionId, targetPage);
  await loadPopup.locator('#snapshotSelect').selectOption('snap1');
  await loadPopup.locator('#loadBtn').click();
  await loadPopup.locator('.tk3-btn-confirm').click();
  await expect(loadPopup.locator('#statusMsg')).toHaveClass(/success/);

  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');
  await expect.poll(() => targetPage.evaluate(() => sessionStorage.getItem('counter'))).toBe('1');
});

test('deleting the selected snapshot removes it from the dropdown', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);
  await popup.locator('#saveBtn').click();
  await popup.locator('#newSnapshotName').fill('to-delete');
  await popup.locator('#confirmSaveBtn').click();
  await expect(popup.locator('#statusMsg')).toHaveClass(/success/);

  await popup.locator('#deleteBtn').click();
  await popup.locator('.tk3-btn-confirm').click();
  await expect(popup.locator('#statusMsg')).toHaveClass(/success/);

  const options = [...await popup.locator('#snapshotSelect option').allTextContents()];
  expect(options.join('')).not.toContain('to-delete');
});
