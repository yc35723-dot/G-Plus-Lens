const BRAVE_DEFAULT = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const USER = {
  browser: process.env.GPLENS_BROWSER || BRAVE_DEFAULT,
  port: Number(process.env.GPLENS_PORT || 9411),
  scale: process.env.GPLENS_SCALE || '1',
  fixture: process.env.GPLENS_FIXTURE || 'http://127.0.0.1:8471/fixture.html',
  keepProfile: process.env.GPLENS_KEEP_PROFILE === '1',
};

export function parseArgs(argv) {
  const out = { ...USER };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--browser' && next) { out.browser = next; i += 1; }
    else if (key === '--port' && next) { out.port = Number(next); i += 1; }
    else if (key === '--scale' && next) { out.scale = next; i += 1; }
    else if (key === '--fixture' && next) { out.fixture = next; i += 1; }
    else if (key === '--keep-profile') out.keepProfile = true;
  }
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(fn, { tries = 120, delay = 200, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep waiting */
    }
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('websocket failed'));
    });
    const client = new CDP(ws);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && client.pending.has(msg.id)) {
        const { resolve, reject } = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      } else if (msg.method) {
        client.events.push(msg);
      }
    };
    return client;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, { awaitPromise = true, byValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: byValue,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description || '')}`);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function browserWsUrl(port) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    const info = await response.json();
    return info.webSocketDebuggerUrl;
  }, { label: 'devtools endpoint' });
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}
