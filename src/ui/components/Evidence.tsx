import type { ReactNode } from 'react';
import type { Interval, Stat } from '../../core/types.ts';
import { formatStat } from '../../core/judgestats/undefined.ts';

export function StatText({ stat, digits = 3 }: { stat: Stat; digits?: number }) {
  return <span className={stat.kind === 'undefined' ? 'undefined-stat' : 'numeric'}>{formatStat(stat, digits)}</span>;
}
export function IntervalText({ interval }: { interval: Interval }) {
  return <span className="interval"><StatText stat={interval.point} /> <small>95% CI [<StatText stat={interval.lo} />, <StatText stat={interval.hi} />]</small>{interval.droppedDraws > 0 && <small>{interval.droppedDraws} / {interval.draws} undefined draws</small>}</span>;
}
export function MetricCard({ label, stat, note }: { label: string; stat: Stat; note: string }) {
  return <article className="metric-card"><span className="eyebrow">{label}</span><div className="metric-value"><StatText stat={stat} /></div><p>{note}</p></article>;
}
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">◇</span><h3>{title}</h3><p>{children}</p></div>;
}
export function PageTitle({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return <div className="page-heading"><div className="eyebrow">{step}</div><h1>{title}</h1><p>{children}</p></div>;
}
export function EvidenceDetails({ label, value }: { label: string; value: unknown }) {
  return <details className="evidence-details"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
