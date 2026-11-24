export function isWithin(host, base) {
  return host === base || host.endsWith(`.${base}`);
}

// The parsed URL when it is http(s), otherwise null.
export function parseHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

// The hostname of an http(s) URL, otherwise null.
export function httpHostOf(url) {
  return parseHttpUrl(url)?.hostname ?? null;
}

// `target` is a domain, which takes in its subdomains too, or { domain, exact }
// where exact: true keeps only the host's own cookies (`host` and `.host`), which
// is all the host permission of that host alone can capture.
export function toCookieScope(target) {
  return typeof target === 'string'
    ? { domain: target, exact: false }
    : { domain: target.domain, exact: Boolean(target.exact) };
}

// Whether every cookie of the scope `inner` also lies in `outer` (both
// { domain, exact }); a scope without `exact` is read as wide.
export function isScopeWithin(inner, outer) {
  return outer.exact
    ? Boolean(inner.exact) && inner.domain === outer.domain
    : isWithin(inner.domain, outer.domain);
}
