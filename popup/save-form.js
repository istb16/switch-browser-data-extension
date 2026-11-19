import { t } from '../lib/i18n.js';
import { SNAPSHOT_COLORS, MEMO_MAX } from '../lib/snapshot-summary.js';
import { $ } from '../lib/ui.js';

export function openSaveForm() {
  $('saveBtn').classList.add('hidden');
  $('saveForm').classList.remove('hidden');
  $('newSnapshotName').focus();
}

export function closeSaveForm() {
  $('saveForm').classList.add('hidden');
  $('saveBtn').classList.remove('hidden');
  $('newSnapshotName').value = '';
  $('newSnapshotMemo').value = '';
  $('saveForm').querySelector('input[name="newSnapshotColor"][value=""]').checked = true;
  $('saveBtn').focus();
}

// Only what the user filled in, so saving over an existing name keeps the
// memo and colour it already has.
export function saveFormDetails() {
  const details = {};
  const memo = $('newSnapshotMemo').value.trim();
  const color = $('saveForm').querySelector('input[name="newSnapshotColor"]:checked')?.value;
  if (memo) details.memo = memo;
  if (color) details.color = color;
  return details;
}

export function buildDetailFields({ memo, color }) {
  const content = document.createDocumentFragment();

  const memoLabel = document.createElement('label');
  const memoInput = document.createElement('input');
  memoInput.type = 'text';
  memoInput.className = 'detail-memo';
  memoInput.autocomplete = 'off';
  memoInput.maxLength = MEMO_MAX;
  memoInput.value = typeof memo === 'string' ? memo : '';
  memoLabel.append(t('memo_label'), memoInput);

  const swatches = document.createElement('fieldset');
  swatches.className = 'swatches';
  const legend = document.createElement('legend');
  legend.className = 'swatches__legend';
  legend.textContent = t('color_label');
  swatches.append(legend);
  const current = SNAPSHOT_COLORS.includes(color) ? color : '';
  for (const value of ['', ...SNAPSHOT_COLORS]) {
    const text = t(value ? `color_${value}` : 'color_none');
    const label = document.createElement('label');
    label.className = `swatch swatch--${value || 'none'}`;
    label.title = text;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'editSnapshotColor';
    radio.value = value;
    radio.checked = value === current;
    const hidden = document.createElement('span');
    hidden.className = 'tk-visually-hidden';
    hidden.textContent = text;
    label.append(radio, hidden);
    swatches.append(label);
  }

  content.append(memoLabel, swatches);
  return {
    content,
    read: () => ({
      memo: memoInput.value,
      color: swatches.querySelector('input:checked')?.value,
    }),
  };
}
