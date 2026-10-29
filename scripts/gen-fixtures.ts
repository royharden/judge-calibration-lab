/** Write canonical deterministic synthetic fixture files ONLY on later owner execution.
 * npx tsx scripts/gen-fixtures.ts --seed 36 --out fixtures/synthetic
 * New directory required: existing fixture/evidence files are never overwritten.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticSet } from '../src/core/fixtures/synthetic.ts';
import { canonicalHash } from '../src/core/canonical.ts';

export function fixtureArgs(args: readonly string[]) {
  let seed = 36;
  let out = 'fixtures/synthetic';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${String(flag)} requires a value`);
    if (flag === '--seed') seed = Number(value);
    else if (flag === '--out') out = value;
    else throw new Error(`unknown option ${String(flag)}; use --seed 36 --out fixtures/synthetic`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('--seed must be an integer from 0 to 4294967295');
  return { seed, out };
}
export async function main(args: readonly string[]) {
  const opts = fixtureArgs(args);
  const set = generateSyntheticSet(opts.seed);
  const out = resolve(opts.out);
  await mkdir(out, { recursive: false });
  const files: [string, string][] = [
    ['items.jsonl', set.files.itemsJsonl], ['manifest.json', set.files.manifestJson],
    ...set.files.annotatorCsvs.map((csv): [string, string] => [csv.name, csv.text]),
    ['pairs.jsonl', set.probeFiles.pairsJsonl], ['injections.jsonl', set.probeFiles.injectionJsonl],
    ['truth.json', JSON.stringify(set.truth, null, 2) + '\n'],
    ['rubric-v1.json', JSON.stringify(set.rubricV1, null, 2) + '\n'],
    ['provenance.json', JSON.stringify({ kind: 'synthetic', version: set.version, seed: set.seed, licence: 'MIT (invented project fixtures)', contentHash: canonicalHash({ files: set.files, probeFiles: set.probeFiles }), warning: 'Invented synthetic labels and marker repairs do not establish real-judge quality.' }, null, 2) + '\n'],
  ];
  for (const [name, text] of files) await writeFile(resolve(out, name), text, { flag: 'wx' });
  console.log(`Wrote ${files.length} synthetic fixture files to ${out}; seed ${opts.seed}.`);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { console.error(`gen-fixtures: ${error instanceof Error ? error.message : String(error)}; choose a new --out directory.`); process.exitCode = 1; });
}
