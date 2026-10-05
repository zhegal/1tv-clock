import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ignored = new Set(['.DS_Store', 'Thumbs.db']);

async function validateStaticFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
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
  await cp(source, destination, { recursive: true, filter: path => !ignored.has(basename(path)) });
  // One version for the complete module graph prevents a fresh entry script
  // from importing an older cached dependency after a Pages deployment.
  const names = (await readdir(destination)).filter(name => ['.js', '.css', '.html'].includes(extname(name))).sort();
  const texts = await Promise.all(names.map(name => readFile(resolve(destination, name), 'utf8')));
  const hash = createHash('sha256');
  names.forEach((name, index) => hash.update(name + '\0' + texts[index] + '\0'));
  const version = hash.digest('hex').slice(0, 12);
  for (let index = 0; index < names.length; index++) {
    const name = names[index]; let text = texts[index];
    if (extname(name) === '.js') text = text.replace(/(\bfrom\s+['"])(\.\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`);
    if (extname(name) === '.html') text = text.replace(/((?:src|href)=["']\.\/(?:clock\.js|clock\.css))(["'])/g, `$1?v=${version}$2`);
    if (text !== texts[index]) await writeFile(resolve(destination, name), text);
  }
  await writeFile(resolve(destination, '.nojekyll'), '');
  return count + 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const count = await buildPages(resolve(root, 'public'), resolve(root, '.pages'));
  console.log(`Pages: ${count} static files copied to .pages/.`);
}
