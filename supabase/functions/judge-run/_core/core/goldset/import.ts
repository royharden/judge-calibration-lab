// Gold-set import (PLAN.md §3.4, K23). Pure: takes the raw file texts, returns either
// Ok(StagedSet) (no blocking issue; warnings may be present) or Err(ImportReport) listing
// EVERY issue found. Nothing is persisted by this module; callers persist only on Ok.
// Labels stay unsplit ("staged") until freeze (split.ts).

import type { Annotation } from '../types.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { annotationHashOf, contentHashOf, fingerprintItem } from './fingerprint.ts';
import type { ImportCounts, ImportFiles, ImportIssue, ImportReport, PairOverlap, StagedSet } from './types.ts';
import { IMPORT_LIMITS, PUBLIC_DATA_BANNER } from './types.ts';
import type { ParsedLabel } from './validate.ts';
import { issue, parseAnnotatorCsv, parseItemsJsonl, parseManifest, utf8Length } from './validate.ts';

function emptyCounts(): ImportCounts {
  return { itemRows: 0, items: 0, annotatorFiles: 0, annotators: 0, labels: 0, duplicateContentGroups: 0 };
}

export function buildReport(issues: ImportIssue[], counts: ImportCounts, pairOverlaps: PairOverlap[]): ImportReport {
  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  return {
    ok: blockingCount === 0,
    blockingCount,
    warningCount: issues.length - blockingCount,
    issues,
    counts,
    pairOverlaps,
    banner: PUBLIC_DATA_BANNER,
  };
}

/** Number of items rated by both annotators, for every annotator pair (sorted by ids). */
export function pairOverlapCounts(annotations: readonly { itemKey: string; annotatorId: string }[]): PairOverlap[] {
  const byAnnotator = new Map<string, Set<string>>();
  for (const a of annotations) {
    let s = byAnnotator.get(a.annotatorId);
    if (!s) {
      s = new Set<string>();
      byAnnotator.set(a.annotatorId, s);
    }
    s.add(a.itemKey);
  }
  const ids = [...byAnnotator.keys()].sort();
  const out: PairOverlap[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byAnnotator.get(ids[i]!)!;
      const b = byAnnotator.get(ids[j]!)!;
      let shared = 0;
      for (const k of a) if (b.has(k)) shared += 1;
      out.push({ annotatorA: ids[i]!, annotatorB: ids[j]!, sharedItems: shared });
    }
  }
  return out;
}

/** Validate and stage a gold set from its raw files. */
export function importGoldSet(files: ImportFiles): Result<StagedSet, ImportReport> {
  const counts = emptyCounts();
  counts.annotatorFiles = files.annotatorCsvs.length;

  // 0. Total upload bound: refuse before parsing anything large.
  let total = utf8Length(files.itemsJsonl) + utf8Length(files.manifestJson);
  for (const f of files.annotatorCsvs) total += utf8Length(f.text);
  if (total > IMPORT_LIMITS.maxUploadBytes) {
    return err(
      buildReport([issue('upload_too_large', `upload is ${total} bytes; the limit is ${IMPORT_LIMITS.maxUploadBytes}`)], counts, []),
    );
  }

  const issues: ImportIssue[] = [];

  // 1. Manifest.
  const mp = parseManifest(files.manifestJson);
  issues.push(...mp.issues);
  const manifest = mp.manifest;

  // 2. Items.
  const ip = parseItemsJsonl(files.itemsJsonl);
  issues.push(...ip.issues);
  counts.itemRows = ip.rowCount;
  counts.items = ip.items.length;
  if (ip.rowCount === 0) issues.push(issue('no_items', 'items file has no rows', { file: 'items.jsonl' }));
  if (ip.rowCount > IMPORT_LIMITS.maxItems) {
    issues.push(issue('too_many_items', `${ip.rowCount} item rows; the limit is ${IMPORT_LIMITS.maxItems}`, { file: 'items.jsonl' }));
  }

  // Duplicate normalised content (warning; forced into one split group later).
  const fingerprints: Record<string, string> = Object.create(null) as Record<string, string>;
  const byFp = new Map<string, string[]>();
  for (const it of ip.items) {
    const fp = fingerprintItem(it);
    fingerprints[it.key] = fp;
    const list = byFp.get(fp);
    if (list) list.push(it.key);
    else byFp.set(fp, [it.key]);
  }
  for (const keys of byFp.values()) {
    if (keys.length > 1) {
      counts.duplicateContentGroups += 1;
      issues.push(
        issue('duplicate_content', `items ${keys.map((k) => `"${k}"`).join(', ')} have identical normalised content (grouped at freeze)`, {
          file: 'items.jsonl',
          itemId: keys[0]!,
        }),
      );
    }
  }

  // 3. Annotator CSVs.
  if (files.annotatorCsvs.length === 0) issues.push(issue('no_annotator_files', 'at least one annotator CSV is required'));
  const validItemKeys = new Set(ip.items.map((i) => i.key));
  const labels: ParsedLabel[] = [];
  const seenPairs = new Set<string>();
  for (const f of files.annotatorCsvs) {
    const ap = parseAnnotatorCsv(f.name, f.text, manifest?.scale ?? null);
    issues.push(...ap.issues);
    for (const l of ap.labels) {
      const where = { file: l.file, line: l.line, itemId: l.itemId, annotatorId: l.annotatorId };
      if (!ip.knownIds.has(l.itemId)) {
        issues.push(issue('unknown_item_ref', `label refers to unknown item "${l.itemId}"`, where));
        continue;
      }
      const pairKey = JSON.stringify([l.annotatorId, l.itemId]);
      if (seenPairs.has(pairKey)) {
        issues.push(issue('duplicate_annotation', `annotator "${l.annotatorId}" labelled item "${l.itemId}" more than once`, where));
        continue;
      }
      seenPairs.add(pairKey);
      if (validItemKeys.has(l.itemId)) labels.push(l);
    }
  }

  // 4. Coverage: every valid item needs >= 2 distinct annotators.
  const annotatorsByItem = new Map<string, Set<string>>();
  for (const l of labels) {
    let s = annotatorsByItem.get(l.itemId);
    if (!s) {
      s = new Set<string>();
      annotatorsByItem.set(l.itemId, s);
    }
    s.add(l.annotatorId);
  }
  // Coverage is only meaningful when labels could be read against a valid scale.
  if (manifest !== null) {
    for (const it of ip.items) {
      const n = annotatorsByItem.get(it.key)?.size ?? 0;
      if (n === 0) issues.push(issue('missing_label', `item "${it.key}" has no labels`, { itemId: it.key }));
      else if (n < IMPORT_LIMITS.minAnnotatorsPerItem) {
        issues.push(
          issue('too_few_annotators', `item "${it.key}" has ${n} annotator; at least ${IMPORT_LIMITS.minAnnotatorsPerItem} distinct are required`, {
            itemId: it.key,
          }),
        );
      }
    }
  }

  const staged: Annotation[] = labels.map((l) => ({ itemKey: l.itemId, annotatorId: l.annotatorId, score: l.index }));
  counts.labels = staged.length;
  counts.annotators = new Set(staged.map((a) => a.annotatorId)).size;
  const overlaps = pairOverlapCounts(staged);
  const report = buildReport(issues, counts, overlaps);

  if (!report.ok || manifest === null) return err(report);

  return ok({
    name: manifest.name,
    scale: manifest.scale,
    items: ip.items,
    fingerprints,
    stagedAnnotations: staged,
    contentHash: contentHashOf(ip.items.map((i) => fingerprints[i.key]!)),
    annotationHash: annotationHashOf(staged, fingerprints),
    splitSeed: manifest.splitSeed,
    heldoutFraction: manifest.heldoutFraction,
    freezeDate: manifest.freezeDate,
    report,
  });
}
