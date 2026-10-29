// Gold-set import types (PLAN.md §3.4). Locally defined for M2; the integrator may move
// them into src/core/types.ts.

import type { Annotation, Item, Scale } from '../types.ts';

/** Import limits (PLAN.md §3.4, K9). */
export const IMPORT_LIMITS = {
  maxItems: 500,
  /** 20 KB of UTF-8 per text field (each fact string counts as one field). */
  maxFieldBytes: 20 * 1024,
  /** 25 MB total upload (all files together). */
  maxUploadBytes: 25 * 1024 * 1024,
  minAnnotatorsPerItem: 2,
  minLevels: 2,
  maxLevels: 7,
} as const;

export const DEFAULT_HELDOUT_FRACTION = 0.5;

export const PUBLIC_DATA_BANNER = 'Public or synthetic data only: do not upload private, personal or confidential text.';

export type ImportIssueCode =
  | 'upload_too_large'
  | 'manifest_malformed'
  | 'scale_invalid'
  | 'split_seed_invalid'
  | 'heldout_fraction_invalid'
  | 'no_items'
  | 'too_many_items'
  | 'malformed_row'
  | 'duplicate_item_id'
  | 'duplicate_content'
  | 'oversize_field'
  | 'csv_header_invalid'
  | 'no_annotator_files'
  | 'unknown_item_ref'
  | 'duplicate_annotation'
  | 'non_integer_score'
  | 'off_scale_score'
  | 'missing_label'
  | 'too_few_annotators';

export type IssueSeverity = 'blocking' | 'warning';

/**
 * Severity per code. `duplicate_content` is a warning: exact duplicates are allowed and are
 * forced into one split group (PLAN.md §3.4), but the report lists them.
 */
export const ISSUE_SEVERITY: Readonly<Record<ImportIssueCode, IssueSeverity>> = {
  upload_too_large: 'blocking',
  manifest_malformed: 'blocking',
  scale_invalid: 'blocking',
  split_seed_invalid: 'blocking',
  heldout_fraction_invalid: 'blocking',
  no_items: 'blocking',
  too_many_items: 'blocking',
  malformed_row: 'blocking',
  duplicate_item_id: 'blocking',
  duplicate_content: 'warning',
  oversize_field: 'blocking',
  csv_header_invalid: 'blocking',
  no_annotator_files: 'blocking',
  unknown_item_ref: 'blocking',
  duplicate_annotation: 'blocking',
  non_integer_score: 'blocking',
  off_scale_score: 'blocking',
  missing_label: 'blocking',
  too_few_annotators: 'blocking',
};

export type ImportIssue = {
  code: ImportIssueCode;
  severity: IssueSeverity;
  message: string;
  /** File name as supplied ("items.jsonl", "manifest.json", annotator CSV name). */
  file?: string;
  /** 1-based line within `file`. */
  line?: number;
  itemId?: string;
  annotatorId?: string;
};

export type PairOverlap = { annotatorA: string; annotatorB: string; sharedItems: number };

export type ImportCounts = {
  itemRows: number;
  items: number;
  annotatorFiles: number;
  annotators: number;
  labels: number;
  duplicateContentGroups: number;
};

export type ImportReport = {
  /** True when there is no blocking issue. */
  ok: boolean;
  blockingCount: number;
  warningCount: number;
  /** Every issue found (collected, not first-error), in file/line order. */
  issues: ImportIssue[];
  counts: ImportCounts;
  /** Per annotator pair (sorted), number of items both rated. */
  pairOverlaps: PairOverlap[];
  banner: string;
};

/** Parsed manifest.json. */
export type Manifest = {
  name: string;
  scale: Scale;
  splitSeed: number;
  heldoutFraction: number;
  freezeDate: string | null;
};

/** Raw import files. */
export type ImportFiles = {
  itemsJsonl: string;
  manifestJson: string;
  annotatorCsvs: readonly { name: string; text: string }[];
};

/**
 * Validated, not-yet-frozen gold set (K23): labels are "staged", not split. Scores are level
 * indices. Text fields are canonicalised (NFC, LF, trailing whitespace trimmed per line).
 */
export type StagedSet = {
  name: string;
  scale: Scale;
  items: Item[];
  /** itemKey -> content fingerprint. */
  fingerprints: Record<string, string>;
  stagedAnnotations: Annotation[];
  contentHash: string;
  annotationHash: string;
  splitSeed: number;
  heldoutFraction: number;
  freezeDate: string | null;
  report: ImportReport;
};
