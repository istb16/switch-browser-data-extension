import { getVolatileCookies, setVolatileCookies, getCookieChecks, setCookieChecks } from './storage.js';
import { findVolatileCookies } from './data-compare.js';

// How long after a load its tab's next page load still counts as the site's own
// doing rather than the user's.
const CHECK_WINDOW_MS = 60_000;

export async function getVolatileCookiesFor(domain) {
  return (await getVolatileCookies())[domain] ?? {};
}

/**
 * Remembers the cookies just applied to a tab, so the service worker can see
 * which ones the site rewrites on the next page load (learnVolatileCookies).
 * `origins` is the permission the check needs and `cookieDomain` the domain the
 * cookies were applied within; the service worker falls back to `domain` alone.
 */
export async function startCookieCheck(tabId, domain, cookies, { origins, cookieDomain } = {}) {
  const now = Date.now();
  const checks = Object.fromEntries(Object.entries(await getCookieChecks()).filter(([, c]) => c.until > now));
  checks[tabId] = { domain, cookies, origins, cookieDomain, until: now + CHECK_WINDOW_MS };
  await setCookieChecks(checks);
}

export async function hasPendingCookieCheck(tabId) {
  const check = (await getCookieChecks())[tabId];
  return Boolean(check && check.until > Date.now());
}

export async function cancelCookieCheck(tabId) {
  await takeCookieCheck(tabId);
}

export async function takeCookieCheck(tabId) {
  const checks = await getCookieChecks();
  const check = checks[tabId];
  if (!check) return null;
  delete checks[tabId];
  await setCookieChecks(checks);
  return check.until > Date.now() ? check : null;
}

async function rememberVolatileCookies(domain, found) {
  const all = await getVolatileCookies();
  const known = all[domain] ?? {};
  for (const [key, kind] of Object.entries(found)) {
    // 'any' (ignore entirely) is the stronger finding and is never downgraded.
    if (known[key] !== 'any') known[key] = kind;
  }
  all[domain] = known;
  await setVolatileCookies(all);
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
