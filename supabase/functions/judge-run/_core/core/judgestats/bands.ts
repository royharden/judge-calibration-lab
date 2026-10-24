// Innocent band (PLAN.md §3.6): +/-0.25 level units around 0 for leniency offset,
// verbosity / scale-order / injection mean shifts. Flag ONLY when the whole 95% CI lies
// outside the band; a CI that touches or straddles the band is not flagged, and an
// undefined interval never flags.

import type { Stat } from '../types.ts';

export const DEFAULT_BAND = 0.25;

export type BandStatus = 'inside' | 'straddles' | 'outside_high' | 'outside_low' | 'undefined';

export type BandFlag = {
  flagged: boolean;
  status: BandStatus;
  /** Band half-width in level units. */
  band: number;
  /** Band as a share of the full scale, band / (K - 1); null when K is not given. */
  bandShareOfScale: number | null;
};

export function bandFlag(interval: { lo: Stat; hi: Stat }, opts: { band?: number; k?: number } = {}): BandFlag {
  const band = opts.band ?? DEFAULT_BAND;
  if (!(band >= 0)) throw new RangeError(`band must be >= 0, got ${String(band)}`);
  const bandShareOfScale = opts.k !== undefined && opts.k >= 2 ? band / (opts.k - 1) : null;
  const base = { band, bandShareOfScale };

  const { lo, hi } = interval;
  if (lo.kind === 'undefined' || hi.kind === 'undefined') return { ...base, flagged: false, status: 'undefined' };
  if (lo.value > band) return { ...base, flagged: true, status: 'outside_high' };
  if (hi.value < -band) return { ...base, flagged: true, status: 'outside_low' };
  if (lo.value >= -band && hi.value <= band) return { ...base, flagged: false, status: 'inside' };
  return { ...base, flagged: false, status: 'straddles' };
}
