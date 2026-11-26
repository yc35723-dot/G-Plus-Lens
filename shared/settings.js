export const SETTINGS_KEY = 'gplens:settings';

export const DEFAULT_SETTINGS = Object.freeze({
  closeOverlayWithPopup: true,
  scrollDuringSelection: true,
  searchInIncognito: false,
});

let settingsWriteQueue = Promise.resolve();

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    closeOverlayWithPopup:
      typeof source.closeOverlayWithPopup === 'boolean'
        ? source.closeOverlayWithPopup
        : DEFAULT_SETTINGS.closeOverlayWithPopup,
    scrollDuringSelection:
      typeof source.scrollDuringSelection === 'boolean'
        ? source.scrollDuringSelection
        : DEFAULT_SETTINGS.scrollDuringSelection,
    searchInIncognito:
      typeof source.searchInIncognito === 'boolean'
        ? source.searchInIncognito
        : DEFAULT_SETTINGS.searchInIncognito,
  };
}

export async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export function writeSettings(patch) {
  const write = async () => {
    const current = await readSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  };
  const pending = settingsWriteQueue.then(write, write);
  settingsWriteQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
