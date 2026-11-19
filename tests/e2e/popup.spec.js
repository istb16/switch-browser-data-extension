import { test, expect, openPopupFor, waitForReady, readStorage } from './fixtures.js';
import { TEST_PAGE_URL } from './test-page.js';

async function disableCookieCollection(context, extensionId) {
  // Collecting cookies triggers chrome.permissions.request(), which shows a
  // native Chrome permission bubble Playwright can't drive. The cookie
  // collection/restore path is already covered at the unit level
  // (lib/cookie-handler.test.js, lib/data-bridge.test.js), so E2E only needs
  // to exercise the localStorage/sessionStorage path end to end.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html#data-types`);
  await waitForReady(options);
  await options.locator('#toggleCookies').uncheck();
  await expect(options.locator('#statusMsg')).toHaveClass(/success/);
  await options.close();
}

test('detects the domain and, before cookie access is allowed, asks for it instead of showing the list', async ({ context, extensionId }) => {
  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);

  await expect(popup.locator('#currentDomain')).toHaveText('localhost');
  await expect(popup.locator('#permissionPanel')).toBeVisible();
  await expect(popup.locator('#grantPermissionBtn')).toBeVisible();
  await expect(popup.locator('#mainContent')).toBeHidden();
});

test('shows the list straight away when cookies are turned off', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);
  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);

  const popup = await openPopupFor(context, extensionId, targetPage);

  await expect(popup.locator('#mainContent')).toBeVisible();
  await expect(popup.locator('#permissionPanel')).toBeHidden();
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

test('memo, colour and preview show after save', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);
  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  const popup = await openPopupFor(context, extensionId, targetPage);
  await popup.locator('#saveBtn').click();
  await popup.locator('#newSnapshotName').fill('tagged');
  await popup.locator('#newSnapshotMemo').fill('staging admin');
  await popup.locator('input[name="newSnapshotColor"][value="green"]').check();
  await popup.locator('#confirmSaveBtn').click();

  const tagged = row(popup, 'tagged');
  await expect(tagged).toHaveClass(/is-active/);
  await expect(tagged.locator('.snapshot__chip--green')).toBeVisible();
  await expect(tagged.locator('.snapshot__memo')).toHaveText('staging admin');
  await expect(tagged.locator('.snapshot__preview')).toHaveText(/^LS \d+ · .*[\d.]+ (B|KB|MB)$/);

  await tagged.locator('.snapshot__more').click();
  await tagged.locator('.actions-menu [data-action="edit"]').click();
  const dialog = popup.locator('dialog');
  await dialog.locator('input[type="text"]').fill('edited');
  await dialog.locator('input[type="radio"][value="blue"]').check();
  await dialog.locator('.tk3-btn-confirm').click();
  await expect(tagged.locator('.snapshot__memo')).toHaveText('edited');
  await expect(tagged.locator('.snapshot__chip--blue')).toBeVisible();
});

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

test('clears the site\'s localStorage, sessionStorage and IndexedDB, and the undo bar brings them back', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await putRecord(targetPage, { id: 1, name: 'kept' });
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  const popup = await openPopupFor(context, extensionId, targetPage);
  await popup.locator('#clearSiteBtn').click();
  await expect(popup.locator('.tk3-dialog-msg')).toContainText('localhost');
  const clearedReload = targetPage.waitForEvent('load');
  await popup.locator('.tk3-btn-confirm').click();
  await expect(popup.locator('#statusMsg')).toHaveClass(/success/);
  await clearedReload;

  // The test page writes greeting/counter again on load when they are missing,
  // so check right away for the cleared IndexedDB and the backup instead.
  await expect.poll(() => targetPage.evaluate(() => indexedDB.databases().then(dbs => dbs.map(d => d.name)))).toEqual([]);
  const backup = await readStorage(popup, 'getBackup', 'localhost');
  expect(backup.localStorage.greeting).toBe('hello');
  expect(Object.keys(backup.indexedDB)).toEqual(['e2e']);

  const restoredReload = targetPage.waitForEvent('load');
  await popup.locator('#undoBtn').click();
  await restoredReload;
  await expect.poll(() => targetPage.evaluate(() => indexedDB.databases().then(dbs => dbs.map(d => d.name)))).toEqual(['e2e']);
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

test('legacy storage is migrated in the browser', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('hello');

  const seeder = await context.newPage();
  await seeder.goto(`chrome-extension://${extensionId}/options/options.html`);
  await waitForReady(seeder);
  const savedAt = new Date().toISOString();
  await seeder.evaluate(seed => chrome.storage.local.set(seed), {
    snapshots: { localhost: {
      first:  { savedAt, localStorage: { greeting: 'from first' }, sessionStorage: {} },
      second: { savedAt, localStorage: { greeting: 'from second' }, sessionStorage: {} },
    } },
    backups: { localhost: { savedAt, activeName: null, localStorage: { greeting: 'from backup' }, sessionStorage: {} } },
    snapshotOrder: { localhost: ['second', 'first'] },
  });
  await seeder.close();

  const popup = await openPopupFor(context, extensionId, targetPage);
  await expect(popup.locator('#snapshotList .snapshot .snapshot__name')).toHaveText(['second', 'first']);
  await expect(popup.locator('#undoBar')).toBeVisible();

  await popup.locator('#undoBtn').click();
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting'))).toBe('from backup');

  const stored = await popup.evaluate(() => chrome.storage.local.get(null));
  expect(stored).not.toHaveProperty('snapshots');
  expect(stored).not.toHaveProperty('backups');
  expect(Object.keys(stored['snapshots/localhost'])).toEqual(['first', 'second']);
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
