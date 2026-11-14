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
const groupShortcut = document.getElementById('group-shortcut');
const shortcutKeys = document.getElementById('shortcut-keys');
const changeShortcut = document.getElementById('change-shortcut');
const shortcutHint = document.getElementById('shortcut-hint');
const shortcutEmpty = document.getElementById('shortcut-empty');

const text = (key, fallback) => chrome.i18n.getMessage(key) || fallback;

let savedTimer = 0;

applyStaticText();
init().catch(() => {});

async function init() {
  const settings = await readSettings();
  closeToggle.checked = settings.closeOverlayWithPopup;
  closeToggle.addEventListener('change', onToggle);

  changeShortcut.addEventListener('click', () => {
    chrome.tabs.create({ url: SHORTCUTS_PAGE }).catch(() => {});
  });

  await refreshShortcut();
  window.addEventListener('focus', () => refreshShortcut().catch(() => {}));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshShortcut().catch(() => {});
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
  const next = await writeSettings({ closeOverlayWithPopup: closeToggle.checked });
  closeToggle.checked = next.closeOverlayWithPopup;
  flashSaved();
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
  saved.classList.add('show');
  savedTimer = setTimeout(() => saved.classList.remove('show'), SAVED_DURATION);
}
