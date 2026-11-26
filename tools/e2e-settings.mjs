import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, browserWsUrl, listTargets, parseArgs, sleep, waitFor } from './lib/cdp.mjs';
import { cleanupTestExtension, prepareTestExtension } from './lib/ext.mjs';

const opts = parseArgs(process.argv.slice(2));
const source = resolve(process.env.GPLENS_EXT || '.');
const outDir = resolve(opts.outDir || 'test/artifacts');
const profile = mkdtempSync(join(tmpdir(), 'gplens-settings-'));
mkdirSync(outDir, { recursive: true });

const built = await prepareTestExtension({ source });
const browser = spawn(opts.browser, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${opts.port}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let bc = null;
const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  bc = await CDP.attach(await browserWsUrl(opts.port));
  const { id } = await bc.send('Extensions.loadUnpacked', { path: built.path });
  await sleep(900);

  const swTarget = await waitFor(
    async () => (await listTargets(opts.port)).find((t) => t.type === 'service_worker' && t.url.includes(id)),
    { label: 'sw' },
  );
  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const commands = await worker.evaluate(`(async()=>JSON.stringify(await chrome.commands.getAll()))()`).then(JSON.parse);
  const actionCommand = commands.find((c) => c.name === '_execute_action');
  record('commands: _execute_action registered', Boolean(actionCommand), JSON.stringify(commands));
  record(
    'commands: default shortcut is Alt+Shift+S family',
    Boolean(actionCommand?.shortcut) && /Shift/i.test(actionCommand.shortcut) && /Alt/i.test(actionCommand.shortcut) && /S$/i.test(actionCommand.shortcut),
    actionCommand?.shortcut || '(empty)',
  );

  const manifest = await worker.evaluate(`JSON.stringify(chrome.runtime.getManifest().options_ui || null)`).then(JSON.parse);
  record('manifest: options_ui present', Boolean(manifest && manifest.page), JSON.stringify(manifest));

  const before = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.local.get('gplens:settings');
    return JSON.stringify(stored['gplens:settings'] ?? null);
  })()`);
  record('storage: no settings written before first open', before === 'null', before);

  await worker.evaluate(`(async()=>{ await chrome.runtime.openOptionsPage(); return 'ok'; })()`);
  const optionsTarget = await waitFor(
    async () => (await listTargets(opts.port)).find((t) => t.url.includes('/options/options.html')),
    { label: 'options page' },
  );
  const page = await CDP.attach(optionsTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await waitFor(() => page.evaluate(`document.readyState === 'complete'`), { label: 'options ready' });
  await sleep(600);

  const initial = await page.evaluate(`JSON.stringify({
    checked: document.getElementById('close-with-popup').checked,
    scrollChecked: document.getElementById('scroll-during-selection')?.checked ?? null,
    incognitoChecked: document.getElementById('search-in-incognito')?.checked ?? null,
    title: document.getElementById('title').textContent,
    groupText: document.getElementById('group-result').textContent,
    shortcutText: document.getElementById('shortcut-keys').textContent.trim(),
    shortcutKbds: Array.from(document.querySelectorAll('#shortcut-keys kbd')).map((n) => n.textContent),
    emptyHidden: document.getElementById('shortcut-empty').hidden,
    changeLabel: document.getElementById('change-shortcut').textContent,
  })`).then(JSON.parse);

  record('options: checkbox defaults to checked', initial.checked === true, String(initial.checked));
  record('options: scrolling toggle defaults to checked', initial.scrollChecked === true, String(initial.scrollChecked));
  record('options: incognito toggle defaults to unchecked', initial.incognitoChecked === false, String(initial.incognitoChecked));
  record('options: heading has content', initial.groupText.length > 0, initial.groupText);
  record('options: shortcut rendered as kbd elements', initial.shortcutKbds.length >= 3, JSON.stringify(initial.shortcutKbds));

  const tokens = (value) =>
    String(value || '')
      .split('+')
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join('+');

  record(
    'options: shortcut matches chrome.commands.getAll',
    tokens(initial.shortcutText) === tokens(actionCommand?.shortcut),
    `${initial.shortcutKbds.join('+')} vs ${actionCommand?.shortcut}`,
  );
  record('options: unassigned warning hidden', initial.emptyHidden === true, String(initial.emptyHidden));
  record('options: change button is labelled', initial.changeLabel.length > 0, initial.changeLabel);

  const incognitoAllowed = await worker.evaluate(
    `chrome.extension.isAllowedIncognitoAccess().then((allowed) => allowed)`,
  );
  await page.evaluate(`(async()=>{
    const scroll = document.getElementById('scroll-during-selection');
    const incognito = document.getElementById('search-in-incognito');
    if (!scroll || !incognito) return 'missing controls';
    scroll.checked = false;
    scroll.dispatchEvent(new Event('change', { bubbles: true }));
    incognito.checked = true;
    incognito.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return 'done';
  })()`);
  const newSettings = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.local.get('gplens:settings');
    return JSON.stringify(stored['gplens:settings'] ?? null);
  })()`).then(JSON.parse);
  record('storage: scroll and incognito toggles persist independently', newSettings?.scrollDuringSelection === false && newSettings?.searchInIncognito === true, JSON.stringify(newSettings));
  const accessPrompt = await page.evaluate(`JSON.stringify({
    visible: !document.getElementById('incognito-access').hidden,
    buttonVisible: !document.getElementById('incognito-access-button').hidden,
  })`).then(JSON.parse);
  record(
    'options: missing incognito access shows guidance',
    incognitoAllowed || (accessPrompt.visible && accessPrompt.buttonVisible),
    JSON.stringify({ incognitoAllowed, ...accessPrompt }),
  );
  if (!incognitoAllowed) {
    await page.evaluate(`document.getElementById('incognito-access-button').click()`);
    const extensionSettings = await waitFor(
      async () => (await listTargets(opts.port)).find((t) => t.url === `chrome://extensions/?id=${id}`),
      { label: 'extension incognito permission settings', tries: 40 },
    );
    record(
      'options: access button opens this extension details page',
      Boolean(extensionSettings),
      extensionSettings?.url || '(missing)',
    );
  }

  await page.evaluate(`(async()=>{
    const box = document.getElementById('close-with-popup');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return 'done';
  })()`);
  const afterOff = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.local.get('gplens:settings');
    return JSON.stringify(stored['gplens:settings'] ?? null);
  })()`).then(JSON.parse);
  record('storage: toggling off persists false', afterOff?.closeOverlayWithPopup === false, JSON.stringify(afterOff));

  const savedFlash = await page.evaluate(`document.getElementById('saved').classList.contains('show')`);
  record('options: saved indicator appears', savedFlash === true, String(savedFlash));

  await page.send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  const afterReload = await page.evaluate(`document.getElementById('close-with-popup').checked`);
  record('options: unchecked state survives reload', afterReload === false, String(afterReload));
  const newSettingsAfterReload = await page.evaluate(`JSON.stringify({
    scroll: document.getElementById('scroll-during-selection')?.checked ?? null,
    incognito: document.getElementById('search-in-incognito')?.checked ?? null,
  })`).then(JSON.parse);
  record(
    'options: new settings survive reload independently',
    newSettingsAfterReload.scroll === false && newSettingsAfterReload.incognito === true,
    JSON.stringify(newSettingsAfterReload),
  );

  await page.evaluate(`(async()=>{
    const scroll = document.getElementById('scroll-during-selection');
    const incognito = document.getElementById('search-in-incognito');
    scroll.checked = true;
    scroll.dispatchEvent(new Event('change', { bubbles: true }));
    incognito.checked = false;
    incognito.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  })()`);
  const settingsAfterDisable = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.local.get('gplens:settings');
    return JSON.stringify(stored['gplens:settings'] ?? null);
  })()`).then(JSON.parse);
  record(
    'storage: both new toggles can be turned off and on independently',
    settingsAfterDisable?.scrollDuringSelection === true && settingsAfterDisable?.searchInIncognito === false,
    JSON.stringify(settingsAfterDisable),
  );
  const promptHidden = await page.evaluate(
    `document.getElementById('incognito-access').hidden`,
  );
  record('options: disabling incognito search hides permission guidance', promptHidden, String(promptHidden));

  await page.evaluate(`(async()=>{
    const box = document.getElementById('close-with-popup');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return 'done';
  })()`);
  const afterOn = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.local.get('gplens:settings');
    return JSON.stringify(stored['gplens:settings'] ?? null);
  })()`).then(JSON.parse);
  record('storage: toggling back on persists true', afterOn?.closeOverlayWithPopup === true, JSON.stringify(afterOn));

  await page.evaluate(`(async()=>{
    document.getElementById('change-shortcut').click();
    await new Promise((r) => setTimeout(r, 400));
    return 'clicked';
  })()`);
  const shortcutPage = await waitFor(
    async () => (await listTargets(opts.port)).find((t) => t.url.startsWith('chrome://extensions/shortcuts')),
    { label: 'shortcuts page', tries: 40 },
  );
  record('options: change button opens browser shortcuts page', Boolean(shortcutPage), shortcutPage?.url || '(missing)');

  const failed = checks.filter((c) => !c.pass);
  const summary = { checks, failed: failed.length, verdict: failed.length ? 'FAIL' : 'PASS' };
  writeFileSync(join(outDir, 'settings.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ failed: failed.length, verdict: summary.verdict }, null, 2));
  if (failed.length) process.exitCode = 1;

  page.close();
  worker.close();
} catch (error) {
  console.error('FAILED', String(error));
  process.exitCode = 1;
} finally {
  bc?.close();
  try { browser.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  await cleanupTestExtension(built.path);
}

process.exit(process.exitCode || 0);
