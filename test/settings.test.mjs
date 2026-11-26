import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  readSettings,
  SETTINGS_KEY,
  writeSettings,
} from '../shared/settings.js';

test('scrolling defaults on and incognito search defaults off', () => {
  assert.equal(DEFAULT_SETTINGS.scrollDuringSelection, true);
  assert.equal(DEFAULT_SETTINGS.searchInIncognito, false);
});

test('legacy settings retain behavior and receive the new defaults', () => {
  assert.deepEqual(normalizeSettings({ closeOverlayWithPopup: false }), {
    closeOverlayWithPopup: false,
    scrollDuringSelection: true,
    searchInIncognito: false,
  });
});

test('new settings preserve explicit user choices', () => {
  assert.deepEqual(
    normalizeSettings({
      closeOverlayWithPopup: true,
      scrollDuringSelection: false,
      searchInIncognito: true,
    }),
    {
      closeOverlayWithPopup: true,
      scrollDuringSelection: false,
      searchInIncognito: true,
    },
  );
});

test('concurrent setting changes preserve both updates', async () => {
  const storage = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          const value = storage[key];
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { [key]: value };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
  };

  try {
    await Promise.all([
      writeSettings({ scrollDuringSelection: false }),
      writeSettings({ searchInIncognito: true }),
    ]);

    assert.deepEqual(normalizeSettings(storage[SETTINGS_KEY]), {
      closeOverlayWithPopup: true,
      scrollDuringSelection: false,
      searchInIncognito: true,
    });
  } finally {
    delete globalThis.chrome;
  }
});

test('settings storage errors are surfaced instead of defaulting to normal search', async () => {
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          throw new Error('storage unavailable');
        },
      },
    },
  };

  try {
    await assert.rejects(readSettings(), /storage unavailable/);
  } finally {
    delete globalThis.chrome;
  }
});
