import { test, expect, openPopupFor, waitForReady, reloadAndWait, seedSnapshots } from './fixtures.js';
import { TEST_PAGE_ORIGIN } from './test-page.js';

const loginUrl = user => `${TEST_PAGE_ORIGIN}/cookies/login?user=${user}`;

function popupRow(popup, name) {
  return popup.locator('#snapshotList .snapshot').filter({ has: popup.locator('.snapshot__name', { hasText: name }) });
}

test('options row opens the viewer for a seeded snapshot', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html#snapshots`);
  await options.evaluate(() => chrome.storage.local.set({ language: 'ja' }));
  await seedSnapshots(options, {
    'a.example.com': { first: { savedAt: new Date().toISOString(), localStorage: { token: 'secret-value-123' } } },
  });
  await reloadAndWait(options);

  await options.locator('.domain-item .domain-header').click();
  const [viewer] = await Promise.all([
    context.waitForEvent('page'),
    options.locator('.snapshot-row').getByRole('button', { name: '"first" の中身を見る', exact: true }).click(),
  ]);
  await waitForReady(viewer);

  await expect(viewer.locator('#snapshotName')).toHaveText('first');
  await expect(viewer.locator('#snapshotHost')).toHaveText('a.example.com');
  const section = viewer.locator('details[data-type="localStorage"]');
  await expect(section.locator('td.cell-mono')).toHaveText('token');
  await expect(section.locator('.value-mask')).toBeVisible();
  expect(await viewer.content()).not.toContain('secret-value-123');

  await viewer.locator('#revealToggle').check();
  await expect(section.locator('.value-text')).toHaveText('secret-value-123');
});

test.describe('with host permission', () => {
  test.use({ grantHostPermissions: true });

  test('popup menu opens the viewer and compares with the current page', async ({ context, extensionId }) => {
    const site = await context.newPage();
    await site.goto(loginUrl('alice'));
    await expect(site.locator('h1')).toHaveText('signed in as: alice');
    await site.evaluate(() => new Promise((resolve, reject) => {
      localStorage.setItem('mode', 'before');
      const req = indexedDB.open('viewer-e2e', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('keyed', { keyPath: 'id' });
        req.result.createObjectStore('keyless', { autoIncrement: true });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['keyed', 'keyless'], 'readwrite');
        tx.objectStore('keyed').put({ id: 1, v: 'one' });
        tx.objectStore('keyed').put({ id: 2, v: 'two' });
        tx.objectStore('keyless').add({ v: 'a' });
        tx.objectStore('keyless').add({ v: 'b' });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));

    const popup = await openPopupFor(context, extensionId, site);
    await popup.locator('#saveBtn').click();
    await popup.locator('#newSnapshotName').fill('saved');
    await popup.locator('#confirmSaveBtn').click();
    await expect(popupRow(popup, 'saved')).toHaveClass(/is-active/);

    await site.goto(loginUrl('bob'));
    await expect(site.locator('h1')).toHaveText('signed in as: bob');
    await site.evaluate(() => new Promise((resolve, reject) => {
      localStorage.setItem('mode', 'after');
      const req = indexedDB.open('viewer-e2e', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['keyed', 'keyless'], 'readwrite');
        tx.objectStore('keyed').put({ id: 1, v: 'uno' });
        tx.objectStore('keyless').put({ v: 'c' }, 2);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));

    const storedBefore = await popup.evaluate(() => chrome.storage.local.get(null));
    const pageStorageBefore = await site.evaluate(() => ({ ...localStorage }));

    await popupRow(popup, 'saved').locator('.snapshot__more').click();
    const [viewer] = await Promise.all([
      context.waitForEvent('page'),
      popupRow(popup, 'saved').locator('.actions-menu [data-action="view"]').click(),
    ]);
    await waitForReady(viewer);
    await expect(viewer.locator('#snapshotName')).toHaveText('saved');

    await viewer.locator('#compareSelect').selectOption('current');
    const cookies = viewer.locator('details[data-type="cookies"]');
    const sidRow = cookies.locator('tr.status-changed').filter({ has: viewer.locator('td.cell-mono', { hasText: /^sid$/ }) });
    await expect(sidRow).toHaveCount(1);
    await expect(viewer.locator('#compareNote')).toContainText(TEST_PAGE_ORIGIN);

    const local = viewer.locator('details[data-type="localStorage"]');
    await expect(local.locator('tr.status-changed')).toHaveCount(1);
    await expect(local.locator('tr.status-changed td.cell-mono')).toHaveText('mode');

    const database = viewer.locator('details[data-database="viewer-e2e"]');
    const keyed = database.locator('details[data-store="keyed"]');
    await keyed.locator('summary').click();
    await expect(keyed.locator('tr.status-changed')).toHaveCount(1);
    await expect(keyed.locator('tr.status-added, tr.status-removed')).toHaveCount(0);

    const keyless = database.locator('details[data-store="keyless"]');
    await keyless.locator('summary').click();
    await expect(keyless.locator('tr.status-removed')).toHaveCount(1);
    await expect(keyless.locator('tr.status-added')).toHaveCount(1);
    await expect(keyless.locator('tr.status-changed')).toHaveCount(0);

    expect(await popup.evaluate(() => chrome.storage.local.get(null))).toEqual(storedBefore);
    expect(await site.evaluate(() => ({ ...localStorage }))).toEqual(pageStorageBefore);
  });
});
