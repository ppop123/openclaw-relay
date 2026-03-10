import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const sourceDir = path.join(repoRoot, 'client');
const destDir = path.join(repoRoot, 'desktop', 'webview-dist');
const excludedNames = new Set(['node_modules', 'tests', 'package.json', 'package-lock.json']);

async function copyVisibleChildren(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyVisibleChildren(from, to);
      continue;
    }
    if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to, { recursive: false });
    }
  }
}

await rm(destDir, { recursive: true, force: true });
await copyVisibleChildren(sourceDir, destDir);
const rootEntries = await readdir(destDir);
if (!rootEntries.includes('index.html')) {
  throw new Error('desktop webview-dist is missing index.html');
}
console.log(`Prepared desktop web assets in ${destDir}`);
