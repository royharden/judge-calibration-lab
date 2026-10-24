// Core contract types shared by every milestone (PLAN.md §3.3).
// Pure TypeScript: no runtime dependencies, erasable syntax only.
//
// Scores are always level INDICES 0..K-1 internally. Displayed values (e.g. 1..5)
// exist only at the edges (import, prompt, parser, UI) and are converted with
// levelIndex()/levelValue() below.

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

export type ScaleLevel = { value: number; label: string };

/** 2–7 levels; `value`s are strictly increasing integers as displayed (e.g. 1..5). */
export type Scale = { levels: ScaleLevel[] };

/** Displayed value -> level index, or null when the value is not on the scale. */
export function levelIndex(scale: Scale, value: number): number | null {
  const i = scale.levels.findIndex((l) => l.value === value);
  return i < 0 ? null : i;
}

/** Level index -> displayed value, or null when the index is out of range. */
export function levelValue(scale: Scale, index: number): number | null {
  if (!Number.isInteger(index)) return null;
  const level = scale.levels[index];
  return level === undefined ? null : level.value;
}

/** Number of levels K. */
export function levelCount(scale: Scale): number {
  return scale.levels.length;
}

// ---------------------------------------------------------------------------
// Gold set
// ---------------------------------------------------------------------------

export type Item = {
  key: string;
  groupId?: string;
  taskText: string;
  answer: string;
  source?: string;
  facts?: string[];
};

export type Annotation = {
  itemKey: string;
  annotatorId: string;
  /** Level index 0..K-1. */
  score: number;
};

export type Split = 'dev' | 'heldout' | 'probe';

export type StratumCount = { stratum: number; count: number };

export type SplitAchieved = {
  dev: { total: number; byStratum: StratumCount[] };
  heldout: { total: number; byStratum: StratumCount[] };
};

export type SplitManifest = {
  seed: number;
  heldoutFraction: number;
  algoVersion: string;
  dev: string[];
  heldout: string[];
  splitHash: string;
  frozenAt: string;
  achieved: SplitAchieved;
};

export type GoldSet = {
  id: string;
  name: string;
  scale: Scale;
  items: Item[];
  devAnnotations: Annotation[];
  /** Private until a confirmed report; never exposed to dev-only code paths. */
  heldoutAnnotations?: Annotation[];
  split?: SplitManifest;
  contentHash: string;
  annotationHash: string;
  parentSetId?: string | null;
};

// ---------------------------------------------------------------------------
// Rubrics and judges
// ---------------------------------------------------------------------------

export type RubricLevel = { value: number; description: string };

export type Rubric = {
  id: string;
  setId: string;
  parentId: string | null;
  version: number;
  instructions: string;
  levels: RubricLevel[];
  changeNote: string;
  contentHash: string;
};

export type Provider = 'anthropic' | 'openai_compatible' | 'typesafe' | 'mock';

export type ScoreReadout = 'json_score' | 'argmax_probabilities' | 'rounded_score';

/** Presentation order of rubric levels in the prompt (scale-order probe uses 'reversed'). */
export type Presentation = 'ascending' | 'reversed';

/** Planted defects of the seeded mock judges (PLAN.md §3.7). */
export type MockDefect =
  | 'clean'
  | 'lenient'
  | 'verbosity'
  | 'merges-3-4'
  | 'flip-flop'
  | 'order-sensitive'
  | 'injection'
  | 'constant';

export type JudgeParams = {
  temperature?: number;
  maxOutputTokens: number;
  mockDefect?: MockDefect;
};

export type JudgeConfig = {
  id: string;
  provider: Provider;
  model: string;
  params: JudgeParams;
  promptTemplateVersion: string;
  outputSchemaVersion: string;
  scoreReadout: ScoreReadout;
  levelMapVersion: string;
  configHash: string;
};

/** Reason codes for a verdict that could not be used (PLAN.md §3.7). */
export type UnusableReason =
  | 'malformed_json'
  | 'extra_keys'
  | 'missing_score'
  | 'non_integer'
  | 'out_of_scale'
  | 'empty'
  | 'provider_error'
  | 'timeout';

export type RunKind = 'score' | 'repeat' | 'order' | 'verbosity' | 'injection';

/** Exactly one of `score` / `unusableReason` is non-null. Raw text is preserved, never repaired. */
export type Verdict = {
  runId: string;
  itemKey: string;
  replicate: number;
  /** Level index 0..K-1, or null when unusable. */
  score: number | null;
  unusableReason: UnusableReason | null;
  raw: string;
};

/** Minimal judge-score row consumed by judgestats: null score = unusable (skipped). */
export type JudgeScore = { itemKey: string; score: number | null };

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export type DefinedStat = { kind: 'value'; value: number };
export type UndefinedStat = { kind: 'undefined'; reason: string };

/** `undefined` is first-class and is never rendered or averaged as 0. */
export type Stat = DefinedStat | UndefinedStat;

/** Bootstrap percentile interval. `draws` = resamples performed, `droppedDraws` = undefined ones. */
export type Interval = {
  lo: Stat;
  hi: Stat;
  point: Stat;
  droppedDraws: number;
  draws: number;
};
