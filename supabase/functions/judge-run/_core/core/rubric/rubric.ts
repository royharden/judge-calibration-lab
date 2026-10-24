// Immutable rubric versions (PLAN.md §3.5).
//  - contentHash = sha256(canonical JSON {instructions, levels:[{value, description}]}) after
//    text canonicalisation; identical content => identical hash (ids, notes, versions excluded).
//  - createChild(parent, edits, changeNote) => new id, parentId = parent.id, version + 1,
//    new contentHash. Refused when the change note is empty or the content is unchanged.
//  - The level VALUES of a rubric are fixed by the set's scale; children only edit text.
//  - Field paths name levels by DISPLAYED value: `levels[4].description` is the level shown
//    as "4" (index 3 on a 1–5 scale). Diagnostics use the same paths (PLAN.md §1.5 step 5).
// Rubric objects are never mutated; every function returns new objects.

import type { Rubric, RubricLevel, Scale } from '../types.ts';
import type { Reason, Result } from '../result.ts';
import { fail, ok } from '../result.ts';
import { canonicalHash, normalizeText } from '../canonical.ts';

export const RUBRIC_HASH_VERSION = 'rubric-content/v1';

export type RubricContent = { instructions: string; levels: readonly RubricLevel[] };

export type RubricDraft = RubricContent & { changeNote?: string };

/** Text edits keyed by displayed level value. */
export type RubricEdits = { instructions?: string; levels?: Readonly<Record<number, string>> };

export type RubricRefusalCode =
  | 'invalid_levels'
  | 'scale_mismatch'
  | 'missing_change_note'
  | 'unknown_level'
  | 'identical_content';

export type RubricRefusal = Reason<RubricRefusalCode>;

export type RubricField = 'instructions' | `levels[${number}].description`;

export type RubricFieldDiff = { field: RubricField; before: string; after: string };

export function levelField(value: number): RubricField {
  return `levels[${value}].description`;
}

function normalizedContent(c: RubricContent): { instructions: string; levels: RubricLevel[] } {
  return {
    instructions: normalizeText(c.instructions),
    levels: c.levels.map((l) => ({ value: l.value, description: normalizeText(l.description) })),
  };
}

/** Content hash of {instructions, levels}. */
export function rubricContentHash(content: RubricContent): string {
  return canonicalHash(normalizedContent(content));
}

function validateLevels(levels: readonly RubricLevel[]): string | null {
  if (levels.length < 2 || levels.length > 7) return `a rubric needs 2–7 levels, got ${levels.length}`;
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i]!;
    if (!Number.isInteger(l.value)) return `level ${i} value must be an integer`;
    if (typeof l.description !== 'string') return `level ${i} description must be a string`;
    if (i > 0 && l.value <= levels[i - 1]!.value) return 'level values must be strictly increasing';
  }
  return null;
}

/** True when the rubric's level values equal the scale's displayed values, in order. */
export function matchesScale(rubric: Pick<Rubric, 'levels'>, scale: Scale): boolean {
  return rubric.levels.length === scale.levels.length && rubric.levels.every((l, i) => l.value === scale.levels[i]!.value);
}

/** Record identity includes its set and lineage; restoring content must not restore an ancestor's id. */
function defaultId(setId: string, parentId: string | null, version: number, contentHash: string): string {
  return `rubric-${canonicalHash({ setId, parentId, version, contentHash })}`;
}

/** Root rubric (version 1, no parent). `scale`, when given, must match the level values. */
export function createRubric(
  args: { setId: string; instructions: string; levels: readonly RubricLevel[]; changeNote?: string; id?: string },
  scale?: Scale,
): Result<Rubric, RubricRefusal> {
  const bad = validateLevels(args.levels);
  if (bad !== null) return fail('invalid_levels', bad);
  const content = normalizedContent(args);
  if (scale !== undefined && !matchesScale(content, scale)) {
    return fail('scale_mismatch', 'rubric level values must equal the set scale values');
  }
  const contentHash = canonicalHash(content);
  return ok({
    id: args.id ?? defaultId(args.setId, null, 1, contentHash),
    setId: args.setId,
    parentId: null,
    version: 1,
    instructions: content.instructions,
    levels: content.levels,
    changeNote: normalizeText(args.changeNote ?? 'initial version'),
    contentHash,
  });
}

/** Apply edits to a rubric's content (pure; unknown level values are an error). */
export function applyEdits(parent: RubricContent, edits: RubricEdits): Result<{ instructions: string; levels: RubricLevel[] }, RubricRefusal> {
  const values = new Set(parent.levels.map((l) => l.value));
  for (const key of Object.keys(edits.levels ?? {})) {
    const v = Number(key);
    if (!Number.isInteger(v) || !values.has(v)) return fail('unknown_level', `no level with displayed value ${key}`);
  }
  const levelEdits = edits.levels ?? {};
  return ok(
    normalizedContent({
      instructions: edits.instructions ?? parent.instructions,
      levels: parent.levels.map((l) => {
        const d = levelEdits[l.value];
        return { value: l.value, description: d ?? l.description };
      }),
    }),
  );
}

/** Child version: parentId = parent.id, version + 1, new hash, non-empty change note. */
export function createChild(parent: Rubric, edits: RubricEdits, changeNote: string, id?: string): Result<Rubric, RubricRefusal> {
  const note = normalizeText(changeNote).trim();
  if (note === '') return fail('missing_change_note', 'a child rubric needs a change note');
  const applied = applyEdits(parent, edits);
  if (!applied.ok) return applied;
  const contentHash = canonicalHash(applied.value);
  if (contentHash === parent.contentHash) return fail('identical_content', 'the edits do not change the rubric content');
  return ok({
    id: id ?? defaultId(parent.setId, parent.id, parent.version + 1, contentHash),
    setId: parent.setId,
    parentId: parent.id,
    version: parent.version + 1,
    instructions: applied.value.instructions,
    levels: applied.value.levels,
    changeNote: note,
    contentHash,
  });
}

/** Recompute and compare the stored hash (detects tampering / drift). */
export function verifyRubricHash(r: Rubric): boolean {
  return rubricContentHash(r) === r.contentHash;
}

/** Field-level diff: instructions and each level description (by displayed value). */
export function diffRubrics(before: RubricContent, after: RubricContent): RubricFieldDiff[] {
  const a = normalizedContent(before);
  const b = normalizedContent(after);
  const out: RubricFieldDiff[] = [];
  if (a.instructions !== b.instructions) out.push({ field: 'instructions', before: a.instructions, after: b.instructions });
  const values = [...new Set([...a.levels.map((l) => l.value), ...b.levels.map((l) => l.value)])].sort((x, y) => x - y);
  for (const v of values) {
    const da = a.levels.find((l) => l.value === v)?.description ?? '';
    const db = b.levels.find((l) => l.value === v)?.description ?? '';
    if (da !== db) out.push({ field: levelField(v), before: da, after: db });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version tree
// ---------------------------------------------------------------------------

export type RubricNode = { rubric: Rubric; children: RubricNode[] };

/** Forest of versions (roots = no parent or parent missing), children sorted by (version, id). */
export function buildVersionTree(rubrics: readonly Rubric[]): RubricNode[] {
  const byId = new Map<string, RubricNode>();
  for (const r of rubrics) byId.set(r.id, { rubric: r, children: [] });
  const roots: RubricNode[] = [];
  for (const node of byId.values()) {
    const p = node.rubric.parentId === null ? undefined : byId.get(node.rubric.parentId);
    if (p) p.children.push(node);
    else roots.push(node);
  }
  const order = (x: RubricNode, y: RubricNode): number =>
    x.rubric.version - y.rubric.version || (x.rubric.id < y.rubric.id ? -1 : x.rubric.id > y.rubric.id ? 1 : 0);
  const sortRec = (nodes: RubricNode[]): void => {
    nodes.sort(order);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Ancestors of `id`, nearest first (stops at a missing parent or a cycle). */
export function ancestors(rubrics: readonly Rubric[], id: string): Rubric[] {
  const byId = new Map(rubrics.map((r) => [r.id, r] as const));
  const out: Rubric[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur && cur.parentId !== null && !seen.has(cur.parentId)) {
    const p = byId.get(cur.parentId);
    if (!p) break;
    out.push(p);
    seen.add(p.id);
    cur = p;
  }
  return out;
}

/** Descendants of `id` (depth-first, children in tree order). */
export function descendants(rubrics: readonly Rubric[], id: string): Rubric[] {
  const out: Rubric[] = [];
  const walk = (nodes: RubricNode[], inside: boolean): void => {
    for (const n of nodes) {
      if (inside) out.push(n.rubric);
      walk(n.children, inside || n.rubric.id === id);
    }
  };
  walk(buildVersionTree(rubrics), false);
  return out;
}

/** Rubric whose level with displayed `value` contains `marker` in its description. */
export function levelDescriptionContains(rubric: Pick<Rubric, 'levels'>, value: number, marker: string): boolean {
  const l = rubric.levels.find((x) => x.value === value);
  return l !== undefined && l.description.includes(marker);
}
