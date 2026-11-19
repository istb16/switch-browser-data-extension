import { t } from '../lib/i18n.js';
import {
  getSnapshots, getSnapshotsFor, setSnapshotsFor, getSettings, getSnapshotOrders, setSnapshotOrders,
} from '../lib/storage.js';
import { withSnapshotLock } from '../lib/snapshot.js';
import { showFormDialog, showChoice } from '../lib/dialog.js';
import { notify, reportError } from '../lib/ui.js';
import { formatBytes } from '../lib/snapshot-summary.js';
import { encryptText, decryptEnvelope } from '../lib/crypto.js';
import { IMPORT_MAX_BYTES, buildExport, exportFileName, parseImport, findConflicts, mergeImport } from '../lib/transfer.js';

const PASSPHRASE_MIN = 8;
const CONFLICT_NAMES_SHOWN = 5;

export function buildExportButton(title, onExport) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-export';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.textContent = '⤓';
  btn.addEventListener('click', e => {
    // The domain header toggles open on click; exporting should not.
    e.stopPropagation();
    onExport(btn);
  });
  return btn;
}

// scope: {} for everything, { domain } or { domain, name }.
export async function handleExport(scope, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const [{ encryptExports }, snapshots] = await Promise.all([
      getSettings(),
      scope.domain ? getSnapshotsFor([scope.domain]) : getSnapshots(),
    ]);
    const text = JSON.stringify(buildExport(snapshots, scope), null, 2);
    if (!encryptExports) {
      downloadExport(text, scope);
      notify('status_exported_plain');
      return;
    }
    const passphrase = await askNewPassphrase();
    if (passphrase === null) return;
    downloadExport(JSON.stringify(await encryptText(text, passphrase)), scope);
    notify('status_exported');
  } catch (e) {
    reportError('error_export_failed', e);
  } finally {
    button.disabled = false;
  }
}

export function downloadExport(text, scope) {
  const blob = new Blob([text], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: exportFileName(scope),
  });
  a.click();
  URL.revokeObjectURL(url);
}

export function passphraseField(labelKey, autocomplete) {
  const label = document.createElement('label');
  const text = document.createElement('span');
  text.textContent = t(labelKey);
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'passphrase-input';
  input.autocomplete = autocomplete;
  label.append(text, input);
  return { label, input };
}

// Resolves the new passphrase, or null when cancelled.
export async function askNewPassphrase() {
  const first = passphraseField('passphrase_label', 'new-password');
  const second = passphraseField('passphrase_confirm_label', 'new-password');
  const hint = document.createElement('p');
  hint.className = 'passphrase-hint';
  hint.textContent = t('hint_passphrase_unrecoverable');
  const content = document.createDocumentFragment();
  content.append(first.label, second.label, hint);

  const confirmed = await showFormDialog({
    title: t('passphrase_new_title'),
    content,
    confirmLabel: t('btn_export_confirm'),
    validate: () => {
      if (first.input.value.length < PASSPHRASE_MIN) return t('error_passphrase_short', { n: PASSPHRASE_MIN });
      if (first.input.value !== second.input.value) return t('error_passphrase_mismatch');
      return null;
    },
  });
  return confirmed ? first.input.value : null;
}

// Resolves the entered passphrase, or null when cancelled.
export async function askPassphrase() {
  const field = passphraseField('passphrase_label', 'current-password');
  const confirmed = await showFormDialog({
    title: t('passphrase_title'),
    content: field.label,
    confirmLabel: t('btn_import_confirm'),
    validate: () => (field.input.value ? null : t('error_enter_passphrase')),
  });
  return confirmed ? field.input.value : null;
}

export async function handleImport(e, onImported) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > IMPORT_MAX_BYTES) {
      notify('error_import_too_large', { size: formatBytes(IMPORT_MAX_BYTES) }, 'error');
      return;
    }
    let parsed = parseImport(await file.text());
    if (parsed.encrypted) {
      const passphrase = await askPassphrase();
      if (passphrase === null) return;
      parsed = parseImport(await decryptEnvelope(parsed.envelope, passphrase), { decrypted: true });
    }

    const hosts = Object.keys(parsed.data);
    const conflicts = findConflicts(await getSnapshotsFor(hosts), parsed.data);
    let strategy = 'skip';
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, CONFLICT_NAMES_SHOWN).map(c => `${c.domain} / ${c.name}`);
      if (conflicts.length > CONFLICT_NAMES_SHOWN) shown.push('…');
      strategy = await showChoice(t('confirm_import_conflicts', { n: conflicts.length, names: shown.join('\n') }), [
        { value: 'overwrite', label: t('choice_overwrite') },
        { value: 'skip',      label: t('choice_skip') },
        { value: 'keepBoth',  label: t('choice_keep_both') },
      ]);
      if (strategy === null) return;
    }

    // Read again after the dialog: the popup may have saved, renamed or deleted
    // snapshots while it was open, and merging into the earlier read would undo that.
    const merged = await withSnapshotLock(async () => {
      const [existing, orders] = await Promise.all([getSnapshotsFor(hosts), getSnapshotOrders()]);
      const result = mergeImport(existing, orders, parsed.data, strategy);
      // One host at a time: each write updates the shared host index.
      for (const host of hosts) await setSnapshotsFor(host, result.snapshots[host]);
      await setSnapshotOrders(result.orders);
      return result;
    });
    await onImported();
    notify('status_imported', merged.counts);
  } catch (err) {
    const wrong = err?.message === 'wrong-passphrase';
    notify(wrong ? 'error_wrong_passphrase' : 'error_import_failed', {}, 'error');
  } finally {
    e.target.value = '';
  }
}
