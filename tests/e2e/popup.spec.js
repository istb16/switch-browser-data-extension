import { test, expect, openPopupFor, waitForReady, readStorage } from './fixtures.js';
import { TEST_PAGE_URL, TEST_PAGE_ORIGIN, TEST_PAGE_PORT } from './test-page.js';

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
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting')).catch(() => null)).toBe('hello');

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

  await expect.poll(() => targetPage.evaluate(() => window.notReloaded ?? false).catch(() => null)).toBe(false);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting')).catch(() => null)).toBe('hello');
  await expect.poll(() => targetPage.evaluate(() => sessionStorage.getItem('counter')).catch(() => null)).toBe('1');

  const tabId = await loadPopup.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, targetPage.url());
  await expect.poll(() => loadPopup.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('sn');
});

async function enableReloadOtherTabs(context, extensionId) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html#general`);
  await waitForReady(options);
  await options.locator('#toggleReloadOtherTabs').check();
  await expect(options.locator('#statusMsg')).toHaveClass(/success/);
  await options.close();
}

// Tabs are loaded again by navigating to their URL, which reports "navigate" like
// the first load, so a mark left in the page tells whether it was replaced.
function markPage(page) {
  return page.evaluate(() => { window.__e2eMark = true; });
}

function wasLoadedAgain(page) {
  return page.evaluate(() => !window.__e2eMark).catch(() => null);
}

// Saves a snapshot on `targetPage` and loads it again, which loads the page again.
async function saveAndLoad(context, extensionId, targetPage) {
  const savePopup = await openPopupFor(context, extensionId, targetPage);
  await saveAs(savePopup, 'snap1');
  await savePopup.close();

  await markPage(targetPage);
  const loadPopup = await openPopupFor(context, extensionId, targetPage);
  await row(loadPopup, 'snap1').locator('.snapshot__main').click();
  await expect(loadPopup.locator('#statusMsg')).toHaveClass(/success/);
  await expect.poll(() => wasLoadedAgain(targetPage)).toBe(true);
  return loadPopup;
}

test('loading a snapshot on a form POST result loads the page again without sending the form again', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);
  await context.request.get(`${TEST_PAGE_ORIGIN}/post/reset`);
  const postPage = await context.newPage();
  await postPage.goto(`${TEST_PAGE_ORIGIN}/post/`);
  await postPage.locator('button').click();
  await expect(postPage.locator('h1')).toHaveText('posted 1');

  await saveAndLoad(context, extensionId, postPage);
  await expect(postPage.locator('form')).toBeVisible();
  expect(await (await context.request.get(`${TEST_PAGE_ORIGIN}/post/count`)).text()).toBe('1');
});

test.describe('reloading the other tabs of the site', () => {
  // Longer than the service worker's settle time after a load (3 s).
  const SETTLE_MS = 4000;

  test('with the setting on, the site\'s other tab reloads and an unrelated one does not', async ({ context, extensionId }) => {
    await disableCookieCollection(context, extensionId);
    await enableReloadOtherTabs(context, extensionId);
    const targetPage = await context.newPage();
    await targetPage.goto(TEST_PAGE_URL);
    const secondPage = await context.newPage();
    await secondPage.goto(`${TEST_PAGE_URL}?second`);
    const fragmentPage = await context.newPage();
    await fragmentPage.goto(`${TEST_PAGE_URL}?third#section`);
    const unrelated = await context.newPage();
    await unrelated.goto(`http://127.0.0.1:${TEST_PAGE_PORT}/`);
    for (const page of [secondPage, fragmentPage, unrelated]) await markPage(page);

    const popup = await saveAndLoad(context, extensionId, targetPage);
    await expect(popup.locator('#statusMsg')).toContainText(/ほかの 2 タブ|2 other tabs/);
    await expect.poll(() => wasLoadedAgain(secondPage)).toBe(true);
    await expect.poll(() => wasLoadedAgain(fragmentPage)).toBe(true);
    await popup.waitForTimeout(SETTLE_MS);
    expect(await wasLoadedAgain(unrelated)).toBe(false);
  });

  test('with the setting off, the site\'s other tab is left alone', async ({ context, extensionId }) => {
    await disableCookieCollection(context, extensionId);
    const targetPage = await context.newPage();
    await targetPage.goto(TEST_PAGE_URL);
    const secondPage = await context.newPage();
    await secondPage.goto(`${TEST_PAGE_URL}?second`);
    await markPage(secondPage);

    const popup = await saveAndLoad(context, extensionId, targetPage);
    await popup.waitForTimeout(SETTLE_MS);
    expect(await wasLoadedAgain(secondPage)).toBe(false);
  });

  test('a tab showing the result of a form POST does not send the form again', async ({ context, extensionId }) => {
    await disableCookieCollection(context, extensionId);
    await enableReloadOtherTabs(context, extensionId);
    await context.request.get(`${TEST_PAGE_ORIGIN}/post/reset`);
    const postPage = await context.newPage();
    await postPage.goto(`${TEST_PAGE_ORIGIN}/post/`);
    await postPage.locator('button').click();
    await expect(postPage.locator('h1')).toHaveText('posted 1');
    await markPage(postPage);
    const targetPage = await context.newPage();
    await targetPage.goto(TEST_PAGE_URL);

    await saveAndLoad(context, extensionId, targetPage);
    await expect.poll(() => wasLoadedAgain(postPage)).toBe(true);
    await targetPage.waitForTimeout(SETTLE_MS);
    expect(await (await context.request.get(`${TEST_PAGE_ORIGIN}/post/count`)).text()).toBe('1');
  });
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
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting')).catch(() => null)).toBe('hello');

  const popup = await openPopupFor(context, extensionId, targetPage);
  await popup.locator('#clearSiteBtn').click();
  await expect(popup.locator('.tk3-dialog-msg')).toContainText('localhost');
  const clearedReload = targetPage.waitForEvent('load');
  await popup.locator('.tk3-btn-confirm').click();
  await expect(popup.locator('#statusMsg')).toHaveClass(/success/);
  await clearedReload;

  // The test page writes greeting/counter again on load when they are missing,
  // so check right away for the cleared IndexedDB and the backup instead.
  await expect.poll(() => targetPage.evaluate(() => indexedDB.databases().then(dbs => dbs.map(d => d.name))).catch(() => null)).toEqual([]);
  const backup = await readStorage(popup, 'getBackup', 'localhost');
  expect(backup.localStorage.greeting).toBe('hello');
  expect(Object.keys(backup.indexedDB)).toEqual(['e2e']);

  const restoredReload = targetPage.waitForEvent('load');
  await popup.locator('#undoBtn').click();
  await restoredReload;
  await expect.poll(() => targetPage.evaluate(() => indexedDB.databases().then(dbs => dbs.map(d => d.name))).catch(() => null)).toEqual(['e2e']);
});

test('legacy storage is migrated in the browser', async ({ context, extensionId }) => {
  await disableCookieCollection(context, extensionId);

  const targetPage = await context.newPage();
  await targetPage.goto(TEST_PAGE_URL);
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting')).catch(() => null)).toBe('hello');

  const seeder = await context.newPage();
  await seeder.goto(`chrome-extension://${extensionId}/options/options.html`);
  await waitForReady(seeder);
  const savedAt = new Date().toISOString();
  await seeder.evaluate(seed => chrome.storage.local.remove('schemaVersion').then(() => chrome.storage.local.set(seed)), {
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
  // The undo reloads the tab; a read during that navigation throws, and counts as not yet.
  await expect.poll(() => targetPage.evaluate(() => localStorage.getItem('greeting')).catch(() => null)).toBe('from backup');

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
