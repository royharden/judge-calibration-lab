import { useEffect, useState } from 'react';
import type { Rubric } from '../../core/types.ts';
import type { PublicGoldSet, Store } from '../../store/Store.ts';
import { diffRubrics } from '../../core/rubric/rubric.ts';
import { MERGE_FIX_MARKER } from '../../core/judge/mock.ts';
import type { Action } from '../uiTypes.ts';
import { EmptyState, EvidenceDetails, PageTitle } from '../components/Evidence.tsx';

export function Rubrics({ store, set, rubrics, selected, select, act, busy, next, demo }: {
  store: Store; set: PublicGoldSet | undefined; rubrics: Rubric[]; selected: Rubric | undefined;
  select: (id: string) => void; act: Action; busy: boolean; next: () => void; demo: boolean;
}) {
  const [instructions, setInstructions] = useState('Score the answer against the task and source. Use the concrete level descriptions.');
  const [levels, setLevels] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  useEffect(() => {
    setInstructions(selected?.instructions ?? 'Score the answer against the task and source. Use the concrete level descriptions.');
    setLevels(Object.fromEntries((selected?.levels ?? set?.scale.levels.map((level) => ({ value: level.value, description: level.label })) ?? []).map((level) => [level.value, level.description])));
    setNote('');
  }, [selected, set]);
  if (!set) return <><PageTitle step="02 / RUBRICS" title="Give each score a meaning.">Every edit becomes an immutable child version.</PageTitle><EmptyState title="Select a gold set first">The scale belongs to a set and stays fixed across rubric versions.</EmptyState></>;
  const parent = rubrics.find((rubric) => rubric.id === selected?.parentId);
  return <><PageTitle step="02 / RUBRICS" title="Concrete levels. Traceable edits.">Write the situations each level describes. The lab can suggest where to clarify; you decide the wording and create each version.</PageTitle><div className="grid-two"><section className="panel"><h2>Version history</h2><p>{set.name} · {set.scale.levels.length} fixed levels</p><div className="version-tree">{rubrics.map((rubric) => <article className="version-node" key={rubric.id}><button type="button" className={selected?.id === rubric.id ? 'primary' : ''} onClick={() => select(rubric.id)}>v{rubric.version} · {rubric.changeNote}</button><small className="code-label">{rubric.contentHash}</small>{rubric.parentId && <small>Child of {rubrics.find((r) => r.id === rubric.parentId)?.changeNote ?? rubric.parentId}</small>}</article>)}</div>{parent && selected && <EvidenceDetails label="Changes from parent" value={diffRubrics(parent, selected)} />}
      <div className="notice">Identical rubric text has the same content hash. Version identity also records its set and ancestry.</div><button type="button" onClick={next} disabled={!selected || !set.frozen}>Continue to run plan →</button></section>
    <section className="panel"><h2>{selected ? `Create a child of v${selected.version}` : 'Create your first rubric'}</h2><label>Judge instructions<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>{set.scale.levels.map((level) => <label key={level.value}>Level {level.value} · {level.label}<textarea value={levels[level.value] ?? ''} onChange={(e) => setLevels({ ...levels, [level.value]: e.target.value })} /></label>)}<label>Change note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed, and why?" /></label>
      {demo && selected && selected.levels.some((level) => level.value === 4) && <div className="notice"><strong>Mechanical fixture repair</strong><p className="prose-note">The synthetic merge defect recognizes a marker in level 4. This proves plumbing, not judge quality. Review the editor, then create the child yourself.</p><button type="button" onClick={() => { setLevels({ ...levels, 4: `${levels[4] ?? ''} ${MERGE_FIX_MARKER}` }); setNote('Mechanical fixture repair: distinguish levels 3 and 4; proves plumbing only.'); }}>Fill demo repair in editor</button></div>}
      <button type="button" className="primary" disabled={busy || !note.trim() || !instructions.trim()} onClick={() => void act(() => selected ? store.createChild({ rubricId: selected.id, edits: { instructions, levels }, changeNote: note }) : store.createRubric({ setId: set.id, instructions, levels: set.scale.levels.map((level) => ({ value: level.value, description: levels[level.value] ?? '' })), changeNote: note }), (rubric) => select(rubric.id))}>{selected ? 'Create immutable child version' : 'Create initial rubric'}</button>
    </section></div></>;
}
