import { test, expect, reloadAndWait } from './fixtures.js';

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
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

  test('shows the empty state when there are no snapshots', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await expect(page.locator('.empty-state')).toBeVisible();
  });

  test('renaming a snapshot updates it in place without collapsing other open domains', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);

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
    const page = await openOptions(context, extensionId);
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
    const page = await openOptions(context, extensionId);
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
    const page = await openOptions(context, extensionId);

    await page.locator('#toggleCookies').uncheck();
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#statusMsg')).toHaveClass(/success/);

    await reloadAndWait(page);
    await expect(page.locator('#toggleCookies')).not.toBeChecked();
  });

  test('export downloads a JSON file containing the stored snapshots', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
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

  test('clearing all data empties storage and shows the empty state', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await page.evaluate(() => chrome.storage.local.set({
      snapshots: { 'a.example.com': { first: { savedAt: new Date().toISOString() } } },
    }));
    await reloadAndWait(page);

    await page.locator('#clearAllBtn').click();
    await page.locator('.tk3-btn-confirm').click();

    await expect(page.locator('.empty-state')).toBeVisible();
    const stored = await page.evaluate(() => chrome.storage.local.get('snapshots'));
    expect(stored.snapshots ?? {}).toEqual({});
  });

  test('the confirm dialog is a native modal that Esc and clicking outside both cancel', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
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
    const page = await openOptions(context, extensionId);
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
