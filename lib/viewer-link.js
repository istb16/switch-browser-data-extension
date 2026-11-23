export function viewerUrl({ host, name, tabId }) {
  const params = new URLSearchParams({ host, name });
  if (tabId != null) params.set('tab', String(tabId));
  return chrome.runtime.getURL(`viewer/viewer.html?${params}`);
}

export async function openViewer(target) {
  await chrome.tabs.create({ url: viewerUrl(target) });
}
