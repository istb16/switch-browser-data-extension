import { t } from '../lib/i18n.js';
import { $ } from '../lib/ui.js';
import { formatBytes } from '../lib/snapshot-summary.js';
import { getBackupHosts, BACKUP_PREFIX } from '../lib/storage.js';

const METER_DOMAIN_SEGMENTS = 5;
// unlimitedStorage lifts the quota, so the advisory is about speed, not space.
// It is judged on the total getBytesInUse(null), although the popup reads only
// the keys of the hosts it lists.
const METER_ADVISORY_BYTES = 50 * 1024 * 1024;

export async function renderMeter(sizes) {
  const backupKeys = (await getBackupHosts()).map(host => BACKUP_PREFIX + host);
  const [total, backups] = await Promise.all([
    chrome.storage.local.getBytesInUse(null),
    chrome.storage.local.getBytesInUse(backupKeys),
  ]);
  const largest = Object.entries(sizes)
    .map(([domain, { bytes }]) => ({ domain, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.domain.localeCompare(b.domain))
    .slice(0, METER_DOMAIN_SEGMENTS);
  const listed = largest.reduce((sum, d) => sum + d.bytes, 0) + backups;
  const segments = [
    ...largest.map((d, i) => ({ kind: `domain-${i + 1}`, label: d.domain, bytes: d.bytes })),
    { kind: 'backups', label: t('meter_backups'), bytes: backups },
    { kind: 'other',   label: t('meter_other'),   bytes: Math.max(0, total - listed) },
  ];

  $('meterTotal').textContent = formatBytes(total);
  $('meterBar').setAttribute('aria-label', t('meter_label', { size: formatBytes(total) }));
  $('meterBar').replaceChildren(...segments.map(segment => {
    const el = document.createElement('span');
    el.className = `meter-segment meter-segment--${segment.kind}`;
    el.dataset.bytes = String(segment.bytes);
    el.style.width = total > 0 ? `${(segment.bytes / total) * 100}%` : '0';
    el.title = `${segment.label}: ${formatBytes(segment.bytes)}`;
    return el;
  }));
  $('meterLegend').replaceChildren(...segments.map(segment => {
    const li = document.createElement('li');
    li.className = 'meter-legend-item';
    const swatch = document.createElement('span');
    swatch.className = `meter-swatch meter-segment--${segment.kind}`;
    const label = document.createElement('span');
    label.className = 'meter-legend-label';
    label.textContent = segment.label;
    const size = document.createElement('span');
    size.className = 'meter-legend-size';
    size.textContent = formatBytes(segment.bytes);
    li.append(swatch, label, size);
    return li;
  }));
  $('meterAdvisory').classList.toggle('hidden', total < METER_ADVISORY_BYTES);
}
