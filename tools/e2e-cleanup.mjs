import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, browserWsUrl, listTargets, parseArgs, sleep, waitFor } from './lib/cdp.mjs';
import { cleanupTestExtension, prepareTestExtension } from './lib/ext.mjs';

const opts = parseArgs(process.argv.slice(2));
const source = resolve(process.env.GPLENS_EXT || '.');
const fixture = opts.fixture || 'http://127.0.0.1:8471/fixture.html';
const outDir = resolve(opts.outDir || 'test/artifacts');
const profile = mkdtempSync(join(tmpdir(), 'gplens-clean-'));
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
const results = {};

try {
  bc = await CDP.attach(await browserWsUrl(opts.port));
  const { id } = await bc.send('Extensions.loadUnpacked', { path: built.path });
  await sleep(700);
  const origin = new URL(fixture).origin;
  await bc.send('Target.createTarget', { url: fixture });
  await waitFor(async () => (await listTargets(opts.port)).find((t) => t.type === 'page' && t.url.startsWith(origin)), { label: 'fixture' });

  const pageTarget = (await listTargets(opts.port)).find((t) => t.type === 'page' && t.url.startsWith(origin));
  const page = await CDP.attach(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitFor(() => page.evaluate('document.readyState === "complete"'), { label: 'readyState' });
  await sleep(400);

  const swTarget = await waitFor(async () => (await listTargets(opts.port)).find((t) => t.type === 'service_worker' && t.url.includes(id)), { label: 'sw' });
  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const tabId = await worker.evaluate(`(async()=>{
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(origin)}));
    return tab.id;
  })()`);

  const snapshot = () => page.evaluate(`JSON.stringify({
    nodes: document.querySelectorAll('*').length,
    hosts: document.querySelectorAll('#gplens-overlay-host').length,
    styles: document.querySelectorAll('style').length,
    sheets: document.styleSheets.length,
    scrollX, scrollY,
    bodyScroll: document.body.scrollHeight,
  })`);

  results.before = JSON.parse(await snapshot());
  await sleep(600);
  results.before2 = JSON.parse(await snapshot());

  await worker.evaluate(`(async()=>{
    const s = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    await chrome.storage.session.set({ 'gplens:shot': { shot: s, at: Date.now() } });
    await chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      func: (cfg) => { globalThis.__GPLENS_INIT__ = cfg; },
      args: [{ shot: s, messages: { close: 'Close' } }],
    });
    await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['content/overlay.js'] });
    return 'mounted';
  })()`);

  await waitFor(() => page.evaluate(`Boolean(document.getElementById('gplens-overlay-host'))`), { label: 'host' });
  results.during = JSON.parse(await snapshot());

  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  await waitFor(() => page.evaluate(`!document.getElementById('gplens-overlay-host')`), { label: 'removed' });
  results.after = JSON.parse(await snapshot());

  const shotCleared = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.session.get('gplens:shot');
    return stored['gplens:shot'] ? 'present' : 'cleared';
  })()`);
  results.shotStorage = shotCleared;

  const clean =
    results.after.nodes === results.before2.nodes &&
    results.after.hosts === 0 &&
    results.after.styles === results.before2.styles &&
    results.after.sheets === results.before2.sheets &&
    results.after.scrollY === results.before2.scrollY;

  results.verdict = clean ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, 'cleanup.json'), JSON.stringify(results, null, 2));

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
