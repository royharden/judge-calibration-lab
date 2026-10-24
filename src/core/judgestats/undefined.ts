// Stat helpers. `undefined` is a first-class statistic outcome with a reason; it is
// never coerced to 0, never averaged, and always printed as "undefined (reason)".

import type { DefinedStat, Interval, Stat, UndefinedStat } from '../types.ts';

/** Defined statistic; non-finite numbers become undefined rather than leaking NaN. */
export function value(v: number): Stat {
  return Number.isFinite(v) ? { kind: 'value', value: v } : undef(`non-finite value (${String(v)})`);
}

export function undef(reason: string): UndefinedStat {
  return { kind: 'undefined', reason };
}

export function isDefined(s: Stat): s is DefinedStat {
  return s.kind === 'value';
}

/** Numeric value or null (for JSON rows); never 0 for undefined. */
export function statToNullable(s: Stat): number | null {
  return s.kind === 'value' ? s.value : null;
}

/** Arithmetic mean as a Stat; undefined for an empty list. */
export function meanStat(values: readonly number[], emptyReason = 'no values'): Stat {
  if (values.length === 0) return undef(emptyReason);
  let sum = 0;
  for (const v of values) sum += v;
  return value(sum / values.length);
}

/** Fixed-point text, or "undefined (reason)". Never prints 0 for an undefined stat. */
export function formatStat(s: Stat, digits = 3): string {
  return s.kind === 'value' ? s.value.toFixed(digits) : `undefined (${s.reason})`;
}

/** "0.712 [0.601, 0.803]" or "0.712 [interval undefined (reason)]" or "undefined (reason)". */
export function formatInterval(i: Interval, digits = 3): string {
  const point = formatStat(i.point, digits);
  if (i.point.kind === 'undefined') return point;
  if (i.lo.kind === 'undefined') return `${point} [interval ${formatStat(i.lo, digits)}]`;
  if (i.hi.kind === 'undefined') return `${point} [interval ${formatStat(i.hi, digits)}]`;
  return `${point} [${formatStat(i.lo, digits)}, ${formatStat(i.hi, digits)}]`;
}

/** Undefined interval with the same reason on both bounds. */
export function undefinedInterval(point: Stat, reason: string, draws = 0, droppedDraws = 0): Interval {
  return { point, lo: undef(reason), hi: undef(reason), draws, droppedDraws };
}
