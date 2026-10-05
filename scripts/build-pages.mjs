import { cp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function validateStaticFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) count += await validateStaticFiles(path);
    else {
      if (!entry.isFile() || (await stat(path)).size >= 100 * 1024 * 1024) {
        throw new Error(`Invalid or oversized static file: ${entry.name}`);
      }
      count++;
    }
  }
  return count;
}

export async function buildPages(source, destination) {
  const count = await validateStaticFiles(source);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  await writeFile(resolve(destination, '.nojekyll'), '');
  return count + 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const count = await buildPages(resolve(root, 'public'), resolve(root, '.pages'));
  console.log(`Pages: ${count} static files copied to .pages/.`);
}
