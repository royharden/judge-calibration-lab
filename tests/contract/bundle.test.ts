import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/function-shared-files.json'), 'utf8')) as { version: number; files: { source: string; destination: string }[] };
function files(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(resolve(path, entry.name)) : [relative(root, resolve(path, entry.name)).replaceAll('\\', '/')]); }

describe('edge pure bundle parity', () => {
  it('contains each core/shared TypeScript source exactly once', () => {
    const expected = [...files(resolve(root, 'src/core')), ...files(resolve(root, 'src/shared'))].filter((p) => p.endsWith('.ts')).sort();
    expect(manifest.version).toBe(1);
    expect(manifest.files.map((e) => e.source).sort()).toEqual(expected);
    expect(new Set(manifest.files.map((e) => e.destination)).size).toBe(expected.length);
  });
  for (const entry of manifest.files) it(`${entry.source} is byte-identical`, () => {
    // what_bug_this_catches: browser and function silently run different lock/statistics code.
    expect(entry.source).toMatch(/^src\/(core|shared)\/.+\.ts$/);
    expect(entry.destination).toBe(`supabase/functions/judge-run/_core/${entry.source.slice(4)}`);
    expect(readFileSync(resolve(root, entry.destination)).equals(readFileSync(resolve(root, entry.source)))).toBe(true);
  });
  it('all copied relative imports stay inside the pure bundle', () => {
    for (const entry of manifest.files) {
      const source = readFileSync(resolve(root, entry.destination), 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(match[1]).toMatch(/^\.\.?\/.+\.ts$/);
        const target = resolve(root, entry.destination, '..', match[1]!);
        expect(relative(resolve(root, 'supabase/functions/judge-run/_core'), target)).not.toMatch(/^\.\./);
      }
    }
  });
});
