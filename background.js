import { normalizeLang } from './shared/lens.js';
import { computePopupBounds } from './shared/window.js';
import { computeCrop } from './shared/geometry.js';
import { pickLargestImage } from './shared/target.js';
import { readSettings } from './shared/settings.js';

const PENDING_KEY = 'gplens:pending';
const SHOTS_KEY = 'gplens:shots';
const POPUP_KEY = 'gplens:popup';
const MENU_PAGE = 'gplens-page';
const MENU_IMAGE = 'gplens-image';
const VIEWER_PATH = 'viewer/viewer.html';
const HOST_ID = 'gplens-overlay-host';
const MIN_SELECTION = 12;

const t = (name) => chrome.i18n.getMessage(name) || name;

function rebuildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: t('menuSearch'),
      contexts: ['page', 'selection', 'link', 'frame', 'video', 'audio', 'editable'],
    });
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      title: t('menuSearchImage'),
      contexts: ['image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(rebuildMenus);
chrome.runtime.onStartup.addListener(rebuildMenus);
rebuildMenus();

chrome.action.onClicked.addListener((tab) => {
  startFreeze(tab).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_IMAGE) {
    searchImage(tab, info).catch(() => startFreeze(tab).catch(() => {}));
    return;
  }
  if (info.menuItemId === MENU_PAGE) startFreeze(tab).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return false;

  if (msg.type === 'gplens:selection' && msg.rect && msg.basis) {
    const tab = sender.tab;
    finishSelection(tab, msg).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error) }),
    );
    return true;
  }

  if (msg.type === 'gplens:cancel') {
    const tabId = sender.tab?.id;
    (async () => {
      if (Number.isInteger(tabId)) await dropShot(tabId);
      respond({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropShot(tabId).catch(() => {});
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  let isPopup = false;
  try {
    const stored = await chrome.storage.session.get(POPUP_KEY);
    isPopup = stored[POPUP_KEY]?.windowId === windowId;
    if (isPopup) await chrome.storage.session.remove([PENDING_KEY, POPUP_KEY]);
  } catch {
    /* session storage resets when the worker restarts */
  }
  if (!isPopup) return;
  if (!(await shouldCloseOverlays())) return;
  await closeAllOverlays();
});

async function shouldCloseOverlays() {
  const settings = await readSettings();
  return settings.closeOverlayWithPopup;
}

function isScriptable(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

async function hasOverlay(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (id) => Boolean(document.getElementById(id)),
      args: [HOST_ID],
    });
    return Boolean(result?.result);
  } catch {
    return true;
  }
}

async function captureShot(tab) {
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    return null;
  }
}

async function readShots() {
  try {
    const stored = await chrome.storage.session.get(SHOTS_KEY);
    const value = stored[SHOTS_KEY];
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function saveShot(tabId, shot) {
  if (!Number.isInteger(tabId)) return;
  try {
    const shots = await readShots();
    shots[tabId] = { shot, at: Date.now() };
    await chrome.storage.session.set({ [SHOTS_KEY]: shots });
  } catch {
    /* storage may be unavailable */
  }
}

async function readShot(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const shots = await readShots();
  return shots[tabId]?.shot || null;
}

async function dropShot(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const shots = await readShots();
    if (!shots[tabId]) return;
    delete shots[tabId];
    if (Object.keys(shots).length) {
      await chrome.storage.session.set({ [SHOTS_KEY]: shots });
    } else {
      await chrome.storage.session.remove(SHOTS_KEY);
    }
  } catch {
    /* storage may be unavailable */
  }
}

async function startFreeze(tab) {
  if (!tab || tab.id == null || !isScriptable(tab.url)) return;
  if (await hasOverlay(tab.id)) return;

  const shot = await captureShot(tab);
  if (!shot) return;

  await saveShot(tab.id, shot);

  const init = { shot, messages: { close: t('overlayClose') } };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (cfg) => {
        globalThis.__GPLENS_INIT__ = cfg;
      },
      args: [init],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js'],
    });
  } catch {
    await dropShot(tab.id);
  }
}

async function closeOverlay(tabId) {
  let delivered = false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'gplens:close' });
    delivered = true;
  } catch {
    delivered = false;
  }

  if (!delivered) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (id) => {
          const host = document.getElementById(id);
          if (host) host.remove();
        },
        args: [HOST_ID],
      });
    } catch {
      /* the tab is gone or not scriptable */
    }
  }

  await dropShot(tabId);
}

async function closeAllOverlays() {
  const shots = await readShots();
  const tabIds = Object.keys(shots)
    .map((key) => Number(key))
    .filter((id) => Number.isInteger(id));
  await Promise.all(tabIds.map((tabId) => closeOverlay(tabId)));
}

async function finishSelection(tab, selection) {
  const tabId = tab?.id;
  const source = (await readShot(tabId)) || (await captureShot(tab));
  if (!source) return;
  const dataUrl = await cropShot(source, selection.rect, selection.basis.w, selection.basis.h);
  if (!dataUrl) return;
  await openViewer(dataUrl);
}

async function searchImage(tab, info) {
  if (!info.srcUrl || (info.frameId ?? 0) !== 0) {
    await startFreeze(tab);
    return;
  }

  const shot = await captureShot(tab);
  if (!shot) return;

  const [measured] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const descriptors = Array.from(document.images).map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          src: node.src,
          currentSrc: node.currentSrc,
          naturalWidth: node.naturalWidth,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          visible:
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity) > 0,
        };
      });
      return { descriptors, vw: window.innerWidth, vh: window.innerHeight };
    },
  });

  const rect = pickLargestImage(
    measured?.result?.descriptors,
    info.srcUrl,
    measured?.result?.vw ?? 0,
    measured?.result?.vh ?? 0,
  );
  if (!rect || rect.w < MIN_SELECTION || rect.h < MIN_SELECTION) {
    await startFreeze(tab);
    return;
  }

  const dataUrl = await cropShot(shot, rect, measured.result.vw, measured.result.vh);
  if (!dataUrl) {
    await startFreeze(tab);
    return;
  }
  await openViewer(dataUrl);
}

async function cropShot(shot, rect, basisW, basisH) {
  const bitmap = await decode(shot);
  if (!bitmap) return null;
  try {
    const crop = computeCrop(
      { rect, basisW, basisH },
      { naturalWidth: bitmap.width, naturalHeight: bitmap.height },
    );
    if (!crop || crop.w < 1 || crop.h < 1) return null;
    const canvas = new OffscreenCanvas(crop.w, crop.h);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(blob);
  } finally {
    bitmap.close?.();
  }
}

async function decode(source) {
  try {
    const response = await fetch(source);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function openViewer(dataUrl) {
  if (!dataUrl) return;

  await chrome.storage.session.set({
    [PENDING_KEY]: {
      dataUrl,
      lang: normalizeLang(chrome.i18n.getUILanguage()),
      createdAt: Date.now(),
    },
  });

  const viewerUrl = chrome.runtime.getURL(VIEWER_PATH);

  try {
    const stored = await chrome.storage.session.get(POPUP_KEY);
    const existing = stored[POPUP_KEY];
    if (existing?.windowId != null) {
      const tabs = await chrome.tabs.query({ windowId: existing.windowId });
      if (tabs.length) {
        await chrome.tabs.update(tabs[0].id, { url: `${viewerUrl}?r=${Date.now()}` });
        await chrome.windows.update(existing.windowId, { focused: true });
        return;
      }
    }
  } catch {
    /* fall through to a fresh window */
  }

  const focused = await chrome.windows.getLastFocused().catch(() => null);
  const bounds = computePopupBounds(focused);
  const win = await chrome.windows.create({
    url: viewerUrl,
    type: 'popup',
    focused: true,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  });
  await chrome.storage.session.set({ [POPUP_KEY]: { windowId: win.id } });
}
