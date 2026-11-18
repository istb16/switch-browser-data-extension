import { getActiveSnapshots, getSettings } from '../lib/storage.js';
import { badgeText } from '../lib/badge.js';

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateTabs([tab]);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.activeSnapshots || changes.settings)) updateAllTabs();
});
