import { t } from '../lib/i18n.js';
import { getSettings, getGroups } from '../lib/storage.js';
import { showConfirm } from '../lib/dialog.js';
import { $, notify, reportError } from '../lib/ui.js';
import { normalizeGroupDomain, validateNewGroup, groupOrigins, addGroup, removeGroup } from '../lib/groups.js';

export async function renderGroups(onChange) {
  const groups = await getGroups();
  const list = $('groupList');
  if (groups.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'group-empty';
    empty.textContent = t('empty_groups');
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...groups.map(group => {
    const li = document.createElement('li');
    li.className = 'group-item';
    li.dataset.group = group;
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group;
    const scope = document.createElement('span');
    scope.className = 'group-scope';
    scope.textContent = `*.${group}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-icon';
    removeBtn.title = t('btn_remove_group_title', { group });
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => handleRemoveGroup(group, onChange));
    li.append(name, scope, removeBtn);
    return li;
  }));
}

export async function handleAddGroup(e, onChange) {
  e.preventDefault();
  const input = $('groupInput');
  try {
    const base = normalizeGroupDomain(input.value);
    const error = validateNewGroup(input.value, await getGroups());
    if (error) {
      notify(`error_group_${error.replace('-', '_')}`, { group: base }, 'error');
      return;
    }
    if (!await showConfirm(t('confirm_add_group', { group: base }))) return;
    const { enabledTypes } = await getSettings();
    const granted = enabledTypes.cookies ? await chrome.permissions.request({ origins: groupOrigins(base) }) : true;
    await addGroup(base);
    input.value = '';
    await renderGroups(onChange);
    await onChange();
    notify(granted ? 'status_group_added' : 'status_group_added_no_permission', { group: base });
  } catch (err) {
    reportError('error_group_failed', err);
  }
}

export async function handleRemoveGroup(base, onChange) {
  try {
    if (!await showConfirm(t('confirm_remove_group', { group: base }))) return;
    await removeGroup(base);
    // *://base/* stays: the base host goes on using it as its own scope.
    await chrome.permissions.remove({ origins: [`*://*.${base}/*`] });
    await renderGroups(onChange);
    await onChange();
    notify('status_group_removed', { group: base });
  } catch (err) {
    reportError('error_group_failed', err);
  }
}
