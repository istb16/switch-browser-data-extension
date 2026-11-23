import { getVolatileCookies, getCookieChecks, updateKey } from './storage.js';
import { findVolatileCookies } from './data-compare.js';
import { toCookieScope } from './domain.js';

// How long after a load its tab's next page load still counts as the site's own
// doing rather than the user's.
const CHECK_WINDOW_MS = 60_000;

export async function getVolatileCookiesFor(domain) {
  return (await getVolatileCookies())[domain] ?? {};
}

function scopeOfCheck(check) {
  return { domain: check.cookieDomain, exact: Boolean(check.cookieExact) };
}

// Checks stored before groups carry neither and are discarded.
function isComplete(check) {
  return Boolean(check.origins && check.cookieDomain);
}

// Whether two scopes (see cookiesWithin) share any cookie. An exact scope holds
// only its own host's cookies, so it never meets a sibling or a subdomain.
function overlaps(a, b) {
  if (a.domain === b.domain) return true;
  if (a.domain.endsWith(`.${b.domain}`)) return !b.exact;
  if (b.domain.endsWith(`.${a.domain}`)) return !a.exact;
  return false;
}

/**
 * Remembers the cookies just applied to a tab, so the service worker can see
 * which ones the site rewrites on the next page load (learnVolatileCookies).
 * `origins` is the permission the check needs, and `cookieDomain` / `cookieExact`
 * the scope the cookies were applied within (see cookiesWithin).
 * Every tab of the scope shares the jar, so this load also replaces what other
 * tabs' pending checks expect; those are dropped rather than learning the new
 * cookies as the site's own rewrites.
 * `reloadTabs` are the other tabs ({ id, origin }, see tabsToReload) the service
 * worker reloads once the check has been taken, so their page loads cannot be
 * learned as the site's own.
 */
export async function startCookieCheck(tabId, domain, cookies, { origins, cookieDomain, cookieExact, reloadTabs = [] }) {
  const now = Date.now();
  const check = { domain, cookies, origins, cookieDomain, cookieExact, reloadTabs, until: now + CHECK_WINDOW_MS };
  const scope = scopeOfCheck(check);
  await updateKey('cookieChecks', stored => {
    const checks = Object.fromEntries(Object.entries(stored)
      .filter(([, c]) => c.until > now && isComplete(c) && !overlaps(scopeOfCheck(c), scope)));
    checks[tabId] = check;
    return checks;
  });
}

// Clearing a site empties the jar every tab of its scope sees, so the checks of
// all those tabs are dropped, not only the current tab's. `target` is a domain
// (with its subdomains) or { domain, exact } as for setCookiesForDomain.
export async function cancelCookieChecksFor(target) {
  const scope = toCookieScope(target);
  await updateKey('cookieChecks', checks => {
    const kept = Object.fromEntries(Object.entries(checks).filter(([, c]) => isComplete(c) && !overlaps(scopeOfCheck(c), scope)));
    return Object.keys(kept).length !== Object.keys(checks).length ? kept : undefined;
  });
}

export async function hasPendingCookieCheck(tabId) {
  const check = (await getCookieChecks())[tabId];
  return Boolean(check && isComplete(check) && check.until > Date.now());
}

// A plain tab id from an older version has no origin to check the tab against
// before reloading it, so it is dropped.
function isTabToReload(entry) {
  return Number.isInteger(entry?.id) && typeof entry.origin === 'string';
}

// `check` is null when there is none or it can no longer be used, while
// `reloadTabs` is what it stored either way: those tabs still need the reload.
export async function takeCookieCheck(tabId) {
  let check = null;
  await updateKey('cookieChecks', checks => {
    check = checks[tabId] ?? null;
    if (!check) return undefined;
    delete checks[tabId];
    return checks;
  });
  const reloadTabs = Array.isArray(check?.reloadTabs) ? check.reloadTabs.filter(isTabToReload) : [];
  return { check: check && isComplete(check) && check.until > Date.now() ? check : null, reloadTabs };
}

async function rememberVolatileCookies(domain, found) {
  await updateKey('volatileCookies', all => {
    const known = all[domain] ?? {};
    for (const [key, kind] of Object.entries(found)) {
      // 'any' (ignore entirely) is the stronger finding and is never downgraded.
      if (known[key] !== 'any') known[key] = kind;
    }
    all[domain] = known;
    return all;
  });
}

export async function learnVolatileCookies(domain, applied, current) {
  const found = findVolatileCookies(applied, current);
  if (Object.keys(found).length > 0) await rememberVolatileCookies(domain, found);
}

// The user's own call from the popup: a changed value stops being compared, and
// a cookie that came or went stops being looked at at all.
export async function ignoreCookieChange(domain, change) {
  await rememberVolatileCookies(domain, { [change.key]: change.kind === 'value' ? 'value' : 'any' });
}
