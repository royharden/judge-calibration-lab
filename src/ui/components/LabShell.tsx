import type { ReactNode } from 'react';

export const STEPS = [
  ['sets', '01', 'Gold sets', 'Import & freeze'],
  ['rubrics', '02', 'Rubrics', 'Describe your scale'],
  ['run', '03', 'Run plan', 'Preview & score'],
  ['diagnostics', '04', 'Diagnostics', 'Understand dev results'],
  ['preregister', '05', 'Confirmation', 'Pin an edit'],
  ['report', '06', 'Before / after', 'Read the evidence'],
] as const;
export type Screen = typeof STEPS[number][0];

export function LabShell({ screen, onNavigate, mode, onExit, busy, children }: {
  screen: Screen; onNavigate: (screen: Screen) => void; mode: 'demo' | 'live';
  onExit: () => void; busy: boolean; children: ReactNode;
}) {
  return <div className="lab-layout">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); onNavigate('sets'); }}><span className="brand-mark">κ</span><span>Judge Calibration<span className="brand-sub">A small lab for better rubrics</span></span></a>
      <div className="nav-caption">THE CALIBRATION LOOP</div>
      <nav aria-label="Lab workflow">{STEPS.map(([id, number, label, description]) => <button type="button" key={id} className={`nav-step ${screen === id ? 'active' : ''}`} onClick={() => onNavigate(id)} aria-current={screen === id ? 'page' : undefined}><span className="step-number">{number}</span><span>{label}<small>{description}</small></span>{screen === id && <span className="active-dot" />}</button>)}</nav>
      <div className="sidebar-foot"><span className="status-dot" />{mode === 'demo' ? 'Offline · page memory' : 'Connected workspace'}<button type="button" className="text-button" onClick={onExit} disabled={busy}>{mode === 'demo' ? 'Exit & clear demo' : 'Back to setup'}</button></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span className="breadcrumb">LAB / <strong>{STEPS.find(([id]) => id === screen)?.[2]}</strong></span><span className="tag">S36 <span aria-hidden="true">·</span> {mode === 'demo' ? 'SYNTHETIC' : 'LIVE'}</span></header>
      {mode === 'demo' && <div className="demo-banner">Offline demo — synthetic data — page memory only: reload or reset clears everything, including look counts</div>}
      <main id="main-content" className="main-content" aria-busy={busy}>{children}</main>
      <footer className="workspace-foot">One human edit. A frozen comparison. An honest result.<span>Source construction · runtime validation pending</span></footer>
    </div>
  </div>;
}
