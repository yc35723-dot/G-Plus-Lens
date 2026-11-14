import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, browserWsUrl, listTargets, parseArgs, sleep, waitFor } from './lib/cdp.mjs';
import { cleanupTestExtension, prepareTestExtension } from './lib/ext.mjs';

const opts = parseArgs(process.argv.slice(2));
const source = resolve(process.env.GPLENS_EXT || '.');
const fixture = opts.fixture || 'http://127.0.0.1:8471/fixture.html';
const outDir = resolve(opts.outDir || 'test/artifacts');
const profile = mkdtempSync(join(tmpdir(), 'gplens-lens-'));
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

let browserClient = null;

try {
  browserClient = await CDP.attach(await browserWsUrl(opts.port));
  const { id: extensionId } = await browserClient.send('Extensions.loadUnpacked', { path: built.path });
  await sleep(700);
  console.log('extension:', extensionId);

  const origin = new URL(fixture).origin;
  await browserClient.send('Target.createTarget', { url: fixture });
  await waitFor(async () => (await listTargets(opts.port)).find((t) => t.type === 'page' && t.url.startsWith(origin)), { label: 'fixture' });
  await sleep(1500);

  const swTarget = await waitFor(async () => (await listTargets(opts.port)).find((t) => t.type === 'service_worker' && t.url.includes(extensionId)), { label: 'sw' });
  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const dataUrl = await worker.evaluate(`(async()=>{
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(origin)}));
    if (!tab) return JSON.stringify({ error: 'no fixture tab', urls: tabs.map((t) => t.url) });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, 400));
    const shot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
    const canvas = new OffscreenCanvas(320, 200);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(bitmap, 80, 60, 320, 200, 0, 0, 320, 200);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return JSON.stringify({ crop: 'data:image/png;base64,' + btoa(bin), tabId: tab?.id ?? null });
  })()`);
  const { crop, tabId } = JSON.parse(dataUrl);
  console.log('crop bytes:', crop.length, 'tab', tabId);

  await worker.evaluate(`(async()=>{
    await chrome.storage.session.set({ 'gplens:pending': { dataUrl: ${JSON.stringify(crop)}, lang: 'zh-TW', createdAt: Date.now() } });
    await chrome.windows.create({
      url: chrome.runtime.getURL('viewer/viewer.html'),
      type: 'popup', focused: true, left: 40, top: 40, width: 520, height: 760,
    });
    return 'ok';
  })()`);
  console.log('viewer opened');

  await sleep(1500);
  const targets0 = await listTargets(opts.port);
  const viewer = targets0.find((t) => t.url.includes('/viewer/viewer.html'));
  if (viewer) {
    const vp = await CDP.attach(viewer.webSocketDebuggerUrl);
    await vp.send('Runtime.enable');
    await vp.send('Log.enable');
    const diag = [];
    vp.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Log.entryAdded') diag.push(['log', msg.params.entry.level, msg.params.entry.text.slice(0, 300)]);
      if (msg.method === 'Runtime.exceptionThrown') diag.push(['exc', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description?.slice(0, 300)]);
    });
    await sleep(800);
    console.log('viewer state:', await vp.evaluate(`JSON.stringify({
      cls: document.getElementById('app').className,
      status: document.getElementById('status').textContent,
      forms: document.querySelectorAll('form').length,
      fileLen: document.querySelector('input[type=file]')?.files?.length ?? null,
      href: location.href,
      online: navigator.onLine,
      vis: document.visibilityState,
    })`));
    await vp.send('Network.enable').catch(() => {});
    for (let i = 0; i < 3; i += 1) {
      await sleep(2000);
      console.log(`probe+${i}`, await vp.evaluate(`JSON.stringify({
        href: location.href,
        cls: document.getElementById('app')?.className,
        status: document.getElementById('status')?.textContent,
        forms: document.querySelectorAll('form').length,
      })`).catch((error) => `detached: ${String(error).slice(0, 60)}`));
    }
    console.log('viewer diag:', JSON.stringify(diag, null, 2));
    vp.close();
  }

  const seen = new Set();
  const observed = [];
  let searchHit = null;

  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const targets = await listTargets(opts.port);
    for (const target of targets) {
      const key = `${target.type} ${target.url.slice(0, 100)}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!target.url.startsWith('devtools://') && (target.url.startsWith('http') || target.url.startsWith('chrome-extension'))) {
          console.log(`t+${(i + 1) * 0.5}s`, target.type, target.url.slice(0, 120));
        }
      }
      if (target.url.startsWith('https://www.google.com/search?') && !searchHit) {
        searchHit = target.url;
      }
    }
    if (searchHit && i > 6) break;
  }

  const finalUrls = (await listTargets(opts.port))
    .filter((t) => t.type === 'page' && (t.url.startsWith('http') || t.url.startsWith('chrome-extension')))
    .map((t) => t.url);

  let viaContinue = null;
  for (const url of finalUrls) {
    if (!url.includes('/sorry/')) continue;
    const match = /[?&]continue=([^&]+)/.exec(url);
    if (!match) continue;
    const decoded = decodeURIComponent(match[1]);
    if (/google\.com\/search\?.*vsrid=/.test(decoded)) viaContinue = decoded;
  }

  const accepted = Boolean(searchHit || viaContinue);
  const resultUrl = searchHit || viaContinue;
  const summary = {
    extensionId,
    uploadAccepted: accepted,
    hasVsrid: resultUrl ? /[?&]vsrid=/.test(resultUrl) : false,
    reached: searchHit ? 'search' : viaContinue ? 'sorry-redirect' : 'none',
    resultUrl: resultUrl ? resultUrl.slice(0, 160) : null,
    finalUrls: finalUrls.map((u) => u.slice(0, 120)),
    rateLimited: finalUrls.some((u) => u.includes('/sorry/')),
    note: viaContinue
      ? 'Google rate-limited this IP (429). The /sorry redirect still carries the vsrid result URL, proving the upload was accepted.'
      : null,
    verdict: accepted ? 'PASS' : 'FAIL',
  };
  writeFileSync(join(outDir, 'lens-flow.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!accepted) process.exitCode = 1;
} catch (error) {
  console.error('FAILED', String(error));
  process.exitCode = 1;
} finally {
  browserClient?.close();
  try { browser.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  await cleanupTestExtension(built.path);
}

process.exit(process.exitCode || 0);
