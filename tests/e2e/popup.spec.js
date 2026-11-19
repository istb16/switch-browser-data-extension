import { test, expect, openPopupFor, waitForReady } from './fixtures.js';
import { TEST_PAGE_URL } from './test-page.js';

async function disableCookieCollection(context, extensionId) {
  // Collecting cookies triggers chrome.permissions.request(), which shows a
  // native Chrome permission bubble Playwright can't drive. The cookie
  // collection/restore path is already covered at the unit level
  // (lib/cookie-handler.test.js, lib/data-bridge.test.js), so E2E only needs
  // to exercise the localStorage/sessionStorage path end to end.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await waitForReady(options);
  await options.locator('#toggleCookies').uncheck();
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

function row(popup, name) {
  return popup.locator('#snapshotList .snapshot').filter({ has: popup.locator('.snapshot__name', { hasText: name }) });
}

async function saveAs(popup, name) {
  await popup.locator('#saveBtn').click();
  await popup.locator('#newSnapshotName').fill(name);
  await popup.locator('#confirmSaveBtn').click();
  await expect(row(popup, name)).toHaveClass(/is-active/);
}

test('save then load round-trips real localStorage/sessionStorage, reloads the tab and badges the icon', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  const savePopup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(savePopup, 'snap1');
  await savePopup.close();

  await targetPage.evaluate(() => {
    localStorage.setItem('greeting', 'changed');
    sessionStorage.setItem('counter', '99');
    window.notReloaded = true;
  });

  const loadPopup = await openPopupFor(context, extensionId, targetPage);
  await expect(row(loadPopup, 'snap1').locator('.badge--modified')).toBeVisible();
  await row(loadPopup, 'snap1').locator('.snapshot__main').click();
  await expect(loadPopup.locator('#statusMsg')).toHaveClass(/success/);
  await expect(row(loadPopup, 'snap1').locator('.badge--modified')).toBeHidden();
  await expect(loadPopup.locator('#undoBar')).toBeVisible();

  await expect.poll(() => targetPage.evaluate(() => window.notReloaded ?? false)).toBe(false);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');
  await expect.poll(() => targetPage.evaluate(() => sessionStorage.getItem('counter'))).toBe('1');

  const tabId = await loadPopup.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, targetPage.url());
  await expect.poll(() => loadPopup.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('sn');
});

// Puts one record in a real IndexedDB store of the test page, replacing the store's contents.
async function putRecord(page, record) {
  await page.evaluate(rec => new Promise((resolve, reject) => {
    const req = indexedDB.open('e2e', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('items', 'readwrite');
      tx.objectStore('items').clear();
      tx.objectStore('items').put(rec);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), record);
}

test('an IndexedDB edit that keeps the record count still shows as a change', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await putRecord(targetPage, { id: 1, name: 'before' });

  const savePopup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(savePopup, 'idb');
  await savePopup.close();

  const samePopup = await openPopupFor(context, extensionId, targetPage);
  await samePopup.waitForTimeout(500);
  await expect(row(samePopup, 'idb').locator('.badge--modified')).toBeHidden();
  await samePopup.close();

  await putRecord(targetPage, { id: 1, name: 'after' });
  const popup = await openPopupFor(context, extensionId, targetPage);
  const badge = row(popup, 'idb').locator('.badge--modified');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('title', /IndexedDB/);
});

test('the undo bar restores the state from before the load', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(popup, 'snap1');

  await targetPage.evaluate(() => localStorage.setItem('greeting', 'changed'));
  await row(popup, 'snap1').locator('.snapshot__main').click();
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  await popup.locator('#undoBtn').click();
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('changed');
  // snap1 was the active snapshot before the load, so it is again, now flagged as changed.
  await expect(row(popup, 'snap1').locator('.badge--modified')).toBeVisible();
});

test('the row menu opens from its button and deletes the snapshot', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(popup, 'to-delete');

  await row(popup, 'to-delete').locator('.snapshot__more').click();
  const menu = row(popup, 'to-delete').locator('.actions-menu');
  await expect(menu).toBeVisible();
  await menu.locator('[data-action="delete"]').click();
  await expect(menu).toBeHidden();
  await popup.locator('.tk3-btn-confirm').click();

  await expect(row(popup, 'to-delete')).toHaveCount(0);
  await expect(popup.locator('#emptyState')).toBeVisible();
});

test('the row menu works from the keyboard', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(popup, 'kbd');

  const more = row(popup, 'kbd').locator('.snapshot__more');
  await more.focus();
  await popup.keyboard.press('Enter');
  const menu = row(popup, 'kbd').locator('.actions-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-action="overwrite"]')).toBeFocused();
  await popup.keyboard.press('ArrowDown');
  await expect(menu.locator('[data-action="rename"]')).toBeFocused();
  await popup.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  await popup.keyboard.press('Enter');
  await expect(menu.locator('[data-action="overwrite"]')).toBeFocused();
  await popup.keyboard.press('ArrowDown');
  await expect(menu.locator('[data-action="rename"]')).toBeFocused();
  await popup.keyboard.press('Enter');
  const input = popup.locator('.snapshot__rename');
  await expect(input).toBeFocused();
  await input.fill('renamed');
  await popup.keyboard.press('Enter');
  await expect(row(popup, 'renamed')).toHaveClass(/is-active/);
});
