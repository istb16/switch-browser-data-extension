import { test, expect, openPopupFor, reloadAndWait } from './fixtures.js';
import { TEST_PAGE_PORT } from './test-page.js';

// Group cookies need the wildcard host permission; this copy has <all_urls> from install.
test.use({ grantHostPermissions: true });

const origin = host => `http://${host}:${TEST_PAGE_PORT}`;
const APP = origin('app.example.test');
const WWW = origin('www.example.test');

function row(popup, name) {
  return popup.locator('#snapshotList .snapshot').filter({ has: popup.locator('.snapshot__name', { hasText: name }) });
}

async function saveAs(popup, name) {
  await popup.locator('#saveBtn').click();
  await popup.locator('#newSnapshotName').fill(name);
  await popup.locator('#confirmSaveBtn').click();
  await expect(row(popup, name)).toHaveClass(/is-active/);
}

async function addGroupFromOptions(context, extensionId, base) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html#snapshots`);
  await page.evaluate(() => chrome.storage.local.set({ language: 'ja' }));
  await reloadAndWait(page);
  await page.locator('#groupInput').fill(base);
  await page.locator('#addGroupBtn').click();
  const dialog = page.locator('dialog');
  await expect(dialog).toContainText(`*.${base}`);
  await dialog.locator('.tk3-btn-confirm').click();
  await expect(page.locator(`#groupList .group-item[data-group="${base}"]`)).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.local.get('groups').then(r => r.groups))).toEqual([base]);
  await page.close();
}

test('fixture self-check: example.test hosts reach the test server and the wildcard permission is granted', async ({ context, extensionId }) => {
  const page = await context.newPage();
  for (const url of [`${APP}/`, `${WWW}/`]) {
    await page.goto(url);
    await expect(page.locator('h1')).toHaveText('tk3 e2e test page');
  }

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
  expect(await ext.evaluate(() => chrome.permissions.contains({ origins: ['*://*.example.test/*'] }))).toBe(true);
});

test('a snapshot saved on app.example.test restores the .example.test cookie on www.example.test', async ({ context, extensionId }) => {
  await addGroupFromOptions(context, extensionId, 'example.test');

  const app = await context.newPage();
  await app.goto(`${APP}/group/login?user=alice`);
  await expect(app.locator('h1')).toHaveText('group user: alice');
  const appPopup = await openPopupFor(context, extensionId, app);
  await saveAs(appPopup, 'alice');
  await appPopup.close();

  // The domain cookie is shared, so signing in as bob on app shows on www too.
  await app.goto(`${APP}/group/login?user=bob`);
  await expect(app.locator('h1')).toHaveText('group user: bob');
  const www = await context.newPage();
  await www.goto(`${WWW}/group/`);
  await expect(www.locator('h1')).toHaveText('group user: bob');

  const wwwPopup = await openPopupFor(context, extensionId, www);
  await row(wwwPopup, 'alice').locator('.snapshot__main').click();
  await expect(wwwPopup.locator('#statusMsg')).toHaveClass(/success/);
  await expect(www.locator('h1')).toHaveText('group user: alice');

  const cookies = await wwwPopup.evaluate(() => chrome.cookies.getAll({ domain: 'example.test' }));
  expect(cookies.filter(c => c.name === 'gsid').map(c => [c.domain, c.value])).toEqual([['.example.test', 'alice']]);
});

// Every cookie of the group, as "domain:name=value", read from an extension page.
function groupJar(extensionPage) {
  return extensionPage.evaluate(async () => (await chrome.cookies.getAll({ domain: 'example.test' }))
    .map(c => `${c.domain}:${c.name}=${c.value}`)
    .sort());
}

function setCookies(extensionPage, cookies) {
  return extensionPage.evaluate(list => Promise.all(list.map(c => chrome.cookies.set(c))), cookies);
}

test('loading a group snapshot leaves one gsid when a host-only and a domain gsid both exist', async ({ context, extensionId }) => {
  await addGroupFromOptions(context, extensionId, 'example.test');

  const app = await context.newPage();
  await app.goto(`${APP}/group/login?user=alice`);
  await expect(app.locator('h1')).toHaveText('group user: alice');
  const popup = await openPopupFor(context, extensionId, app);
  await saveAs(popup, 'alice');

  // A stale host-only cookie of the same name, a newer domain cookie, and a sibling host's cookie.
  await setCookies(popup, [
    { url: `${APP}/`, name: 'gsid', value: 'stale-host', path: '/' },
    { url: `${APP}/`, name: 'gsid', value: 'bob', domain: 'example.test', path: '/' },
    { url: `${WWW}/`, name: 'wonly', value: 'w', path: '/' },
  ]);
  expect(await groupJar(popup)).toEqual([
    '.example.test:gsid=bob', 'app.example.test:gsid=stale-host', 'www.example.test:wonly=w',
  ]);

  // The save already left a success status, so poll the jar rather than the message.
  await row(popup, 'alice').locator('.snapshot__main').click();
  await expect.poll(() => groupJar(popup)).toEqual(['.example.test:gsid=alice']);
  await expect(app.locator('h1')).toHaveText('group user: alice');
});

test('clearing a group site removes every cookie of the group, and undo brings them back', async ({ context, extensionId }) => {
  await addGroupFromOptions(context, extensionId, 'example.test');

  const www = await context.newPage();
  await www.goto(`${WWW}/group/login?user=alice`);
  await expect(www.locator('h1')).toHaveText('group user: alice');
  const popup = await openPopupFor(context, extensionId, www);
  await setCookies(popup, [
    { url: `${APP}/`, name: 'aonly', value: 'a', path: '/' },
    { url: `${WWW}/`, name: 'wonly', value: 'w', path: '/' },
  ]);
  const before = ['.example.test:gsid=alice', 'app.example.test:aonly=a', 'www.example.test:wonly=w'];
  expect(await groupJar(popup)).toEqual(before);

  await popup.locator('#clearSiteBtn').click();
  await popup.locator('.tk3-btn-confirm').click();
  await expect(popup.locator('#statusMsg')).toHaveClass(/success/);
  await expect(www.locator('h1')).toHaveText('group user: (none)');
  expect(await groupJar(popup)).toEqual([]);

  await popup.locator('#undoBtn').click();
  await expect(www.locator('h1')).toHaveText('group user: alice');
  await expect.poll(() => groupJar(popup)).toEqual(before);
});

test('localStorage saved on app is not written to www', async ({ context, extensionId }) => {
  await addGroupFromOptions(context, extensionId, 'example.test');

  const app = await context.newPage();
  await app.goto(`${APP}/`);
  await app.evaluate(() => localStorage.setItem('greeting', 'from-app'));
  const appPopup = await openPopupFor(context, extensionId, app);
  await saveAs(appPopup, 'app-state');
  await appPopup.close();

  const www = await context.newPage();
  await www.goto(`${WWW}/`);
  await www.evaluate(() => {
    localStorage.setItem('greeting', 'www-own');
    window.notReloaded = true;
  });

  const wwwPopup = await openPopupFor(context, extensionId, www);
  await row(wwwPopup, 'app-state').locator('.snapshot__main').click();
  await expect(wwwPopup.locator('#statusMsg')).toHaveClass(/success/);
  await expect(row(wwwPopup, 'app-state')).toHaveClass(/is-active/);

  await expect.poll(() => www.evaluate(() => window.notReloaded ?? false).catch(() => null)).toBe(false);
  expect(await www.evaluate(() => localStorage.getItem('greeting'))).toBe('www-own');
  expect(await app.evaluate(() => localStorage.getItem('greeting'))).toBe('from-app');
});
