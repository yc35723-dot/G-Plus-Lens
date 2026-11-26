import { readSettings, writeSettings } from '../shared/settings.js';
import { formatShortcut } from '../shared/shortcut.js';

const SHORTCUT_COMMAND = '_execute_action';
const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';
const SAVED_DURATION = 1500;

const title = document.getElementById('title');
const saved = document.getElementById('saved');
const groupResult = document.getElementById('group-result');
const closeLabel = document.getElementById('close-label');
const closeHint = document.getElementById('close-hint');
const closeToggle = document.getElementById('close-with-popup');
const groupSelection = document.getElementById('group-selection');
const scrollLabel = document.getElementById('scroll-label');
const scrollHint = document.getElementById('scroll-hint');
const scrollToggle = document.getElementById('scroll-during-selection');
const incognitoLabel = document.getElementById('incognito-label');
const incognitoHint = document.getElementById('incognito-hint');
const incognitoToggle = document.getElementById('search-in-incognito');
const incognitoAccess = document.getElementById('incognito-access');
const incognitoAccessMessage = document.getElementById('incognito-access-message');
const incognitoAccessButton = document.getElementById('incognito-access-button');
const groupShortcut = document.getElementById('group-shortcut');
const shortcutKeys = document.getElementById('shortcut-keys');
const changeShortcut = document.getElementById('change-shortcut');
const shortcutHint = document.getElementById('shortcut-hint');
const shortcutEmpty = document.getElementById('shortcut-empty');

const text = (key, fallback) => chrome.i18n.getMessage(key) || fallback;

let savedTimer = 0;

applyStaticText();
init().catch(showSettingsError);

async function init() {
  const settings = await readSettings();
  closeToggle.checked = settings.closeOverlayWithPopup;
  closeToggle.addEventListener('change', onToggle);
  scrollToggle.checked = settings.scrollDuringSelection;
  scrollToggle.addEventListener('change', onScrollToggle);
  incognitoToggle.checked = settings.searchInIncognito;
  incognitoToggle.addEventListener('change', onIncognitoToggle);

  changeShortcut.addEventListener('click', () => {
    chrome.tabs.create({ url: SHORTCUTS_PAGE }).catch(() => {});
  });
  incognitoAccessButton.addEventListener('click', openIncognitoSettings);

  await refreshIncognitoAccess();
  await refreshShortcut();
  window.addEventListener('focus', () => refreshShortcut().catch(() => {}));
  window.addEventListener('focus', () => refreshIncognitoAccess());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshShortcut().catch(() => {});
      refreshIncognitoAccess();
    }
  });
}

function applyStaticText() {
  const name = text('extName', 'G+Lens');
  document.title = `${name} · ${text('optionsTitle', 'Settings')}`;
  title.textContent = name;
  groupResult.textContent = text('optionsResultGroup', 'Result window');
  closeLabel.textContent = text('optionsCloseLabel', 'Close the selection overlay with the result window');
  closeHint.textContent = text(
    'optionsCloseHint',
    'When on, closing the result window also ends area selection and returns you to the page.',
  );
  groupSelection.textContent = text('optionsSelectionGroup', 'Selection behavior');
  scrollLabel.textContent = text('optionsScrollLabel', 'Allow scrolling while selecting');
  scrollHint.textContent = text(
    'optionsScrollHint',
    'Keep the page dimmed while scrolling; the current view is captured after you select an area.',
  );
  incognitoLabel.textContent = text('optionsIncognitoLabel', 'Search in an incognito window');
  incognitoHint.textContent = text(
    'optionsIncognitoHint',
    'Separates Lens from your normal browser Google sign-in. This does not make browsing anonymous.',
  );
  incognitoAccessMessage.textContent = text(
    'optionsIncognitoAccess',
    'To use incognito search, allow G+Lens in incognito mode on its browser extension details page.',
  );
  incognitoAccessButton.textContent = text(
    'optionsIncognitoAccessButton',
    'Open extension settings',
  );
  groupShortcut.textContent = text('optionsShortcutGroup', 'Keyboard shortcut');
  changeShortcut.textContent = text('optionsShortcutChange', 'Change in browser');
  shortcutHint.textContent = text(
    'optionsShortcutHint',
    'Chromium only allows changing this in the browser’s own extension shortcuts page.',
  );
  shortcutEmpty.textContent = text(
    'optionsShortcutEmpty',
    'No shortcut is assigned. Use “Change in browser” to pick one.',
  );
  saved.textContent = text('optionsSaved', 'Saved');
}

async function onToggle() {
  await saveSetting(closeToggle, { closeOverlayWithPopup: closeToggle.checked }, 'closeOverlayWithPopup');
}

async function onScrollToggle() {
  await saveSetting(
    scrollToggle,
    { scrollDuringSelection: scrollToggle.checked },
    'scrollDuringSelection',
  );
}

async function onIncognitoToggle() {
  const savedSetting = await saveSetting(
    incognitoToggle,
    { searchInIncognito: incognitoToggle.checked },
    'searchInIncognito',
  );
  if (!savedSetting) return;
  await refreshIncognitoAccess();
}

async function saveSetting(toggle, patch, key) {
  const requested = toggle.checked;
  try {
    const next = await writeSettings(patch);
    toggle.checked = next[key];
    flashSaved();
    return true;
  } catch (error) {
    toggle.checked = !requested;
    showSettingsError(error);
    return false;
  }
}

async function refreshIncognitoAccess() {
  if (!incognitoToggle.checked) {
    incognitoAccess.hidden = true;
    incognitoAccessButton.hidden = true;
    return;
  }

  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    incognitoAccess.hidden = allowed;
    incognitoAccessButton.hidden = allowed;
  } catch (error) {
    console.error('Unable to check incognito access:', error);
    incognitoAccessMessage.textContent = text(
      'optionsIncognitoAccessCheckError',
      'Could not verify incognito access. Open extension settings to check the permission.',
    );
    incognitoAccess.hidden = false;
    incognitoAccessButton.hidden = false;
  }
}

function openIncognitoSettings() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch((error) => {
    console.error('Unable to open extension settings:', error);
    incognitoAccessMessage.textContent = text(
      'optionsIncognitoOpenError',
      'Could not open extension settings. Open the browser extensions page and enable incognito access for G+Lens.',
    );
  });
}

async function refreshShortcut() {
  let shortcut = '';
  try {
    const commands = await chrome.commands.getAll();
    const entry = commands.find((item) => item.name === SHORTCUT_COMMAND);
    shortcut = entry?.shortcut || '';
  } catch {
    shortcut = '';
  }
  renderShortcut(shortcut);
}

function renderShortcut(shortcut) {
  const parts = formatShortcut(shortcut);
  shortcutKeys.replaceChildren(
    ...parts.flatMap((label, index) => {
      const nodes = [document.createElement('kbd')];
      nodes[0].textContent = label;
      if (index < parts.length - 1) {
        const separator = document.createElement('span');
        separator.textContent = '+';
        separator.setAttribute('aria-hidden', 'true');
        nodes.push(separator);
      }
      return nodes;
    }),
  );

  if (!parts.length) {
    shortcutKeys.textContent = text('optionsNotAssigned', 'Not assigned');
    shortcutKeys.classList.add('empty');
    shortcutEmpty.hidden = false;
    shortcutKeys.setAttribute('aria-label', text('optionsNotAssigned', 'Not assigned'));
    return;
  }

  shortcutKeys.classList.remove('empty');
  shortcutEmpty.hidden = true;
  shortcutKeys.setAttribute('aria-label', parts.join(' + '));
}

function flashSaved() {
  clearTimeout(savedTimer);
  saved.classList.remove('error');
  saved.textContent = text('optionsSaved', 'Saved');
  saved.classList.add('show');
  savedTimer = setTimeout(() => saved.classList.remove('show'), SAVED_DURATION);
}

function showSettingsError(error) {
  if (error) console.error('Unable to load or save G+Lens settings:', error);
  clearTimeout(savedTimer);
  saved.textContent = text('optionsSettingsError', 'Could not load or save settings.');
  saved.classList.add('show', 'error');
  savedTimer = setTimeout(() => {
    saved.classList.remove('show', 'error');
    saved.textContent = text('optionsSaved', 'Saved');
  }, SAVED_DURATION * 2);
}
