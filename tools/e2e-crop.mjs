import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, browserWsUrl, listTargets, parseArgs, sleep, waitFor } from './lib/cdp.mjs';
import { cleanupTestExtension, prepareTestExtension } from './lib/ext.mjs';
import { comparePixels } from './lib/compare.mjs';

const opts = parseArgs(process.argv.slice(2));
const source = resolve(process.env.GPLENS_EXT || '.');
const fixture = opts.fixture || 'http://127.0.0.1:8471/pattern.html';
const outDir = resolve(opts.outDir || 'test/artifacts');
const scale = Number(opts.scale || 1);
const scrollMode = !opts.frozen;
const profile = mkdtempSync(join(tmpdir(), 'gplens-e2e-'));
const SELECT = { x: 137, y: 96, w: 402, h: 268 };

mkdirSync(outDir, { recursive: true });

const built = await prepareTestExtension({ source });
const extensionPath = built.path;

const browser = spawn(opts.browser, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${opts.port}`,
  '--enable-unsafe-extension-debugging',
  `--force-device-scale-factor=${opts.scale}`,
  '--window-size=1280,900',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let browserClient = null;
const workerDiagnostics = [];

try {
  browserClient = await CDP.attach(await browserWsUrl(opts.port));
  const { id: extensionId } = await browserClient.send('Extensions.loadUnpacked', { path: extensionPath });
  await sleep(700);

  await browserClient.send('Target.createTarget', { url: fixture });
  const origin = new URL(fixture).origin;
  const pageTarget = await waitFor(async () => {
    const targets = await listTargets(opts.port);
    return targets.find((t) => t.type === 'page' && t.url.startsWith(origin)) || null;
  }, { label: 'fixture tab' });

  const page = await CDP.attach(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: fixture });
  await waitFor(() => page.evaluate('document.readyState === "complete"'), { label: 'readyState' });
  await sleep(400);

  const swTarget = await waitFor(async () => {
    const targets = await listTargets(opts.port);
    return targets.find((t) => t.type === 'service_worker' && t.url.includes(extensionId)) || null;
  }, { label: 'service worker' });

  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  worker.ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled') {
      workerDiagnostics.push(
        message.params.args.map((arg) => arg.value || arg.description || '').join(' '),
      );
    }
    if (message.method === 'Runtime.exceptionThrown') {
      workerDiagnostics.push(message.params.exceptionDetails.text);
    }
  });

  const tabId = await worker.evaluate(`(async()=>{
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(origin)}));
    return tab ? tab.id : tabs[0].id;
  })()`);

  const metrics = await page.evaluate(`JSON.stringify({
    innerW: innerWidth, innerH: innerHeight,
    clientW: document.documentElement.clientWidth,
    clientH: document.documentElement.clientHeight,
    dpr: devicePixelRatio,
  })`);

  let shot = null;
  if (!scrollMode) {
    shot = await worker.evaluate(`chrome.tabs.captureVisibleTab(null, { format: 'png' })`);
  }

  await worker.evaluate(`(async()=>{
    const overlays = {};
    overlays[${tabId}] = {
      at: Date.now(),
      ...( ${scrollMode} ? {} : { shot: ${JSON.stringify(shot)} }),
    };
    await chrome.storage.session.set({ 'gplens:overlays': overlays });
    await chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      func: (cfg) => { globalThis.__GPLENS_INIT__ = cfg; },
      args: [{
        scrollDuringSelection: ${scrollMode},
        shot: ${scrollMode} ? null : ${JSON.stringify(shot)},
        messages: { close: 'Close' },
      }],
    });
    await chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      files: ['content/overlay.js'],
    });
  })()`);

  const hasHost = await waitFor(
    () => page.evaluate(`Boolean(document.getElementById('gplens-overlay-host'))`),
    { label: 'overlay host' },
  );
  console.log('overlay mounted:', hasHost);

  const before = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, `overlay-${opts.scale}x.png`), Buffer.from(before.data, 'base64'));

  const scrollBefore = await page.evaluate('scrollY');
  if (scrollMode) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: SELECT.x,
      y: SELECT.y,
      deltaX: 0,
      deltaY: 520,
    });
    await waitFor(() => page.evaluate('scrollY > 0'), { label: 'page scroll under overlay' });
  }
  const scrollAfter = await page.evaluate('scrollY');
  console.log(`${scrollMode ? 'page scroll under overlay' : 'frozen page scroll'}:`, scrollBefore, '->', scrollAfter);

  if (scrollMode) {
    const hidden = await worker.evaluate(`chrome.tabs.sendMessage(${tabId}, { type: 'gplens:capture-hide' })`);
    if (!hidden?.ok) throw new Error('overlay did not hide for expected screenshot');
    shot = await worker.evaluate(`chrome.tabs.captureVisibleTab(null, { format: 'png' })`);
    await worker.evaluate(`chrome.tabs.sendMessage(${tabId}, { type: 'gplens:capture-show' })`);
  }
  writeFileSync(join(outDir, `shot-${opts.scale}x.png`), Buffer.from(shot.split(',')[1], 'base64'));

  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: SELECT.x, y: SELECT.y, button: 'left', clickCount: 1, buttons: 1,
  });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(SELECT.x + (SELECT.w * i) / steps),
      y: Math.round(SELECT.y + (SELECT.h * i) / steps),
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

  const pending = await waitFor(
    () => worker.evaluate(`(async()=>{
      const stored = await chrome.storage.session.get('gplens:pending');
      return stored['gplens:pending'] ? JSON.stringify({ len: stored['gplens:pending'].dataUrl.length, lang: stored['gplens:pending'].lang }) : null;
    })()`),
    { label: 'pending capture' },
  );
  console.log('pending:', pending);
  const popupState = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.session.get('gplens:popup');
    return JSON.stringify(stored['gplens:popup'] ?? null);
  })()`);
  console.log('popup storage:', popupState);

  const persists = await page.evaluate(`Boolean(document.getElementById('gplens-overlay-host'))`);
  console.log('overlay persists after search:', persists);

  const dataUrl = await worker.evaluate(`(async()=>{
    const stored = await chrome.storage.session.get('gplens:pending');
    return stored['gplens:pending'] ? stored['gplens:pending'].dataUrl : '';
  })()`);
  writeFileSync(join(outDir, `crop-${opts.scale}x.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));

  const shotDataUrl = `data:image/png;base64,${readFileSync(join(outDir, `shot-${opts.scale}x.png`)).toString('base64')}`;
  const parsed = JSON.parse(metrics);
  const shotSize = await page.evaluate(`(async()=>{
    const im = new Image();
    await new Promise((res) => { im.onload = res; im.src = ${JSON.stringify(shotDataUrl)}; });
    return JSON.stringify({ w: im.naturalWidth, h: im.naturalHeight });
  })()`).then(JSON.parse);
  const ratioX = shotSize.w / parsed.innerW;
  const ratioY = shotSize.h / parsed.innerH;
  const compareRect = {
    x: Math.round(SELECT.x * ratioX),
    y: Math.round(SELECT.y * ratioY),
    w: Math.round(SELECT.w * ratioX),
    h: Math.round(SELECT.h * ratioY),
  };
  writeFileSync(
    join(outDir, `geometry-${opts.scale}x.json`),
    JSON.stringify({ metrics: parsed, shotSize, ratioX, ratioY, compareRect }, null, 2),
  );
  const compare = await comparePixels(page, {
    shot: shotDataUrl,
    crop: dataUrl,
    rect: compareRect,
  });
  console.log('pixel compare:', JSON.stringify({ ...compare, verdict: compare.geometryOk && compare.diffPixels === 0 ? 'PASS' : 'FAIL' }, null, 2));

  const popup = await waitFor(
    async () => (await listTargets(opts.port)).find(
      (t) => t.type === 'page' && (
        t.url.includes(`${extensionId}/viewer/`) ||
        t.url.includes('lens.google.com') ||
        t.url.includes('google.com/search')
      ),
    ),
    { label: 'viewer popup', tries: 60, delay: 100 },
  );
  console.log('popup:', popup ? popup.url : 'MISSING');

  const esc = await page.evaluate(`(async()=>{
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    return !document.getElementById('gplens-overlay-host');
  })()`);
  console.log('escape closes overlay:', esc);

  const incognitoAllowed = await worker.evaluate(
    `chrome.extension.isAllowedIncognitoAccess().then((allowed) => allowed)`,
  );
  let incognitoGuard = null;
  if (!incognitoAllowed) {
    await worker.evaluate(`(async()=>{
      await chrome.storage.local.set({
        'gplens:settings': {
          closeOverlayWithPopup: true,
          scrollDuringSelection: true,
          searchInIncognito: true,
        },
      });
      const popup = (await chrome.storage.session.get('gplens:popup'))['gplens:popup'];
      if (popup?.windowId != null) await chrome.windows.remove(popup.windowId).catch(() => {});
      await chrome.storage.session.remove(['gplens:pending', 'gplens:popup']);
    })()`);
    const response = await worker.evaluate(`(async()=>{
      await chrome.storage.session.set({
        'gplens:overlays': {
          [${tabId}]: { shot: ${JSON.stringify(shot)}, at: Date.now() },
        },
      });
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        func: (payload) => new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve)),
        args: [{
          type: 'gplens:selection',
          rect: ${JSON.stringify(SELECT)},
          basis: { w: ${JSON.parse(metrics).innerW}, h: ${JSON.parse(metrics).innerH} },
          scrollDuringSelection: false,
        }],
      });
      return JSON.stringify(injected.result);
    })()`).then(JSON.parse);
    const optionsPage = await waitFor(
      async () => (await listTargets(opts.port)).find(
        (target) => target.url.includes(`${extensionId}/options/options.html`),
      ),
      { label: 'incognito permission guidance' },
    );
    const pendingAfterBlock = await worker.evaluate(`(async()=>{
      const stored = await chrome.storage.session.get('gplens:pending');
      return Boolean(stored['gplens:pending']);
    })()`);
    const viewerAfterBlock = (await listTargets(opts.port)).some(
      (target) => target.url.includes(`${extensionId}/viewer/viewer.html`) ||
        target.url.startsWith('https://lens.google.com/') ||
        target.url.startsWith('https://www.google.com/search'),
    );
    incognitoGuard = {
      incognitoAllowed,
      response,
      optionsOpened: Boolean(optionsPage),
      pendingAfterBlock,
      viewerAfterBlock,
      verdict:
        response?.ok === false &&
        Boolean(optionsPage) &&
        !pendingAfterBlock &&
        !viewerAfterBlock
          ? 'PASS'
          : 'FAIL',
    };
    console.log('incognito permission guard:', JSON.stringify(incognitoGuard, null, 2));
  }

  writeFileSync(
    join(outDir, `result-${opts.scale}x.json`),
    JSON.stringify({
      metrics: JSON.parse(metrics),
      select: SELECT,
      scrollMode,
      scrollBefore,
      scrollAfter,
      pending,
      compare,
      incognitoGuard,
      popup: popup?.url || null,
    }, null, 2),
  );
  const cropOk = compare.geometryOk && compare.diffPixels === 0;
  const incognitoGuardOk = incognitoAllowed || incognitoGuard?.verdict === 'PASS';
  const scrollOk = scrollMode ? scrollAfter > scrollBefore : scrollAfter === scrollBefore;
  if (!scrollOk || !cropOk || !popup || !esc || !incognitoGuardOk) {
    process.exitCode = 1;
  }
  console.log('done');
  page.close();
  worker.close();
} catch (error) {
  if (workerDiagnostics.length) console.error('service worker diagnostics:', workerDiagnostics);
  console.error('FAILED', String(error));
  process.exitCode = 1;
} finally {
  browserClient?.close();
  try { browser.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  await cleanupTestExtension(extensionPath);
}

process.exit(process.exitCode || 0);
