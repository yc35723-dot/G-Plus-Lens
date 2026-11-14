const ORDER = ['ctrl', 'alt', 'shift', 'meta', 'mod'];

const LABELS = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
  command: 'Cmd',
  macctrl: 'Ctrl',
  mod: 'Mod',
};

function tokenOf(part) {
  const raw = String(part || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (LABELS[lower]) return { key: lower, label: LABELS[lower] };
  if (lower === 'command') return { key: 'command', label: LABELS.command };
  if (lower === 'macctrl') return { key: 'macctrl', label: LABELS.macctrl };
  if (/^f([1-9]|1[0-2])$/.test(lower)) return { key: 'f', label: raw.toUpperCase() };
  if (raw.length === 1) return { key: 'char', label: raw.toUpperCase() };
  return { key: 'other', label: raw };
}

export function parseShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'string') return [];
  return shortcut
    .split('+')
    .map(tokenOf)
    .filter(Boolean);
}

export function formatShortcut(shortcut) {
  const tokens = parseShortcut(shortcut);
  if (!tokens.length) return [];

  const modifiers = tokens.filter((token) => ORDER.includes(token.key));
  const others = tokens.filter((token) => !ORDER.includes(token.key));

  modifiers.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

  return [...modifiers, ...others].map((token) => token.label);
}

export function shortcutText(shortcut) {
  return formatShortcut(shortcut).join(' + ');
}
