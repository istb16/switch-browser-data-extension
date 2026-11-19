import { test as base, chromium } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const RUNTIME_DIRS = ['manifest.json', '_locales', 'background', 'content', 'icons', 'lib', 'options', 'popup'];

// Reading cookies needs the host permission, which the extension requests at
// runtime through a native Chrome prompt Playwright can't click. For tests that
// cover the cookie path, load a copy whose manifest grants it at install instead.
function copyWithHostPermissions() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tk3-ext-'));
  for (const entry of RUNTIME_DIRS) cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export const test = base.extend({
  grantHostPermissions: [false, { option: true }],

  context: async ({ grantHostPermissions }, use) => {
    const extensionPath = grantHostPermissions ? copyWithHostPermissions() : repoRoot;
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        // Domain cookies on localhost are unreliable, so group tests use
        // example.test hosts that resolve to the local test server.
        '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP example.test 127.0.0.1',
      ],
    });
    await use(context);
    await context.close();
    if (extensionPath !== repoRoot) rmSync(extensionPath, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    // The service worker may already be running before this fixture
    // subscribes, so its `serviceworker` event can't be relied on for the
    // id. Instead read it straight out of chrome://extensions — Playwright's locator engine pierces the
    // (open) shadow roots of <extensions-manager>/<extensions-item-list>
    // automatically, and each <extensions-item>'s `id` attribute IS the
    // extension's id.
    const page = await context.newPage();
    await page.goto('chrome://extensions');
    const id = await page.locator('extensions-item').first().getAttribute('id');
    await page.close();
    await use(id);
  },
});

export const expect = test.expect;

// popup.js / options.js attach their listeners partway through an async init(),
// so buttons present in the static HTML are clickable before they do anything.
// Playwright's auto-waiting can't see that, so wait for the init-done flag
// before any one-shot interaction (click, uncheck, fill) with those buttons.
export async function waitForReady(page) {
  await page.locator('body[data-ready="true"]').waitFor();
}

// Seeds through the extension's own storage module, so tests follow its key
// layout. `page` must be an extension page.
export async function seedSnapshots(page, data, orders = {}) {
  await page.evaluate(async ([snapshots, snapshotOrders]) => {
    const { setSnapshots, setSnapshotOrders } = await import('/lib/storage.js');
    await Promise.all([setSnapshots(snapshots), setSnapshotOrders(snapshotOrders)]);
  }, [data, orders]);
}

// Reads through the extension's storage module; `page` must be an extension page.
export async function readStorage(page, fn, ...args) {
  return page.evaluate(async ([name, rest]) => (await import('/lib/storage.js'))[name](...rest), [fn, args]);
}

export async function reloadAndWait(page) {
  await page.reload();
  await waitForReady(page);
}

// The popup's "current domain" logic reads chrome.tabs.query({active,
// currentWindow}) — but opening popup.html as its own tab makes THAT tab
// active, not the page we actually want to test against. Rather than fake
// the whole tab object (which would break chrome.tabs.sendMessage — a
// fabricated id doesn't correspond to any real tab, so messages to the
// content script would fail to deliver), this narrowly overrides only the
// active-tab resolution, looking up the real tab by URL and returning its
// real id so message passing still reaches the real content script.
export async function openPopupFor(context, extensionId, targetPage) {
  const popup = await context.newPage();
  await popup.addInitScript((targetUrl) => {
    const originalQuery = chrome.tabs.query;
    chrome.tabs.query = async (queryInfo) => {
      if (queryInfo.active && queryInfo.currentWindow) {
        const all = await originalQuery({});
        const match = all.find(t => t.url === targetUrl);
        if (match) return [match];
      }
      return originalQuery(queryInfo);
    };
  }, targetPage.url());
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await waitForReady(popup);
  return popup;
}
