import { buildUploadUrl, normalizeLang, submitImageForm } from './shared/lens.js';
import { computePopupBounds } from './shared/window.js';
import { computeCrop } from './shared/geometry.js';
import { pickLargestImage } from './shared/target.js';
import { readSettings } from './shared/settings.js';

const PENDING_KEY = 'gplens:pending';
const OVERLAYS_KEY = 'gplens:overlays';
const LEGACY_SHOTS_KEY = 'gplens:shots';
const POPUP_KEY = 'gplens:popup';
const MENU_PAGE = 'gplens-page';
const MENU_IMAGE = 'gplens-image';
const VIEWER_PATH = 'viewer/viewer.html';
const HOST_ID = 'gplens-overlay-host';
const MIN_SELECTION = 12;
const LENS_PAGE_TIMEOUT = 20000;

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

async function isIncognitoAccessAllowed() {
  try {
    return await chrome.extension.isAllowedIncognitoAccess();
  } catch (error) {
    console.error('Unable to check incognito access:', error);
    return false;
  }
}

async function guideIncognitoAccess() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('Unable to open settings for incognito access:', error);
  }
}

chrome.runtime.onInstalled.addListener(rebuildMenus);
chrome.runtime.onStartup.addListener(rebuildMenus);
rebuildMenus();

chrome.action.onClicked.addListener((tab) => {
  startFreeze(tab).catch((error) => console.error('Unable to start G+Lens:', error));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_IMAGE) {
    searchImage(tab, info).catch((error) => {
      console.error('Unable to search the selected image:', error);
      startFreeze(tab).catch((startError) => console.error('Unable to start G+Lens:', startError));
    });
    return;
  }
  if (info.menuItemId === MENU_PAGE) {
    startFreeze(tab).catch((error) => console.error('Unable to start G+Lens:', error));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return false;

  if (msg.type === 'gplens:selection' && msg.rect && msg.basis) {
    const tab = sender.tab;
    finishSelection(tab, msg).then(
      (result) => respond(result),
      (error) => {
        console.error('Unable to finish G+Lens selection:', error);
        respond({ ok: false, error: t('overlayCaptureError') });
      },
    );
    return true;
  }

  if (msg.type === 'gplens:cancel') {
    const tabId = sender.tab?.id;
    (async () => {
      if (Number.isInteger(tabId)) await dropOverlay(tabId);
      respond({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropOverlay(tabId).catch((error) => console.error('Unable to clear G+Lens overlay state:', error));
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  let isPopup = false;
  try {
    const stored = await chrome.storage.session.get([PENDING_KEY, POPUP_KEY]);
    const popup = stored[POPUP_KEY];
    isPopup = popup?.windowId === windowId;
    if (isPopup) {
      const keys = [POPUP_KEY];
      if (!popup.requestId || stored[PENDING_KEY]?.requestId === popup.requestId) {
        keys.push(PENDING_KEY);
      }
      await chrome.storage.session.remove(keys);
    }
  } catch {
    /* session storage resets when the worker restarts */
  }
  if (!isPopup) return;
  let closeOverlays = true;
  try {
    closeOverlays = await shouldCloseOverlays();
  } catch (error) {
    console.error('Unable to read overlay close setting:', error);
  }
  if (!closeOverlays) return;
  await closeAllOverlays().catch((error) => console.error('Unable to close G+Lens overlays:', error));
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
  } catch (error) {
    console.error('Unable to capture the visible tab:', error);
    return null;
  }
}

async function readOverlays() {
  const stored = await chrome.storage.session.get([OVERLAYS_KEY, LEGACY_SHOTS_KEY]);
  const value = stored[OVERLAYS_KEY];
  if (value && typeof value === 'object') return value;

  const legacy = stored[LEGACY_SHOTS_KEY];
  if (legacy && typeof legacy === 'object') {
    await chrome.storage.session.set({ [OVERLAYS_KEY]: legacy });
    await chrome.storage.session.remove(LEGACY_SHOTS_KEY);
    return legacy;
  }
  return {};
}

async function saveOverlay(tabId, shot) {
  if (!Number.isInteger(tabId)) return;
  const overlays = await readOverlays();
  overlays[tabId] = { at: Date.now(), ...(shot ? { shot } : {}) };
  await chrome.storage.session.set({ [OVERLAYS_KEY]: overlays });
}

async function readShot(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const overlays = await readOverlays();
  return overlays[tabId]?.shot || null;
}

async function dropOverlay(tabId) {
  if (!Number.isInteger(tabId)) return;
  const overlays = await readOverlays();
  if (!overlays[tabId]) return;
  delete overlays[tabId];
  if (Object.keys(overlays).length) {
    await chrome.storage.session.set({ [OVERLAYS_KEY]: overlays });
  } else {
    await chrome.storage.session.remove(OVERLAYS_KEY);
  }
}

async function startFreeze(tab) {
  if (!tab || tab.id == null || !isScriptable(tab.url)) return;
  if (await hasOverlay(tab.id)) return;

  const settings = await readSettings();
  if (settings.searchInIncognito && !(await isIncognitoAccessAllowed())) {
    await guideIncognitoAccess();
    return;
  }
  const shot = settings.scrollDuringSelection ? null : await captureShot(tab);
  if (!settings.scrollDuringSelection && !shot) return;

  await saveOverlay(tab.id, shot);

  const init = {
    shot,
    scrollDuringSelection: settings.scrollDuringSelection,
    messages: {
      close: t('overlayClose'),
      captureError: t('overlayCaptureError'),
    },
  };

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
  } catch (error) {
    console.error('Unable to inject G+Lens overlay into tab:', tab.id, error);
    await dropOverlay(tab.id);
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

  await dropOverlay(tabId);
}

async function closeAllOverlays() {
  const overlays = await readOverlays();
  const tabIds = Object.keys(overlays)
    .map((key) => Number(key))
    .filter((id) => Number.isInteger(id));
  await Promise.all(tabIds.map((tabId) => closeOverlay(tabId)));
}

async function finishSelection(tab, selection) {
  const tabId = tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('Selection came from an invalid tab');
  const source = selection.scrollDuringSelection
    ? await captureCurrentView(tab)
    : (await readShot(tabId)) || (await captureShot(tab));
  if (!source) throw new Error('Screenshot capture returned no image');
  const dataUrl = await cropShot(source, selection.rect, selection.basis.w, selection.basis.h);
  if (!dataUrl) throw new Error('Unable to crop selected area');
  const opened = await openViewer(dataUrl);
  return opened
    ? { ok: true }
    : { ok: false, error: t('overlayIncognitoUnavailable') };
}

async function captureCurrentView(tab) {
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'gplens:capture-hide' });
  if (!response?.ok) throw new Error('Overlay did not confirm that it was hidden');

  try {
    const shot = await captureShot(tab);
    if (!shot) throw new Error('Screenshot capture returned no image');
    return shot;
  } finally {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'gplens:capture-show' });
    } catch (error) {
      console.error('Unable to restore G+Lens overlay after capture:', error);
    }
  }
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

function isGoogleSearchPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'lens.google.com' || parsed.hostname === 'www.google.com');
  } catch {
    return false;
  }
}

function waitForGoogleSearchPage(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(tab);
    };
    const inspect = (tab) => {
      if (tab.status !== 'complete') return;
      if (isGoogleSearchPage(tab.url)) {
        finish(null, tab);
      } else if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
        finish(new Error(`Search window navigated to an unexpected page: ${tab.url}`));
      }
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') inspect(tab);
    };
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for Google Lens to load')),
      LENS_PAGE_TIMEOUT,
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(inspect, (error) => finish(error));
  });
}

async function closeIncognitoWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  try {
    await chrome.windows.remove(windowId);
  } catch (error) {
    console.warn('Unable to close the failed incognito Lens window:', error);
  }
  try {
    const stored = await chrome.storage.session.get(POPUP_KEY);
    if (stored[POPUP_KEY]?.windowId === windowId) {
      await chrome.storage.session.remove(POPUP_KEY);
    }
  } catch (error) {
    console.error('Unable to clear failed incognito window state:', error);
  }
}

async function openIncognitoLens(dataUrl) {
  if (!(await isIncognitoAccessAllowed())) {
    await guideIncognitoAccess();
    return false;
  }

  const lang = normalizeLang(chrome.i18n.getUILanguage());
  const lensUrl = new URL('https://lens.google.com/');
  lensUrl.searchParams.set('hl', lang);
  const uploadUrl = buildUploadUrl(lang);
  let windowId = null;
  let tabId = null;

  try {
    const stored = await chrome.storage.session.get(POPUP_KEY);
    const existing = stored[POPUP_KEY];
    if (existing?.windowId != null) {
      const current = await chrome.windows.get(existing.windowId);
      if (current.incognito) {
        const [tab] = await chrome.tabs.query({ windowId: existing.windowId });
        if (Number.isInteger(tab?.id)) {
          windowId = existing.windowId;
          tabId = tab.id;
          await chrome.tabs.update(tabId, { url: 'about:blank' });
          await chrome.windows.update(windowId, { focused: true });
        }
      }
    }
  } catch (error) {
    console.warn('Unable to reuse the existing G+Lens incognito window:', error);
    const failedWindowId = windowId;
    windowId = null;
    tabId = null;
    await closeIncognitoWindow(failedWindowId);
  }

  if (!Number.isInteger(windowId)) {
    let focused = null;
    try {
      focused = await chrome.windows.getLastFocused();
    } catch (error) {
      console.error('Unable to read focused window bounds:', error);
    }
    const bounds = computePopupBounds(focused);
    const createData = {
      url: 'about:blank',
      type: 'popup',
      focused: true,
      width: bounds.width,
      height: bounds.height,
      incognito: true,
    };

    let win;
    try {
      win = await chrome.windows.create({
        ...createData,
        left: bounds.left,
        top: bounds.top,
      });
    } catch (error) {
      console.warn('Unable to use calculated G+Lens window bounds; using browser placement:', error);
      try {
        win = await chrome.windows.create(createData);
      } catch (createError) {
        console.error('Unable to create the incognito Lens window:', createError);
        return false;
      }
    }
    if (!Number.isInteger(win?.id)) {
      console.error('Browser did not create the incognito Lens window');
      return false;
    }

    windowId = win.id;
    try {
      const [tab] = await chrome.tabs.query({ windowId });
      tabId = tab?.id;
    } catch (error) {
      console.error('Unable to find the incognito Lens tab:', error);
    }
  }

  if (!Number.isInteger(tabId)) {
    await closeIncognitoWindow(windowId);
    return false;
  }

  await chrome.storage.session.set({
    [POPUP_KEY]: { windowId, incognito: true },
  });

  try {
    await chrome.tabs.update(tabId, { url: lensUrl.href });
    await waitForGoogleSearchPage(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: submitImageForm,
      args: [{ dataUrl, actionUrl: uploadUrl }],
    });
    return true;
  } catch (error) {
    console.error('Unable to submit the selected image to Google Lens in incognito:', error);
    await closeIncognitoWindow(windowId);
    return false;
  }
}

async function openViewer(dataUrl) {
  if (!dataUrl) return false;

  const settings = await readSettings();
  if (settings.searchInIncognito) return openIncognitoLens(dataUrl);

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
      const current = await chrome.windows.get(existing.windowId);
      if (!current.incognito) {
        const tabs = await chrome.tabs.query({ windowId: existing.windowId });
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { url: `${viewerUrl}?r=${Date.now()}` });
          await chrome.windows.update(existing.windowId, { focused: true });
          return true;
        }
      }
    }
  } catch (error) {
    console.warn('Unable to reuse the existing G+Lens result window:', error);
  }

  let focused = null;
  try {
    focused = await chrome.windows.getLastFocused();
  } catch (error) {
    console.error('Unable to read focused window bounds:', error);
  }
  const bounds = computePopupBounds(focused);
  const createData = {
    url: viewerUrl,
    type: 'popup',
    focused: true,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
  };
  let win;
  try {
    win = await chrome.windows.create(createData);
  } catch (error) {
    console.warn('Unable to use calculated G+Lens window bounds; using browser placement:', error);
    const { left, top, ...browserPlacedData } = createData;
    win = await chrome.windows.create(browserPlacedData);
  }
  if (!Number.isInteger(win?.id)) throw new Error('Browser did not create the result window');
  await chrome.storage.session.set({
    [POPUP_KEY]: { windowId: win.id, incognito: false },
  });
  return true;
}
