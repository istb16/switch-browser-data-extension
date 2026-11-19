import { test, expect, openPopupFor, readStorage } from './fixtures.js';
import { TEST_PAGE_ORIGIN } from './test-page.js';

// Cookies need the host permission; this copy of the extension has it from install.
test.use({ grantHostPermissions: true });

const loginUrl = user => `${TEST_PAGE_ORIGIN}/cookies/login?user=${user}`;

function row(popup, name) {
  return popup.locator('#snapshotList .snapshot').filter({ has: popup.locator('.snapshot__name', { hasText: name }) });
}

async function saveAs(popup, name) {
  await popup.locator('#saveBtn').click();
  await popup.locator('#newSnapshotName').fill(name);
  await popup.locator('#confirmSaveBtn').click();
  await expect(row(popup, name)).toHaveClass(/is-active/);
}

async function storageGet(page, key) {
  return page.evaluate(k => chrome.storage.local.get(k).then(r => r[k]), key);
}

test('learns the cookie the site rewrites on its own, and still flags an account switch', async ({ context, extensionId }) => {
  const site = await context.newPage();
  await site.goto(loginUrl('alice'));
  await expect(site.locator('h1')).toHaveText('signed in as: alice');

  const popup = await openPopupFor(context, extensionId, site);
  await saveAs(popup, 'alice');
  await site.goto(loginUrl('bob'));
  await expect(site.locator('h1')).toHaveText('signed in as: bob');
  await saveAs(popup, 'bob');
  expect((await readStorage(popup, 'getSnapshotsFor', ['localhost'])).localhost.bob.cookies.map(c => c.name).sort())
    .toEqual(['csrf', 'sid']);

  // Loading reloads the page; the service worker then compares the cookies it
  // finds with those just applied. csrf was rewritten by the server, sid was not.
  await row(popup, 'alice').locator('.snapshot__main').click();
  await expect(site.locator('h1')).toHaveText('signed in as: alice');
  await expect.poll(() => storageGet(popup, 'volatileCookies'), { timeout: 15_000 })
    .toEqual({ localhost: { 'localhost|/|csrf': 'value' } });

  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, site.url());
  expect(await popup.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('al');

  // More loads keep rewriting csrf, which is no longer a change.
  await site.reload();
  await site.reload();
  const unchanged = await openPopupFor(context, extensionId, site);
  await expect(row(unchanged, 'alice')).toHaveClass(/is-active/);
  await unchanged.waitForTimeout(1000);
  await expect(row(unchanged, 'alice').locator('.badge--modified')).toBeHidden();
  await unchanged.close();

  // Signing in as someone else inside the page changes sid's value only.
  await site.goto(loginUrl('bob'));
  await expect(site.locator('h1')).toHaveText('signed in as: bob');
  const switched = await openPopupFor(context, extensionId, site);
  const badge = row(switched, 'alice').locator('.badge--modified');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('title', /Cookie: sid/);
  await expect(badge).not.toHaveAttribute('title', /csrf/);

  // The badge opens a menu; ignoring sid from it clears the flag for good.
  await badge.click();
  const ignore = row(switched, 'alice').locator('.changes-menu [data-action="ignore"]');
  await expect(ignore).toBeVisible();
  await expect(ignore).toContainText('sid');
  await ignore.click();
  await expect(row(switched, 'alice').locator('.badge--modified')).toBeHidden();
  expect(await storageGet(switched, 'volatileCookies'))
    .toEqual({ localhost: { 'localhost|/|csrf': 'value', 'localhost|/|sid': 'value' } });
});

test('does not ask for access once it has been allowed', async ({ context, extensionId }) => {
  const site = await context.newPage();
  await site.goto(loginUrl('alice'));

  const popup = await openPopupFor(context, extensionId, site);

  await expect(popup.locator('#mainContent')).toBeVisible();
  await expect(popup.locator('#permissionPanel')).toBeHidden();
});

test('clearing the site\'s data signs out, and the undo bar signs back in', async ({ context, extensionId }) => {
  const site = await context.newPage();
  await site.goto(loginUrl('alice'));

  const popup = await openPopupFor(context, extensionId, site);
  await popup.locator('#clearSiteBtn').click();
  await popup.locator('.tk3-btn-confirm').click();
  await expect(site.locator('h1')).toHaveText('signed in as: (none)');

  await popup.locator('#undoBtn').click();
  await expect(site.locator('h1')).toHaveText('signed in as: alice');
});

test('restores cookies with the undo bar', async ({ context, extensionId }) => {
  const site = await context.newPage();
  await site.goto(loginUrl('alice'));

  const popup = await openPopupFor(context, extensionId, site);
  await saveAs(popup, 'alice');
  await site.goto(loginUrl('bob'));

  await row(popup, 'alice').locator('.snapshot__main').click();
  await expect(site.locator('h1')).toHaveText('signed in as: alice');

  await popup.locator('#undoBtn').click();
  await expect(site.locator('h1')).toHaveText('signed in as: bob');
});
