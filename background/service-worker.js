import { getActiveSnapshots, getSettings } from '../lib/storage.js';
import { badgeText } from '../lib/badge.js';
import { getCookiesForDomain } from '../lib/cookie-handler.js';
import { hasHostPermission } from '../lib/data-bridge.js';
import { takeCookieCheck, learnVolatileCookies } from '../lib/volatile-cookies.js';

// Scripts on the page may still set cookies just after the load completes.
const SETTLE_MS = 3000;

// The badge is drawn by the browser, not a page, so it cannot read the --tk-*
// tokens; these are --tk-blue and its text color from lib/tk-base.css.
const BADGE_COLOR = '#1F63D8';
const BADGE_TEXT_COLOR = '#FFFFFF';

function hostnameOf(url) {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

async function updateTabs(tabs) {
  const [settings, active] = await Promise.all([getSettings(), getActiveSnapshots()]);
  await Promise.all(tabs.map(tab => {
    const host = hostnameOf(tab.url);
    const text = settings.showBadge && host ? badgeText(active[host]) : '';
    return chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  }));
}

async function updateAllTabs() {
  await updateTabs(await chrome.tabs.query({}));
}

async function setupBadgeColors() {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
}

chrome.runtime.onInstalled.addListener(() => {
  setupBadgeColors();
  updateAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  setupBadgeColors();
  updateAllTabs();
});

// The first page load after a snapshot is applied shows which cookies the site
// rewrites by itself; those are then left out of the popup's change check.
async function checkCookiesAfterLoad(tabId) {
  const check = await takeCookieCheck(tabId);
  // Without the host permission getAll() returns nothing, which would look like
  // every cookie had disappeared.
  if (!check || !await hasHostPermission(check.domain)) return;
  await learnVolatileCookies(check.domain, check.cookies, await getCookiesForDomain(check.domain));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateTabs([tab]);
  if (changeInfo.status === 'complete') setTimeout(() => checkCookiesAfterLoad(tabId), SETTLE_MS);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.activeSnapshots || changes.settings)) updateAllTabs();
});
