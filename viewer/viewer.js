// View-only: nothing here writes to storage, cookies or the page, which is also
// why migrateStorage() is not called (the popup and options already did).

import { initI18n, t, applyI18n } from '../lib/i18n.js';
import { readKeys, getSnapshotsFor } from '../lib/storage.js';
import { orderedNames } from '../lib/snapshot.js';
import { resolveScope } from '../lib/groups.js';
import { collectData, cookieDomainFor, hasHostPermission } from '../lib/data-bridge.js';
import { isCookieExpired, TYPE_LABELS } from '../lib/data-compare.js';
import { VIEW_TYPES, diffSnapshots, narrowerScope, previewOf } from '../lib/snapshot-diff.js';
import { fillColorChip, memoText } from '../lib/snapshot-view.js';
import { sizeOf, formatBytes } from '../lib/snapshot-summary.js';
import { $ } from '../lib/ui.js';

const ROW_LIMIT = 200;
const PREVIEW_CHARS = 200;
const EXPAND_CHARS = 100000;
const PAGE_TYPES = ['localStorage', 'sessionStorage', 'indexedDB'];
const SNAPSHOT_CHOICE = 'snapshot:';
const STATUS_MARKS = { added: '+', removed: '−', changed: '~', notCompared: '' };
const STATUS_LABELS = {
  added: 'viewer_status_added',
  removed: 'viewer_status_removed',
  changed: 'viewer_status_changed',
  notCompared: 'viewer_status_not_compared',
};

const view = {
  host: null,
  name: null,
  tabId: null,
  snapshot: null,
  snapshots: {},
  scope: null,
  loadScope: null,
  volatile: {},
  plain: null,
  result: null,
  comparing: false,
  reasons: {},
  revealAll: false,
  diffOnly: true,
  compareRun: 0,
  openSections: new Map(),
};

// The value of each rendered value cell; kept out of the DOM so a masked cell
// carries nothing of it in text or attributes.
const cellValues = new WeakMap();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownObject(owner, key) {
  return isObject(owner) && Object.hasOwn(owner, key) && isObject(owner[key]) ? owner[key] : null;
}

function readParams() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  return {
    host: params.get('host'),
    name: params.get('name'),
    tabId: tab !== null && /^\d+$/.test(tab) ? Number(tab) : null,
  };
}

async function init() {
  await initI18n();
  applyI18n();
  $('versionFooter').textContent = t('footer_version', { version: chrome.runtime.getManifest().version });

  const { host, name, tabId } = readParams();
  if (host === null || name === null) return showNotFound();
  const [{ groups, snapshotOrder, volatileCookies }, stored] = await Promise.all([
    readKeys(['groups', 'snapshotOrder', 'volatileCookies']),
    getSnapshotsFor([host]),
  ]);
  const snapshots = ownObject(stored, host);
  const snapshot = snapshots && ownObject(snapshots, name);
  if (!snapshot) return showNotFound();

  const scope = resolveScope(host, groups);
  const loadScope = cookieDomainFor(snapshot, host, scope);
  const plain = diffSnapshots(snapshot, null, { loadScope });
  Object.assign(view, {
    host, name, tabId, snapshot, snapshots, scope, loadScope, plain,
    result: plain,
    volatile: ownObject(volatileCookies, scope.key) ?? {},
  });
  const order = isObject(snapshotOrder) && Object.hasOwn(snapshotOrder, host) && Array.isArray(snapshotOrder[host])
    ? snapshotOrder[host]
    : [];

  renderHeader();
  renderCompareOptions(order);
  // A reload may restore the controls' last state; every open starts masked.
  $('compareSelect').value = 'none';
  $('revealToggle').checked = false;
  $('diffOnlyToggle').checked = true;
  $('compareSelect').addEventListener('change', handleCompareChange);
  $('revealToggle').addEventListener('change', handleRevealToggle);
  $('diffOnlyToggle').addEventListener('change', handleDiffOnlyToggle);
  $('viewer').classList.remove('hidden');
  renderTypes();
}

function showNotFound() {
  $('notFound').classList.remove('hidden');
  $('viewer').classList.add('hidden');
}

function renderHeader() {
  const { snapshot, host, name } = view;
  document.title = `${name} - ${t('viewer_title')}`;
  $('snapshotName').textContent = name;
  $('snapshotHost').textContent = host;
  $('snapshotDate').textContent = t('viewer_saved_at', { date: new Date(snapshot.savedAt).toLocaleString() });
  $('snapshotSize').textContent = formatBytes(sizeOf(snapshot));
  const memo = memoText(snapshot);
  $('snapshotMemo').textContent = memo;
  $('snapshotMemo').classList.toggle('hidden', !memo);
  if (fillColorChip($('snapshotChip'), snapshot.color, 'snapshot-chip')) $('snapshotChip').classList.remove('hidden');
}

function renderCompareOptions(order) {
  const select = $('compareSelect');
  for (const other of orderedNames(view.snapshots, order)) {
    if (other === view.name || !ownObject(view.snapshots, other)) continue;
    const option = document.createElement('option');
    option.value = SNAPSHOT_CHOICE + other;
    option.textContent = other;
    select.appendChild(option);
  }
}

// ── Compare ────────────────────────────────────────────────

function scopeText(scope) {
  return t(scope.exact ? 'viewer_scope_exact' : 'viewer_scope_wide', { domain: scope.domain });
}

function scopeNote(scope, skipped) {
  return t('viewer_note_scope', { scope: scopeText(scope), base: skipped.base, other: skipped.other });
}

function plainCompare() {
  return { result: view.plain, comparing: false, reasons: {}, notes: [] };
}

function compareWithSnapshot(otherName) {
  const other = ownObject(view.snapshots, otherName);
  if (!other) return plainCompare();
  const otherScope = cookieDomainFor(other, view.host, view.scope);
  const compareScope = narrowerScope(view.loadScope, otherScope);
  const result = diffSnapshots(view.snapshot, other, { loadScope: view.loadScope, compareScope });
  const reasons = {};
  const notes = [];
  if (view.plain.cookies && Array.isArray(other.cookies) && !compareScope) {
    reasons.cookies = t('viewer_reason_scope_disjoint');
    notes.push(t('viewer_note_scope_disjoint', { a: scopeText(view.loadScope), b: scopeText(otherScope) }));
  }
  if (result.cookies) notes.push(scopeNote(compareScope, result.cookies.skipped));
  return { result, comparing: true, reasons, notes };
}

function qualifiesAsSiteTab(tab, host) {
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.hostname === host
    && !tab.discarded && tab.status !== 'unloaded'
    && Boolean(tab.incognito) === Boolean(chrome.extension.inIncognitoContext);
}

/**
 * The tab to read the current page data from: { tab }, { incognito: true } when
 * the viewer was opened from a tab of another incognito context (its session is
 * not this one, so nothing may stand in for it), or null.
 */
async function findSiteTab(host, tabParam) {
  if (tabParam !== null) {
    const tab = await chrome.tabs.get(tabParam).catch(() => null);
    if (tab && Boolean(tab.incognito) !== Boolean(chrome.extension.inIncognitoContext)) return { incognito: true };
    if (tab && qualifiesAsSiteTab(tab, host)) return { tab };
  }
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(candidate => qualifiesAsSiteTab(candidate, host));
  return tab ? { tab } : null;
}

async function stillOn(tabId, origin) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab) && qualifiesAsSiteTab(tab, view.host) && new URL(tab.url).origin === origin;
}

async function readCurrent(snapshot) {
  const found = await findSiteTab(view.host, view.tabId);
  if (found?.incognito) {
    return {
      data: {},
      reasons: Object.fromEntries(VIEW_TYPES.map(type => [type, t('viewer_reason_incognito')])),
      notes: [t('viewer_note_incognito')],
    };
  }
  const held = type => (type === 'cookies' ? Array.isArray(snapshot.cookies) : isObject(snapshot[type]));
  const tab = found?.tab ?? null;
  const reasons = {};
  const notes = [];
  if (held('cookies') && !await hasHostPermission(view.scope)) {
    reasons.cookies = t('viewer_reason_no_permission');
    notes.push(t('viewer_note_no_permission'));
  }
  const pageHeld = PAGE_TYPES.filter(held);
  const origin = tab ? new URL(tab.url).origin : null;
  if (tab) notes.push(t('viewer_note_tab', { origin }));
  else if (pageHeld.length) {
    for (const type of pageHeld) reasons[type] = t('viewer_reason_no_tab');
    notes.push(t('viewer_note_no_tab', { host: view.host }));
  }

  // IndexedDB goes in a call of its own: a reply too large to pass would
  // otherwise lose the web storage read with it.
  const read = types => collectData(tab?.id, view.scope, {
    cookies: false, localStorage: false, sessionStorage: false, indexedDB: false, ...types,
  }, { interactive: false, digest: false });
  const [first, second] = await Promise.all([
    read({
      cookies: held('cookies') && !reasons.cookies,
      localStorage: Boolean(tab) && held('localStorage'),
      sessionStorage: Boolean(tab) && held('sessionStorage'),
    }),
    read({ indexedDB: Boolean(tab) && held('indexedDB') }),
  ]);
  const data = { ...first, ...second };
  // The tab may have moved to another site while it was read; its data would
  // then be another site's under this host's name.
  if (tab && pageHeld.length && !await stillOn(tab.id, origin)) {
    for (const type of PAGE_TYPES) delete data[type];
  }
  if (tab) {
    const unreadable = pageHeld.filter(type => !isObject(data[type]));
    for (const type of unreadable) reasons[type] = t('viewer_reason_unreadable');
    if (unreadable.length) {
      notes.push(t('viewer_note_unreadable', { origin, types: unreadable.map(type => TYPE_LABELS[type]).join(', ') }));
    }
  }
  return { data, reasons, notes };
}

async function compareWithCurrent() {
  const { data, reasons, notes } = await readCurrent(view.snapshot);
  const result = diffSnapshots(view.snapshot, data, { loadScope: view.loadScope, compareScope: view.loadScope });
  if (result.cookies) notes.push(scopeNote(view.loadScope, result.cookies.skipped));
  return { result, comparing: true, reasons, notes };
}

async function compareWith(choice) {
  if (choice === 'current') return compareWithCurrent();
  if (choice.startsWith(SNAPSHOT_CHOICE)) return compareWithSnapshot(choice.slice(SNAPSHOT_CHOICE.length));
  return plainCompare();
}

function applyCompare({ result, comparing, reasons, notes }, error = false) {
  Object.assign(view, { result, comparing, reasons });
  const box = $('compareNote');
  box.replaceChildren(...notes.map(text => {
    const line = document.createElement('p');
    line.textContent = text;
    return line;
  }));
  box.classList.toggle('hidden', notes.length === 0);
  box.classList.toggle('error', error);
  $('diffOnlyControl').classList.toggle('hidden', !comparing);
  renderTypes();
}

async function handleCompareChange() {
  const run = ++view.compareRun;
  const choice = $('compareSelect').value;
  try {
    const compare = await compareWith(choice);
    if (run !== view.compareRun) return;
    applyCompare(compare);
  } catch (error) {
    if (run !== view.compareRun) return;
    console.error(error);
    applyCompare({ ...plainCompare(), notes: [t('viewer_error_compare')] }, true);
  }
}

function handleRevealToggle() {
  view.revealAll = $('revealToggle').checked;
  for (const cell of document.querySelectorAll('#types .value')) fillValue(cell, view.revealAll);
}

function handleDiffOnlyToggle() {
  view.diffOnly = $('diffOnlyToggle').checked;
  renderTypes();
}

// ── Rendering ──────────────────────────────────────────────

function textElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function countsElement(counts) {
  const el = document.createElement('span');
  el.className = 'section-counts';
  el.append(
    textElement('span', 'count-added', `+${counts.added}`), ' ',
    textElement('span', 'count-removed', `−${counts.removed}`), ' ',
    textElement('span', 'count-changed', `~${counts.changed}`),
  );
  return el;
}

// Opened and closed state survives re-renders; the body is built on first open.
function section(path, summaryParts, build, openByDefault) {
  const id = JSON.stringify(path);
  const details = document.createElement('details');
  details.className = 'section';
  details.dataset.section = id;
  const summary = document.createElement('summary');
  summary.append(...summaryParts);
  const body = document.createElement('div');
  body.className = 'section-body';
  details.append(summary, body);

  let built = false;
  const buildOnce = () => {
    if (built) return;
    built = true;
    build(body);
  };
  details.open = view.openSections.get(id) ?? openByDefault;
  if (details.open) buildOnce();
  details.addEventListener('toggle', () => {
    view.openSections.set(id, details.open);
    if (details.open) buildOnce();
  });
  return details;
}

function itemCount(type) {
  return type === 'indexedDB' ? view.plain.indexedDB.databases.length : view.plain[type].rows.length;
}

function renderTypes() {
  const container = $('types');
  container.replaceChildren();
  for (const type of VIEW_TYPES) {
    if (!view.plain[type]) continue;
    const compared = view.result[type];
    const reason = view.comparing && !compared ? view.reasons[type] ?? t('viewer_reason_missing') : null;
    const entry = compared ?? view.plain[type];
    const summary = [
      textElement('span', 'section-title', TYPE_LABELS[type]),
      textElement('span', 'section-meta', t('viewer_count', { n: itemCount(type) })),
    ];
    if (reason) summary.push(textElement('span', 'not-comparable', t('viewer_not_comparable', { reason })));
    else if (entry.counts) summary.push(countsElement(entry.counts));
    const build = type === 'indexedDB'
      ? body => buildDatabases(body, entry.databases)
      : body => buildTable(body, type, entry.rows);
    const el = section(['type', type], summary, build, true);
    el.dataset.type = type;
    container.appendChild(el);
  }
}

function keyPathText(keyPath) {
  if (keyPath == null) return '—';
  return Array.isArray(keyPath) ? `[${keyPath.join(', ')}]` : String(keyPath);
}

function schemaText(version, store) {
  return t('viewer_schema', {
    version: version ?? '?',
    keyPath: keyPathText(store.keyPath),
    autoIncrement: String(store.autoIncrement),
  });
}

// A database or store only one side has; the record counts alone can't tell
// this for an empty one.
function sideFlag(entry) {
  if (!view.comparing || !entry.counts || (entry.base && entry.other)) return null;
  const status = entry.base ? 'removed' : 'added';
  const el = document.createElement('span');
  el.className = `section-flag section-${status}`;
  el.append(textElement('span', 'status-mark', STATUS_MARKS[status]), t(STATUS_LABELS[status]));
  return el;
}

function buildDatabases(body, databases) {
  if (databases.length === 0) {
    body.append(textElement('p', 'empty', t('viewer_empty')));
    return;
  }
  for (const db of databases) {
    const info = db.base ?? db.other;
    const summary = [
      textElement('span', 'section-title', db.name),
      textElement('span', 'section-meta', `v${info.version ?? '?'}`),
    ];
    if (db.versionChanged) summary.push(textElement('span', 'section-flag', t('viewer_schema_changed', { schema: `v${db.other.version ?? '?'}` })));
    const side = sideFlag(db);
    if (side) summary.push(side);
    if (db.counts) summary.push(countsElement(db.counts));
    const el = section(['db', db.name], summary, dbBody => buildStores(dbBody, db), true);
    el.dataset.database = db.name;
    body.append(el);
  }
}

function buildStores(body, db) {
  if (db.stores.length === 0) {
    body.append(textElement('p', 'empty', t('viewer_empty')));
    return;
  }
  const version = (db.base ?? db.other).version;
  for (const store of db.stores) {
    const info = store.base ?? store.other;
    const summary = [
      textElement('span', 'section-title', store.name),
      textElement('span', 'section-meta', schemaText(version, info)),
    ];
    if (store.base && store.other && (store.schemaChanged || db.versionChanged)) {
      summary.push(textElement('span', 'section-flag', t('viewer_schema_changed', { schema: schemaText(db.other.version, store.other) })));
    }
    // Inside a database only one side has, the database heading already says so.
    const side = db.base && db.other ? sideFlag(store) : null;
    if (side) summary.push(side);
    if (store.counts) summary.push(countsElement(store.counts));
    const el = section(['store', db.name, store.name], summary, storeBody => buildTable(storeBody, 'record', store.rows), false);
    el.dataset.store = store.name;
    body.append(el);
  }
}

const COLUMNS = {
  cookies: ['viewer_col_name', 'viewer_col_domain', 'viewer_col_path', 'viewer_col_value', 'viewer_col_expires', 'viewer_col_flags'],
  storage: ['viewer_col_key', 'viewer_col_value'],
};

// "違いだけ" filters first, so the row limit counts only the rows it shows.
function buildTable(body, kind, rows) {
  const visible = view.comparing && view.diffOnly
    ? rows.filter(row => row.status !== 'same' && row.status !== 'notCompared')
    : rows;
  if (visible.length === 0) {
    body.append(textElement('p', 'empty', t(rows.length ? 'viewer_no_differences' : 'viewer_empty')));
    return;
  }
  const table = document.createElement('table');
  table.className = 'rows';
  const head = document.createElement('tr');
  const columns = COLUMNS[kind === 'cookies' ? 'cookies' : 'storage'];
  for (const key of view.comparing ? ['viewer_col_status', ...columns] : columns) head.append(textElement('th', null, t(key)));
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more-rows';
  let shown = 0;
  const showMore = () => {
    const next = visible.slice(shown, shown + ROW_LIMIT);
    tbody.append(...next.map(row => buildRow(kind, row)));
    shown += next.length;
    more.textContent = t('viewer_more_rows', { n: visible.length - shown });
    more.classList.toggle('hidden', shown >= visible.length);
  };
  more.addEventListener('click', showMore);
  const scroller = document.createElement('div');
  scroller.className = 'rows-scroll';
  scroller.append(table);
  body.append(scroller, more);
  showMore();
}

function statusCell(status) {
  const td = document.createElement('td');
  td.className = 'cell-status';
  if (STATUS_LABELS[status]) {
    td.append(textElement('span', 'status-mark', STATUS_MARKS[status]), t(STATUS_LABELS[status]));
  }
  return td;
}

function buildRow(kind, row) {
  const tr = document.createElement('tr');
  if (STATUS_LABELS[row.status]) tr.classList.add(`status-${row.status}`);
  if (view.comparing) tr.append(statusCell(row.status));
  if (kind === 'cookies') {
    const { cookie } = row.base ?? row.other;
    tr.append(
      textElement('td', 'cell-mono', String(cookie.name)),
      textElement('td', null, String(cookie.domain)),
      textElement('td', null, String(cookie.path)),
      valuesCell(row),
      textElement('td', null, expiresText(cookie)),
      flagsCell(row, cookie),
    );
  } else {
    tr.append(keyCell(row), valuesCell(row));
  }
  return tr;
}

function keyCell(row) {
  if (row.key === null) return textElement('td', 'cell-mono', t('viewer_no_key'));
  if (!(row.base ?? row.other).maskKey) return textElement('td', 'cell-mono', row.key);
  const td = document.createElement('td');
  td.className = 'cell-mono';
  td.append(valueCell(row.key));
  return td;
}

function expiresText(cookie) {
  return Number.isFinite(cookie.expirationDate)
    ? new Date(cookie.expirationDate * 1000).toLocaleString()
    : t('viewer_session_cookie');
}

function flagsText(cookie) {
  return [cookie.secure && 'Secure', cookie.httpOnly && 'HttpOnly', typeof cookie.sameSite === 'string' && cookie.sameSite]
    .filter(Boolean).join(' ');
}

function tag(textKey, titleKey) {
  const el = textElement('span', 'tag', t(textKey));
  el.title = t(titleKey);
  return el;
}

function flagsCell(row, cookie) {
  const td = document.createElement('td');
  const flags = flagsText(cookie);
  const otherFlags = row.status === 'changed' ? flagsText(row.other.cookie) : flags;
  td.append(flags === otherFlags ? flags : `${flags} → ${otherFlags}`, ' ');
  if (isCookieExpired(cookie, Date.now())) td.append(tag('viewer_tag_expired', 'viewer_tag_expired_title'));
  if (Object.hasOwn(view.volatile, row.key)) td.append(tag('viewer_tag_volatile', 'viewer_tag_volatile_title'));
  if (row.notLoaded) td.append(tag('viewer_tag_not_loaded', 'viewer_tag_not_loaded_title'));
  return td;
}

function valuesCell(row) {
  const td = document.createElement('td');
  if (row.status !== 'changed') {
    td.append(valueCell((row.base ?? row.other).value));
    return td;
  }
  const pair = document.createElement('div');
  pair.className = 'value-pair';
  const after = document.createElement('div');
  after.append(textElement('span', 'value-arrow', '→'), valueCell(row.other.value));
  const before = document.createElement('div');
  before.append(valueCell(row.base.value));
  pair.append(before, after);
  td.append(pair);
  return td;
}

function valueCell(value) {
  const cell = document.createElement('span');
  cell.className = 'value';
  cellValues.set(cell, value);
  fillValue(cell, view.revealAll);
  return cell;
}

function fillValue(cell, revealed) {
  const value = cellValues.get(cell);
  if (!revealed) {
    const mask = document.createElement('button');
    mask.type = 'button';
    mask.className = 'value-mask';
    mask.textContent = `•••••• ${t('viewer_masked', { n: value.length })}`;
    mask.title = t('viewer_reveal_title');
    mask.addEventListener('click', () => fillValue(cell, true));
    cell.replaceChildren(mask);
    return;
  }
  const preview = previewOf(value, PREVIEW_CHARS);
  const text = textElement('span', 'value-text', preview.text);
  cell.replaceChildren(text);
  if (!preview.truncated) return;
  const expand = textElement('button', 'value-expand', t('viewer_expand'));
  expand.type = 'button';
  expand.addEventListener('click', () => {
    const full = previewOf(value, EXPAND_CHARS);
    text.textContent = full.text;
    expand.remove();
    if (full.truncated) cell.append(textElement('span', 'value-capped', t('viewer_expand_capped', { n: EXPAND_CHARS.toLocaleString() })));
  });
  cell.append(expand);
}

// init() attaches the listeners after several awaits; E2E tests wait on this flag.
init().finally(() => document.body.setAttribute('data-ready', 'true'));
