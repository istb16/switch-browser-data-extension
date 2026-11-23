import { readKeys, getSnapshotsFor, SNAPSHOT_PREFIX } from '../lib/storage.js';
import { badgeText, badgeColors, labelColorsOf } from '../lib/badge.js';
import { resolveScope, activeRef } from '../lib/groups.js';
import { getCookiesForDomain, cookiesWithin } from '../lib/cookie-handler.js';
import { hasHostPermission } from '../lib/data-bridge.js';
import { takeCookieCheck, learnVolatileCookies } from '../lib/volatile-cookies.js';
import { reloadTabsStillOn } from '../lib/site-tabs.js';

// Scripts on the page may still set cookies just after the load completes.
const SETTLE_MS = 3000;

function hostnameOf(url) {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

const BADGE_KEYS = ['settings', 'activeSnapshots', 'groups'];

let badgeCache = null;
let badgeGeneration = 0;

function badgeState() {
  if (!badgeCache) {
    const read = readKeys(BADGE_KEYS);
    badgeCache = read;
    // A failed read would otherwise stay cached until a badge key changes.
    read.catch(() => {
      if (badgeCache === read) badgeCache = null;
    });
  }
  return badgeCache;
}

function invalidateBadgeState() {
  badgeGeneration++;
  badgeCache = null;
}

// Only the name → label map of each host read in this worker's life is kept,
// never the snapshots themselves, which hold the site's cookies.
const labelColors = new Map();
const colorReads = new Map();

function readLabelColors(host) {
  if (!colorReads.has(host)) {
    const read = getSnapshotsFor([host]).then(stored => labelColorsOf(stored[host]));
    // A change event drops the read it outdates, so only a read still listed may store.
    const settle = colors => {
      if (colorReads.get(host) !== read) return;
      colorReads.delete(host);
      if (colors) labelColors.set(host, colors);
    };
    read.then(settle, () => settle(null));
    colorReads.set(host, read);
  }
  return colorReads.get(host);
}

// The colour is best-effort: a failed read must not keep the badge text from being drawn.
async function colorFor(ref) {
  try {
    const colors = labelColors.get(ref.host) ?? await readLabelColors(ref.host);
    return badgeColors(colors.get(ref.name));
  } catch (error) {
    console.error(error);
    return badgeColors();
  }
}

function sameColors(a, b) {
  return a.size === b.size && [...a].every(([name, color]) => b.get(name) === color);
}

// Returns whether a drawn colour may be out of date. Hosts not read yet are left
// for their next draw to read.
function applyColorChanges(changes) {
  let changed = false;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(SNAPSHOT_PREFIX)) continue;
    const host = key.slice(SNAPSHOT_PREFIX.length);
    if (colorReads.delete(host)) changed = true;
    if (!labelColors.has(host)) continue;
    const colors = change.newValue === undefined ? new Map() : labelColorsOf(change.newValue);
    if (!sameColors(labelColors.get(host), colors)) changed = true;
    if (change.newValue === undefined) labelColors.delete(host);
    else labelColors.set(host, colors);
  }
  return changed;
}

// The newest draw of each tab. A tab that navigates while an older draw is still
// reading would otherwise be overwritten with the badge of the page it left.
// One counter for all tabs, so a number freed below is never handed out again.
let drawCount = 0;
const latestDraws = new Map();

async function updateTabs(tabs) {
  const generation = badgeGeneration;
  const draws = new Map(tabs.map(tab => [tab.id, ++drawCount]));
  for (const [tabId, draw] of draws) latestDraws.set(tabId, draw);
  const newest = new Set();
  let badges;
  try {
    const { settings, activeSnapshots: active, groups } = await badgeState();
    badges = await Promise.all(tabs.map(async tab => {
      const host = hostnameOf(tab.url);
      const key = host && resolveScope(host, groups).key;
      const ref = settings.showBadge && host ? activeRef(active[key], key) : null;
      return { tabId: tab.id, text: badgeText(ref?.name), colors: ref ? await colorFor(ref) : badgeColors() };
    }));
  } finally {
    for (const [tabId, draw] of draws) {
      if (latestDraws.get(tabId) !== draw) continue;
      newest.add(tabId);
      latestDraws.delete(tabId);
    }
  }
  // A badge key or a label changed while this draw was reading; the update started
  // by that change draws every tab, and this older state must not overwrite it.
  if (generation !== badgeGeneration) return;
  await Promise.all(badges.filter(({ tabId }) => newest.has(tabId)).map(({ tabId, text, colors }) => Promise.all([
    chrome.action.setBadgeText({ tabId, text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color: colors.background }).catch(() => {}),
    chrome.action.setBadgeTextColor({ tabId, color: colors.text }).catch(() => {}),
  ])));
}

async function updateAllTabs() {
  await updateTabs(await chrome.tabs.query({}));
}

function setupBadges() {
  const { background, text } = badgeColors();
  chrome.action.setBadgeBackgroundColor({ color: background });
  chrome.action.setBadgeTextColor({ color: text });
  updateAllTabs().catch(console.error);
}

chrome.runtime.onInstalled.addListener(setupBadges);
chrome.runtime.onStartup.addListener(setupBadges);

// The first page load after a snapshot is applied shows which cookies the site
// rewrites by itself; those are then left out of the popup's change check.
async function learnFromCheck(check) {
  // Without the host permission getAll() returns nothing, which would look like
  // every cookie had disappeared.
  if (!check?.origins || !check.cookieDomain || !await hasHostPermission({ origins: check.origins })) return;
  const domain = check.cookieDomain;
  const current = await getCookiesForDomain(domain);
  // A group's permission also reaches the sibling hosts an exact scope leaves out.
  const compared = check.cookieExact ? cookiesWithin(current, { domain, exact: true }) : current;
  await learnVolatileCookies(check.domain, check.cookies, compared);
}

// The site's other tabs are reloaded only after learning: on load they may write
// the previous account's cookies back, which must not be learned as the site's own.
async function checkCookiesAfterLoad(tabId) {
  const { check, reloadTabs: others } = await takeCookieCheck(tabId);
  try {
    await learnFromCheck(check);
  } finally {
    await reloadTabsStillOn(others);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateTabs([tab]).catch(console.error);
  if (changeInfo.status === 'complete') setTimeout(() => checkCookiesAfterLoad(tabId).catch(console.error), SETTLE_MS);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const colorsChanged = applyColorChanges(changes);
  if (BADGE_KEYS.some(key => changes[key])) invalidateBadgeState();
  else if (colorsChanged) badgeGeneration++;
  else return;
  updateAllTabs().catch(console.error);
});
