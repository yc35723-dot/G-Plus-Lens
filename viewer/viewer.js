import { buildUploadUrl, normalizeLang, submitImageForm } from '../shared/lens.js';

const PENDING_KEY = 'gplens:pending';
const PREFLIGHT_TIMEOUT = 4000;
const GUARD_DELAY = 8000;

const app = document.getElementById('app');
const crop = document.getElementById('crop');
const status = document.getElementById('status');
const actions = document.getElementById('actions');
const retry = document.getElementById('retry');
const external = document.getElementById('external');

const text = (key, fallback) => chrome.i18n.getMessage(key) || fallback;

let pending = null;
let guardTimer = 0;
let submitted = false;

init().catch(() => showBlocked(text('viewerError', 'Something went wrong.')));

async function init() {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  pending = stored[PENDING_KEY] || null;

  if (!pending?.dataUrl) {
    showBlocked(text('viewerNoImage', 'No screenshot to search. Capture an area first.'));
    return;
  }

  pending.lang = normalizeLang(pending.lang);
  crop.src = pending.dataUrl;
  crop.hidden = false;
  status.textContent = text('viewerUploading', 'Searching with Google Lens…');

  await settle();

  const reachable = await preflight();
  if (!reachable) {
    showFallback(text('viewerOffline', 'No connection to Google Lens.'));
    return;
  }

  submitForm('_self');
  guardTimer = setTimeout(() => {
    if (!submitted) showFallback(text('viewerFallback', 'The result did not load.'));
  }, GUARD_DELAY);
}

async function preflight() {
  if (navigator.onLine === false) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT);
  try {
    const response = await fetch(buildUploadUrl(pending.lang), {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    return response.type === 'opaqueredirect' || response.type === 'opaque' || response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function submitForm(target) {
  submitted = true;
  submitImageForm({
    dataUrl: pending.dataUrl,
    actionUrl: buildUploadUrl(pending.lang),
    target,
  });
}

function showFallback(message) {
  clearTimeout(guardTimer);
  app.className = 'state-error';
  status.textContent = message || text('viewerFallback', 'The result did not load.');
  actions.hidden = false;
  external.hidden = false;
  retry.textContent = text('viewerRetry', 'Try again');
  external.textContent = text('viewerOpenTab', 'Open in new tab');
  retry.onclick = () => {
    actions.hidden = true;
    app.className = 'state-loading';
    status.textContent = text('viewerUploading', 'Searching with Google Lens…');
    submitted = false;
    submitForm('_self');
  };
  external.onclick = () => {
    submitForm('_blank');
    window.close();
  };
}

function showBlocked(message) {
  clearTimeout(guardTimer);
  app.className = 'state-error';
  status.textContent = message;
  actions.hidden = false;
  external.hidden = true;
  retry.textContent = text('viewerClose', 'Close');
  retry.onclick = () => window.close();
}

function settle() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
