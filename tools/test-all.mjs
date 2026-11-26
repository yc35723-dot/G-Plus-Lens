import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const node = process.execPath;
const root = resolve('.');
const port = Number(process.env.GPLENS_PORT || 9511);

const suites = [
  ['unit settings', ['--test', 'test/settings.test.mjs']],
  ['crop @1x', ['tools/e2e-crop.mjs', '--scale', '1', '--port', String(port)]],
  ['crop @1.25x', ['tools/e2e-crop.mjs', '--scale', '1.25', '--port', String(port)]],
  ['crop @1.5x', ['tools/e2e-crop.mjs', '--scale', '1.5', '--port', String(port)]],
  ['crop frozen', ['tools/e2e-crop.mjs', '--frozen', '--port', String(port)]],
  ['cleanup', ['tools/e2e-cleanup.mjs', '--port', String(port)]],
  ['settings', ['tools/e2e-settings.mjs', '--port', String(port)]],
  ['popup close', ['tools/e2e-popup-close.mjs', '--port', String(port)]],
  ['lens upload', ['tools/e2e-lens.mjs', '--port', String(port)]],
];

function run(args) {
  return new Promise((done) => {
    const child = spawn(node, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { out += chunk; process.stderr.write(chunk); });
    child.on('close', (code) => done({ code, out }));
  });
}

const summary = [];
for (const [name, args] of suites) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const { code, out } = await run(args);
  const pass = code === 0 && (name === 'unit settings' || /"verdict": "PASS"/.test(out));
  summary.push({ name, exit: code, pass });
}

process.stdout.write('\n=== summary ===\n');
for (const row of summary) {
  process.stdout.write(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name} (exit ${row.exit})\n`);
}

const failed = summary.filter((row) => !row.pass);
process.exit(failed.length ? 1 : 0);
