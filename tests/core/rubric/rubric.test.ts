import { describe, expect, it } from 'vitest';
import type { Rubric } from '../../../src/core/types.ts';
import {
  ancestors,
  buildVersionTree,
  createChild,
  createRubric,
  descendants,
  diffRubrics,
  levelDescriptionContains,
  levelField,
  matchesScale,
  rubricContentHash,
  verifyRubricHash,
} from '../../../src/core/rubric/rubric.ts';
import { unwrap } from '../../../src/core/result.ts';
import {
  SYNTHETIC_RUBRIC_V1,
  SYNTHETIC_SCALE,
  SYNTHETIC_V2_CHANGE_NOTE,
  syntheticRubricV2Edits,
  syntheticRubricV3Edits,
} from '../../../src/core/fixtures/synthetic.ts';
import { MERGE_FIX_MARKER } from '../../../src/core/judge/mock.ts';

const v1 = unwrap(createRubric({ setId: 'set-1', ...SYNTHETIC_RUBRIC_V1 }, SYNTHETIC_SCALE));

describe('createRubric', () => {
  it('creates version 1 with no parent and a content hash', () => {
    expect(v1.version).toBe(1);
    expect(v1.parentId).toBeNull();
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.contentHash).toBe(rubricContentHash(v1));
    expect(verifyRubricHash(v1)).toBe(true);
    expect(matchesScale(v1, SYNTHETIC_SCALE)).toBe(true);
  });

  it('identical content => identical hash regardless of id, note, set, newline style or trailing spaces', () => {
    const other = unwrap(
      createRubric({
        setId: 'set-2',
        id: 'custom-id',
        changeNote: 'different note',
        instructions: SYNTHETIC_RUBRIC_V1.instructions + '  ',
        levels: SYNTHETIC_RUBRIC_V1.levels.map((l) => ({ ...l, description: l.description + ' \t' })),
      }),
    );
    const a = unwrap(createRubric({ setId: 's', instructions: 'line one\nline two', levels: SYNTHETIC_RUBRIC_V1.levels }));
    const b = unwrap(createRubric({ setId: 's', instructions: 'line one\r\nline two', levels: SYNTHETIC_RUBRIC_V1.levels }));
    expect(a.contentHash).toBe(b.contentHash);
    expect(other.contentHash).toBe(v1.contentHash);
    expect(other.id).toBe('custom-id');
  });

  it('refuses invalid levels and a scale mismatch', () => {
    expect(createRubric({ setId: 's', instructions: 'x', levels: [{ value: 1, description: 'a' }] }).ok).toBe(false);
    expect(
      createRubric({
        setId: 's',
        instructions: 'x',
        levels: [
          { value: 2, description: 'a' },
          { value: 1, description: 'b' },
        ],
      }).ok,
    ).toBe(false);
    const r = createRubric(
      {
        setId: 's',
        instructions: 'x',
        levels: [
          { value: 0, description: 'a' },
          { value: 1, description: 'b' },
        ],
      },
      SYNTHETIC_SCALE,
    );
    expect(!r.ok && r.error.reason).toBe('scale_mismatch');
  });

  it('identical content in different sets keeps its hash but has different record identity', () => {
    const other = unwrap(createRubric({ setId: 'set-2', ...SYNTHETIC_RUBRIC_V1 }));
    expect(other.contentHash).toBe(v1.contentHash);
    expect(other.id).not.toBe(v1.id);
  });
});

describe('createChild', () => {
  const snapshot = JSON.stringify(v1);
  const v2 = unwrap(createChild(v1, syntheticRubricV2Edits(), SYNTHETIC_V2_CHANGE_NOTE));

  it('has parentId, version + 1, a new hash and the change note', () => {
    expect(v2.parentId).toBe(v1.id);
    expect(v2.version).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    expect(v2.changeNote).toBe(SYNTHETIC_V2_CHANGE_NOTE);
    expect(v2.setId).toBe(v1.setId);
    expect(v2.id).not.toBe(v1.id);
    expect(verifyRubricHash(v2)).toBe(true);
  });

  it('applies the v2 edit: level 4 description carries the marker, others unchanged', () => {
    expect(levelDescriptionContains(v2, 4, MERGE_FIX_MARKER)).toBe(true);
    expect(levelDescriptionContains(v1, 4, MERGE_FIX_MARKER)).toBe(false);
    expect(v2.instructions).toBe(v1.instructions);
    for (const v of [1, 2, 3, 5]) {
      expect(v2.levels.find((l) => l.value === v)!.description).toBe(v1.levels.find((l) => l.value === v)!.description);
    }
  });

  it('never mutates the parent', () => {
    expect(JSON.stringify(v1)).toBe(snapshot);
  });

  it('the same edits on the same parent give the same hash', () => {
    const again = unwrap(createChild(v1, syntheticRubricV2Edits(), 'another note'));
    expect(again.contentHash).toBe(v2.contentHash);
  });

  it('restoring ancestor content makes a distinct child and preserves an acyclic version tree', () => {
    const restored = unwrap(createChild(v2, {
      instructions: v1.instructions,
      levels: Object.fromEntries(v1.levels.map((level) => [level.value, level.description])),
    }, 'Restore the original wording'));
    expect(restored.contentHash).toBe(v1.contentHash);
    expect(restored.parentId).toBe(v2.id);
    expect(restored.version).toBe(3);
    expect(new Set([v1.id, v2.id, restored.id]).size).toBe(3);
    const all = [restored, v1, v2];
    const tree = buildVersionTree(all);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.rubric.id).toBe(v1.id);
    expect(tree[0]!.children[0]!.rubric.id).toBe(v2.id);
    expect(tree[0]!.children[0]!.children[0]!.rubric.id).toBe(restored.id);
    expect(ancestors(all, restored.id).map((rubric) => rubric.id)).toEqual([v2.id, v1.id]);
    expect(descendants(all, v1.id).map((rubric) => rubric.id)).toEqual([v2.id, restored.id]);
  });

  it('same content at the same version under different parents has distinct identity', () => {
    const branch = unwrap(createChild(v1, { instructions: 'Branch wording' }, 'branch'));
    const a = unwrap(createChild(v2, { instructions: 'Shared wording' }, 'shared'));
    const b = unwrap(createChild(branch, {
      instructions: a.instructions,
      levels: Object.fromEntries(a.levels.map((level) => [level.value, level.description])),
    }, 'shared'));
    expect(a.version).toBe(b.version);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.id).not.toBe(b.id);
  });

  it('refuses unchanged content, an empty note and an unknown level', () => {
    const same = createChild(v1, { levels: { 3: v1.levels[2]!.description } }, 'no-op');
    expect(!same.ok && same.error.reason).toBe('identical_content');
    const noNote = createChild(v1, syntheticRubricV2Edits(), '   ');
    expect(!noNote.ok && noNote.error.reason).toBe('missing_change_note');
    const unknown = createChild(v1, { levels: { 9: 'x' } }, 'note');
    expect(!unknown.ok && unknown.error.reason).toBe('unknown_level');
  });

  it('diff names the changed fields by displayed level value', () => {
    expect(levelField(4)).toBe('levels[4].description');
    const d = diffRubrics(v1, v2);
    expect(d.map((x) => x.field)).toEqual(['levels[4].description']);
    expect(d[0]!.after).toContain(MERGE_FIX_MARKER);
    const v3 = unwrap(createChild(v2, syntheticRubricV3Edits(), 'third'));
    expect(diffRubrics(v1, v3).map((x) => x.field)).toEqual(['instructions', 'levels[4].description']);
    expect(diffRubrics(v1, v1)).toEqual([]);
  });
});

describe('version tree', () => {
  const v2 = unwrap(createChild(v1, syntheticRubricV2Edits(), 'v2'));
  const v3 = unwrap(createChild(v2, syntheticRubricV3Edits(), 'v3'));
  const v2b = unwrap(createChild(v1, { instructions: 'Shorter instructions.' }, 'v2b'));
  const all: Rubric[] = [v3, v2b, v1, v2];

  it('builds one root with ordered children', () => {
    const tree = buildVersionTree(all);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.rubric.id).toBe(v1.id);
    expect(tree[0]!.children.map((c) => c.rubric.id).sort()).toEqual([v2.id, v2b.id].sort());
    const v2node = tree[0]!.children.find((c) => c.rubric.id === v2.id)!;
    expect(v2node.children.map((c) => c.rubric.id)).toEqual([v3.id]);
  });

  it('ancestors and descendants', () => {
    expect(ancestors(all, v3.id).map((r) => r.id)).toEqual([v2.id, v1.id]);
    expect(ancestors(all, v1.id)).toEqual([]);
    expect(descendants(all, v1.id).map((r) => r.id).sort()).toEqual([v2.id, v2b.id, v3.id].sort());
    expect(descendants(all, v3.id)).toEqual([]);
  });
});
