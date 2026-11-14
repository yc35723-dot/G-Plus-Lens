export const SETTINGS_KEY = 'gplens:settings';

export const DEFAULT_SETTINGS = Object.freeze({
  closeOverlayWithPopup: true,
});

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    closeOverlayWithPopup:
      typeof source.closeOverlayWithPopup === 'boolean'
        ? source.closeOverlayWithPopup
        : DEFAULT_SETTINGS.closeOverlayWithPopup,
  };
}

export async function readSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
