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
const profile = mkdtempSync(join(tmpdir(), 'gplens-close-'));
mkdirSync(outDir, { recursive: true });

const SELECT = { x: 140, y: 100, w: 360, h: 220 };

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

  const origin = new URL(fixture).origin;
  await bc.send('Target.createTarget', { url: fixture });
  const pageTarget = await waitFor(
    async () => (await listTargets(opts.port)).find((t) => t.type === 'page' && t.url.startsWith(origin)),
    { label: 'fixture' },
  );

  const page = await CDP.attach(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitFor(() => page.evaluate(`document.readyState === 'complete'`), { label: 'ready' });
  await sleep(500);

  const swTarget = await waitFor(
    async () => (await listTargets(opts.port)).find((t) => t.type === 'service_worker' && t.url.includes(id)),
    { label: 'sw' },
  );
  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const tabId = await worker.evaluate(`(async()=>{
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(origin)}));
    return tab.id;
  })()`);

  const setSetting = (value) =>
    worker.evaluate(`(async()=>{
      await chrome.storage.local.set({ 'gplens:settings': { closeOverlayWithPopup: ${value} } });
      return 'ok';
    })()`);

  const mountOverlay = () =>
    worker.evaluate(`(async()=>{
      const shot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      const shots = {};
      shots[${tabId}] = { shot, at: Date.now() };
      await chrome.storage.session.set({ 'gplens:shots': shots });
      await chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        func: (cfg) => { globalThis.__GPLENS_INIT__ = cfg; },
        args: [{ shot, messages: { close: 'Close' } }],
      });
      await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['content/overlay.js'] });
      return 'mounted';
    })()`);

  const drag = async () => {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: SELECT.x, y: SELECT.y, button: 'left', clickCount: 1, buttons: 1,
    });
    for (let i = 1; i <= 8; i += 1) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(SELECT.x + (SELECT.w * i) / 8),
        y: Math.round(SELECT.y + (SELECT.h * i) / 8),
        button: 'left',
        buttons: 1,
      });
    }
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: SELECT.x + SELECT.w,
      y: SELECT.y + SELECT.h,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    });
  };

  const popupWindowId = async () =>
    worker.evaluate(`(async()=>{
      const stored = await chrome.storage.session.get('gplens:popup');
      return stored['gplens:popup']?.windowId ?? null;
    })()`);

  const overlayPresent = () => page.evaluate(`Boolean(document.getElementById('gplens-overlay-host'))`);

  const scenario = async (label, setting, expectClosed) => {
    await setSetting(setting);
    await bc.send('Target.createTarget', { url: fixture, background: true });
    await sleep(600);
    const targetTab = await worker.evaluate(`(async()=>{
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(origin)}));
      await chrome.tabs.update(tab.id, { active: true });
      return tab.id;
    })()`);
    void targetTab;

    await worker.evaluate(`(async()=>{ await chrome.storage.session.remove('gplens:pending'); return 'ok'; })()`);
    await mountOverlay();
    await waitFor(overlayPresent, { label: `${label}: overlay mounted` });
    await drag();

    await waitFor(
      async () => (await popupWindowId()) != null,
      { label: `${label}: popup window` },
    );
    const winId = await popupWindowId();
    record(`${label}: overlay still present while popup open`, await overlayPresent(), `windowId=${winId}`);

    await worker.evaluate(`(async()=>{ await chrome.windows.remove(${winId}); return 'ok'; })()`);
    await sleep(1200);

    const present = await overlayPresent();
    if (expectClosed) {
      record(`${label}: overlay removed after closing popup`, present === false, `present=${present}`);
    } else {
      record(`${label}: overlay kept after closing popup`, present === true, `present=${present}`);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(async () => (await overlayPresent()) === false, { label: `${label}: escape cleanup` });
      record(`${label}: escape still cleans up`, (await overlayPresent()) === false, 'ok');
    }

    const leftover = await worker.evaluate(`(async()=>{
      const stored = await chrome.storage.session.get('gplens:shots');
      return JSON.stringify(stored['gplens:shots'] ?? null);
    })()`);
    record(`${label}: shot storage cleared`, leftover === 'null', leftover);
  };

  await scenario('default-on', true, true);
  await scenario('setting-off', false, false);

  const failed = checks.filter((c) => !c.pass);
  const summary = { checks, failed: failed.length, verdict: failed.length ? 'FAIL' : 'PASS' };
  writeFileSync(join(outDir, 'popup-close.json'), JSON.stringify(summary, null, 2));
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
