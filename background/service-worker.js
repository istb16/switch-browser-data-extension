import { readKeys } from '../lib/storage.js';
import { badgeText } from '../lib/badge.js';
import { resolveScope, activeRef } from '../lib/groups.js';
import { getCookiesForDomain, cookiesWithin } from '../lib/cookie-handler.js';
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

const BADGE_KEYS = ['settings', 'activeSnapshots', 'groups'];

let badgeCache = null;

function badgeState() {
  badgeCache ??= readKeys(BADGE_KEYS);
  return badgeCache;
}

async function updateTabs(tabs) {
  const { settings, activeSnapshots: active, groups } = await badgeState();
  await Promise.all(tabs.map(tab => {
    const host = hostnameOf(tab.url);
    const key = host && resolveScope(host, groups).key;
    const text = settings.showBadge && host ? badgeText(activeRef(active[key], key)?.name) : '';
    return chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  }));
}

async function updateAllTabs() {
  await updateTabs(await chrome.tabs.query({}));
}

function setupBadges() {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  updateAllTabs();
}

chrome.runtime.onInstalled.addListener(setupBadges);
chrome.runtime.onStartup.addListener(setupBadges);

// The first page load after a snapshot is applied shows which cookies the site
// rewrites by itself; those are then left out of the popup's change check.
async function checkCookiesAfterLoad(tabId) {
  const check = await takeCookieCheck(tabId);
  // Without the host permission getAll() returns nothing, which would look like
  // every cookie had disappeared.
  if (!check?.origins || !check.cookieDomain || !await hasHostPermission({ origins: check.origins })) return;
  const domain = check.cookieDomain;
  const current = await getCookiesForDomain(domain);
  // A group's permission also reaches the sibling hosts an exact scope leaves out.
  const compared = check.cookieExact ? cookiesWithin(current, { domain, exact: true }) : current;
  await learnVolatileCookies(check.domain, check.cookies, compared);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateTabs([tab]);
  if (changeInfo.status === 'complete') setTimeout(() => checkCookiesAfterLoad(tabId), SETTLE_MS);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !BADGE_KEYS.some(key => changes[key])) return;
  badgeCache = null;
  updateAllTabs();
});
