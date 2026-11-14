import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const INCLUDE = [
  'manifest.json',
  'background.js',
  'shared',
  'content',
  'viewer',
  'options',
  'icons',
  '_locales',
];

export async function prepareTestExtension({ source = '.', target = null } = {}) {
  const from = resolve(source);
  const to = target || join(from, '.test-build');
  if (existsSync(to)) await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });

  for (const entry of INCLUDE) {
    await cp(join(from, entry), join(to, entry), { recursive: true });
  }

  const manifestPath = join(to, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = Array.from(
    new Set([...(manifest.host_permissions || []), '<all_urls>']),
  );
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { path: to, manifest };
}

export async function cleanupTestExtension(target) {
  if (!target) return;
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
