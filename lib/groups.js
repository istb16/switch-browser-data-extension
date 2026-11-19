import { updateKey } from './storage.js';
import { withSnapshotLock } from './snapshot.js';
import { isWithin } from './domain.js';

// Without a public-suffix list, two-label bases such as co.jp or com.au are
// caught by shape: one of these second-level labels followed by a country code.
export const BROAD_SECOND_LABELS = ['co', 'com', 'net', 'org', 'ac', 'go', 'gov', 'edu', 'ne', 'or'];

// Hosting suffixes where every subdomain belongs to a different owner, so one
// cookie scope over them would mix unrelated sites.
export const SHARED_HOST_SUFFIXES = [
  'github.io', 'gitlab.io', 'blogspot.com', 'wordpress.com', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com',
  'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'onrender.com', 'fly.dev',
  'glitch.me', 'ngrok.io', 'ngrok-free.app',
];

export function normalizeGroupDomain(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^(\*|[a-z][a-z0-9+.-]*):\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '');
}

export function validateNewGroup(input, groups) {
  const base = normalizeGroupDomain(input);
  if (base.includes(':') || base.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(base)) return 'ip';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(base)) return 'invalid';
  const labels = base.split('.');
  if (labels.length < 2) return 'single-label';
  if (labels.length === 2 && BROAD_SECOND_LABELS.includes(labels[0]) && /^[a-z]{2}$/.test(labels[1])) return 'registry';
  if (SHARED_HOST_SUFFIXES.includes(base)) return 'shared';
  if (groups.includes(base)) return 'duplicate';
  if (groups.some(group => isWithin(base, group) || isWithin(group, base))) return 'nested';
  return null;
}

export function groupOrigins(base) {
  return [`*://${base}/*`, `*://*.${base}/*`];
}

export function resolveScope(host, groups) {
  const group = groups.find(g => isWithin(host, g)) ?? null;
  if (group) return { key: group, host, group, origins: groupOrigins(group) };
  return { key: host, host, group: null, origins: [`*://${host}/*`] };
}

export function memberHosts(snapshotKeys, scope, groups) {
  const others = snapshotKeys
    .filter(key => key !== scope.host && resolveScope(key, groups).key === scope.key)
    .sort();
  return snapshotKeys.includes(scope.host) ? [scope.host, ...others] : others;
}

export function activeRef(value, key) {
  if (typeof value === 'string') return { host: key, name: value };
  if (value && typeof value === 'object') return value;
  return null;
}

export async function addGroup(input) {
  const base = normalizeGroupDomain(input);
  await updateKey('groups', groups => {
    const error = validateNewGroup(input, groups);
    if (error) throw new Error(error);
    return [...groups, base];
  });
  return base;
}

// A group's active reference names a host; once the group is gone the base key
// is the base host's own scope again, so only a reference to that host survives.
export async function removeGroup(base) {
  await updateKey('groups', groups => groups.filter(group => group !== base));

  await withSnapshotLock(() => updateKey('activeSnapshots', active => {
    const value = active[base];
    if (!value || typeof value !== 'object') return undefined;
    if (value.host === base) active[base] = value.name;
    else delete active[base];
    return active;
  }));
}
