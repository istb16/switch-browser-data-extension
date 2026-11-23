import { t, getLang } from '../lib/i18n.js';
import { cookieDomainFor } from '../lib/data-bridge.js';
import { cookiesWithin } from '../lib/cookie-handler.js';
import { TYPE_LABELS } from '../lib/data-compare.js';

export const state = {
  // See resolveScope() in lib/groups.js: `host` is the tab's host, `key` the group
  // base (or the host outside a group).
  scope: null,
  groups: [],
  activeTab: null,
  settings: null,
  // Snapshots of every listed host: { host: { name: snapshot } }.
  snapshots: {},
  // The listed rows, { host, name }; in a group they come from every member host.
  entries: [],
  // Per-entry summarize() results, computed once per refresh rather than per render,
  // since search re-renders on every keystroke.
  summaries: new Map(),
  // { host, name }, plus `types` (see recordedTypes) when only some types of it
  // were loaded; null when no listed snapshot is active.
  activeEntry: null,
  // This host's backup, or null when there is none or automatic backups are off.
  backup: null,
  // What differs from the active snapshot (see findChanges); empty when nothing does.
  changes: [],
  busy: false,
  // Bumped by every action that changes the page data or the active snapshot, so a
  // change check that started before it can tell its result is stale.
  dataVersion: 0,
};

export const entryId = entry => `${entry.host}\n${entry.name}`;
export const sameEntry = (a, b) => Boolean(a && b && a.host === b.host && a.name === b.name);
export const snapshotOf = entry => state.snapshots[entry.host]?.[entry.name];
export const entryOfRow = row => ({ host: row.dataset.host, name: row.dataset.name });

// In a group the active snapshot is one reference for every member host, so it
// has to say which host's snapshot it is.
export function activeValue(entry) {
  if (entry.types) return { host: entry.host, name: entry.name, types: entry.types };
  return state.scope.group ? { host: entry.host, name: entry.name } : entry.name;
}

// The types a partial load recorded; undefined stands for every type, which is
// also how a value an older or damaged record holds is read.
export function recordedTypes(value) {
  if (!Array.isArray(value?.types)) return undefined;
  const types = Object.keys(TYPE_LABELS).filter(type => value.types.includes(type));
  return types.length ? types : undefined;
}

export function comparedTypes(types) {
  const { enabledTypes } = state.settings;
  if (!types) return enabledTypes;
  return Object.fromEntries(Object.keys(TYPE_LABELS).map(type => [type, Boolean(enabledTypes[type]) && types.includes(type)]));
}

export function typeNamesOf(types) {
  return types.map(type => TYPE_LABELS[type]).join(getLang() === 'ja' ? '・' : ', ');
}

export function loadableTypes(entry) {
  const snapshot = snapshotOf(entry);
  return Object.keys(TYPE_LABELS).filter(type => state.settings.enabledTypes[type] && Boolean(snapshot?.[type]));
}

export function scopeLabel() {
  const { scope } = state;
  return scope.group ? t('scope_label_group', { host: scope.host, group: scope.group }) : scope.host;
}

// What of `data` this entry's snapshot can be compared on here: the cookies it
// was captured with (never wider than this scope), and page data only when it
// was saved on this host, since that is all a load of it applies.
export function comparable(entry, data) {
  const result = { ...data };
  if (data.cookies) result.cookies = cookiesWithin(data.cookies, cookieDomainFor(snapshotOf(entry), entry.host, state.scope));
  if (entry.host !== state.scope.host) {
    for (const type of ['localStorage', 'sessionStorage', 'indexedDB', 'indexedDBDigest']) delete result[type];
  }
  return result;
}
