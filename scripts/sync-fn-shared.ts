// Deferred maintenance tool; the construction bundle was copied with plain file copy.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./function-shared-files.json', import.meta.url), 'utf8')) as { version: number; files: { source: string; destination: string }[] };
if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('invalid shared-file manifest');
for (const entry of manifest.files) {
  if (!/^src\/(core|shared)\/.+\.ts$/.test(entry.source) || entry.destination !== `supabase/functions/judge-run/_core/${entry.source.slice(4)}`) throw new Error('manifest path outside allowed pure trees');
  const source = resolve(root, entry.source);
  const destination = resolve(root, entry.destination);
  for (const path of [source, destination]) { const rel = relative(root, path); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('manifest escapes repository'); }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
console.log(`Copied ${manifest.files.length} pure source files`);
