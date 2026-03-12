import { mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const clientRoot = resolve(repoRoot, 'client');
const destRoot = resolve(repoRoot, 'desktop', 'webview-dist');

const ignoreNames = new Set([
  'node_modules',
  'tests',
  '.git',
  '.DS_Store',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
]);

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreNames.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  await rm(destRoot, { recursive: true, force: true });
  await copyDir(clientRoot, destRoot);
  const destStat = await stat(destRoot);
  if (!destStat.isDirectory()) {
    throw new Error('webview-dist sync failed');
  }
}

main().catch((err) => {
  console.error('[desktop] Failed to sync client assets:', err);
  process.exit(1);
});
