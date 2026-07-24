import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // This extension has no background service worker (cookie access
    // happens directly from extension pages), so there's no
    // `serviceworker` event to read the id off. Instead read it straight
    // out of chrome://extensions — Playwright's locator engine pierces the
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
  return popup;
}
