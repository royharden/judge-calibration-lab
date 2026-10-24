// Static syntax check for erasable-only TypeScript (.ts) using Node's built-in
// type stripper. Parses only; never imports or executes the checked files.
// Usage: node scripts/syntax-check.mjs <file.ts> [...]   (.tsx is reported as skipped)
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

let failed = 0;
for (const file of process.argv.slice(2)) {
  if (file.endsWith('.tsx')) {
    console.log(`skip ${file} (JSX: inspection only)`);
    continue;
  }
  try {
    const src = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) JSON.parse(src);
    else stripTypeScriptTypes(src, { mode: 'strip' });
    console.log(`ok   ${file}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${file}: ${String(err && err.message).split('\n')[0]}`);
  }
}
process.exitCode = failed ? 1 : 0;
