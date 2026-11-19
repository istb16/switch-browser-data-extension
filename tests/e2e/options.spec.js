import { test, expect, reloadAndWait } from './fixtures.js';

async function openOptions(context, extensionId, pane = '') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html${pane}`);
  // Force Japanese regardless of the test machine's browser locale, so
  // assertions on rendered text are deterministic.
  await page.evaluate(() => chrome.storage.local.set({ language: 'ja' }));
  await reloadAndWait(page);
  return page;
}

test.describe('options page', () => {
  test('shows the manifest version in the footer', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await expect(page.locator('#versionFooter')).toHaveText(/^バージョン: \d+\.\d+\.\d+$/);
  });

  test('nav switches panes and the hash opens one directly', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await expect(page.locator('#pane-general')).toBeVisible();
    await expect(page.locator('#pane-snapshots')).toBeHidden();

    await page.locator('.nav-link[data-pane="snapshots"]').click();
    await expect(page).toHaveURL(/#snapshots$/);
    await expect(page.locator('#pane-snapshots')).toBeVisible();
    await expect(page.locator('#pane-general')).toBeHidden();
    await expect(page.locator('.nav-link[data-pane="snapshots"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#meterBar')).toBeVisible();

    await page.locator('.nav-link[data-pane="data"]').click();
    await expect(page.locator('#pane-data')).toBeVisible();
    await expect(page.locator('#pane-snapshots')).toBeHidden();

    await reloadAndWait(page);
    await expect(page.locator('#pane-data')).toBeVisible();
    await expect(page.locator('#pane-general')).toBeHidden();
  });

  test('shows the empty state when there are no snapshots', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#snapshots');
    await expect(page.locator('.empty-state')).toBeVisible();
  });

  test('renaming a snapshot updates it in place without collapsing other open domains', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#snapshots');

    await page.evaluate(() => chrome.storage.local.set({
      snapshots: {
        'a.example.com': { first: { savedAt: new Date().toISOString() } },
        'b.example.com': { other: { savedAt: new Date().toISOString() } },
      },
    }));
    await reloadAndWait(page);

    const domainItems = page.locator('.domain-item');
    await domainItems.nth(0).locator('.domain-header').click();
    await domainItems.nth(1).locator('.domain-header').click();
    await expect(domainItems.nth(0)).toHaveClass(/open/);
    await expect(domainItems.nth(1)).toHaveClass(/open/);

    const row = domainItems.nth(0).locator('.snapshot-row');
    await row.locator('.snapshot-name').dblclick();
    const input = row.locator('.snapshot-name-input');
    await input.fill('renamed');
    await input.press('Enter');

    await expect(row.locator('.snapshot-name')).toHaveText('renamed');
    await expect(domainItems.nth(1)).toHaveClass(/open/);
    await expect(domainItems).toHaveCount(2);
  });

  test('rejects a rename to a name that already exists in the domain', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#snapshots');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString() }, second: { savedAt: new Date().toISOString() } } },
    }));
    await reloadAndWait(page);
    await page.locator('.domain-header').click();

    // An attribute selector rather than hasText:'first' — once editing
    // starts, the name span is replaced by an <input>, so the row's text
    // content no longer contains "first" even though nothing failed.
    const row = page.locator('.snapshot-row[data-name="first"]');
    await row.locator('.snapshot-name').dblclick();
    const input = row.locator('.snapshot-name-input');
    await input.fill('second');
    await input.press('Enter');

    await expect(row.locator('.rename-error')).toContainText('second');
  });

  test('deleting a snapshot removes only that row, keeps the domain visible at 0, and keeps other domains open', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#snapshots');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: {
        'a.example.com': { only: { savedAt: new Date().toISOString() } },
        'b.example.com': { other: { savedAt: new Date().toISOString() } },
      },
    }));
    await reloadAndWait(page);

    const domainItems = page.locator('.domain-item');
    await domainItems.nth(0).locator('.domain-header').click();
    await domainItems.nth(1).locator('.domain-header').click();

    await domainItems.nth(0).locator('.btn-icon').click();
    await page.locator('.tk3-btn-confirm').click();

    await expect(domainItems.nth(0).locator('.snapshot-row')).toHaveCount(0);
    await expect(domainItems.nth(0).locator('.domain-count')).toHaveText('0 件');
    await expect(domainItems).toHaveCount(2);
    await expect(domainItems.nth(1)).toHaveClass(/open/);
  });

  test('data-type toggles persist across a reload', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data-types');

    await page.locator('#toggleCookies').uncheck();
    await expect(page.locator('#statusMsg')).toHaveClass(/success/);

    await reloadAndWait(page);
    await expect(page.locator('#toggleCookies')).not.toBeChecked();
  });

  test('export downloads a JSON file containing the stored snapshots', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString(), localStorage: { a: '1' } } } },
    }));
    await reloadAndWait(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportBtn').click(),
    ]);
    const downloadPath = await download.path();
    const fs = await import('node:fs');
    const content = JSON.parse(fs.readFileSync(downloadPath, 'utf-8'));
    expect(content['a.example.com'].first.localStorage).toEqual({ a: '1' });
  });

  test('encrypted export downloads an envelope and re-imports with the passphrase', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data');
    const snapshot = { savedAt: new Date().toISOString(), localStorage: { a: '1' } };
    await page.evaluate(s => chrome.storage.local.set({ snapshots: { 'a.example.com': { first: s } } }), snapshot);
    await reloadAndWait(page);

    await page.locator('#toggleEncryptExports').check();
    await expect(page.locator('#statusMsg')).toHaveClass(/success/);

    await page.locator('#exportBtn').click();
    const dialog = page.locator('dialog.tk3-dialog');
    const fields = dialog.locator('input[type="password"]');
    await fields.nth(0).fill('short');
    await fields.nth(1).fill('short');
    await dialog.locator('.tk3-btn-confirm').click();
    await expect(dialog.locator('.tk3-dialog-error')).toBeVisible();

    await fields.nth(0).fill('correct horse');
    await fields.nth(1).fill('correct horse');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.locator('.tk3-btn-confirm').click(),
    ]);
    const fs = await import('node:fs');
    const text = fs.readFileSync(await download.path(), 'utf-8');
    const envelope = JSON.parse(text);
    expect(envelope[0]).toBe('switch-browser-data-encrypted');
    expect(text).not.toContain('a.example.com');

    await page.evaluate(() => chrome.storage.local.set({ snapshots: {} }));
    await reloadAndWait(page);
    await page.locator('#importFile').setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await dialog.locator('input[type="password"]').fill('correct horse');
    await dialog.locator('.tk3-btn-confirm').click();
    await expect(page.locator('#statusMsg')).toHaveClass(/success/, { timeout: 15_000 });

    const stored = await page.evaluate(() => chrome.storage.local.get('snapshots'));
    expect(stored.snapshots).toEqual({ 'a.example.com': { first: snapshot } });
  });

  test('import conflict "keep both" adds a renamed row', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data');
    const savedAt = new Date().toISOString();
    await page.evaluate(at => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: at } } },
      snapshotOrder: { 'a.example.com': ['first'] },
    }), savedAt);
    await reloadAndWait(page);

    const file = JSON.stringify({ 'a.example.com': { first: { savedAt, localStorage: { b: '2' } } } });
    await page.locator('#importFile').setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(file) });
    const dialog = page.locator('dialog.tk3-dialog');
    await expect(dialog).toContainText('a.example.com / first');
    await dialog.getByRole('button', { name: '両方残す（別名で追加）' }).click();
    await expect(page.locator('#statusMsg')).toHaveClass(/success/);

    await page.locator('.nav-link[data-pane="snapshots"]').click();
    await page.locator('.domain-item .domain-header').click();
    await expect(page.locator('.snapshot-row')).toHaveCount(2);
    await expect(page.locator('.snapshot-row[data-name="first (2)"]')).toBeVisible();
  });

  test('clearing all data empties storage and shows the empty state', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString() } } },
    }));
    await reloadAndWait(page);

    await page.locator('#clearAllBtn').click();
    await page.locator('.tk3-btn-confirm').click();

    await page.locator('.nav-link[data-pane="snapshots"]').click();
    await expect(page.locator('.empty-state')).toBeVisible();
    const stored = await page.evaluate(() => chrome.storage.local.get('snapshots'));
    expect(stored.snapshots ?? {}).toEqual({});
  });

  test('the confirm dialog is a native modal that Esc and clicking outside both cancel', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#data');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString() } } },
    }));
    await reloadAndWait(page);

    const dialog = page.locator('dialog.tk3-dialog');

    await page.locator('#clearAllBtn').click();
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(d => d.matches(':modal'))).toBe(true);
    await expect(page.locator('.tk3-btn-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.locator('#clearAllBtn').click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);

    const stored = await page.evaluate(() => chrome.storage.local.get('snapshots'));
    expect(Object.keys(stored.snapshots)).toEqual(['a.example.com']);
  });

  test('the Enter that confirms an IME conversion does not commit a rename', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId, '#snapshots');
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString() } } },
    }));
    await reloadAndWait(page);

    await page.locator('.domain-item .domain-header').click();
    await page.locator('.snapshot-row .snapshot-name').dblclick();
    const input = page.locator('.snapshot-name-input');
    await input.fill('へんかん');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });

    await expect(input).toBeVisible();
    const stored = await page.evaluate(() => chrome.storage.local.get('snapshots'));
    expect(Object.keys(stored.snapshots['a.example.com'])).toEqual(['first']);
  });
});
