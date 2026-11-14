import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, browserWsUrl, listTargets, parseArgs, sleep, waitFor } from './lib/cdp.mjs';

const opts = parseArgs(process.argv.slice(2));
const extensionPath = resolve(process.env.GPLENS_EXT || '.');
const profile = mkdtempSync(join(tmpdir(), 'gplens-e2e-'));

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
let extensionId = null;

function cleanup() {
  browserClient?.close();
  try { browser.kill(); } catch { /* ignore */ }
  if (!opts.keepProfile) {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

try {
  browserClient = await CDP.attach(await browserWsUrl(opts.port));
  ({ id: extensionId } = await browserClient.send('Extensions.loadUnpacked', { path: extensionPath }));
  await sleep(800);

  await browserClient.send('Target.createTarget', { url: opts.fixture });
  const pageTarget = await waitFor(async () => {
    const targets = await listTargets(opts.port);
    return targets.find((target) => target.type === 'page' && target.url.startsWith(opts.fixture.split('/fixture')[0]));
  }, { label: 'fixture tab' });

  const page = await CDP.attach(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: opts.fixture });
  await sleep(1200);

  const swTarget = await waitFor(async () => {
    const targets = await listTargets(opts.port);
    return targets.find((target) => target.type === 'service_worker' && target.url.includes(extensionId));
  }, { label: 'service worker' });

  const worker = await CDP.attach(swTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const tabId = await worker.evaluate(`(async()=>{
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url.startsWith(${JSON.stringify(opts.fixture.split('/fixture')[0])}));
    return tab ? tab.id : tabs[0].id;
  })()`);

  console.log(JSON.stringify({ extensionId, tabId, scale: opts.scale }, null, 2));

  const result = await worker.evaluate(`probe(${tabId})`);
  console.log(JSON.stringify(result, null, 2));

  page.close();
  worker.close();
} catch (error) {
  console.error('FAILED', String(error));
  process.exitCode = 1;
} finally {
  cleanup();
}

process.exit(process.exitCode || 0);
