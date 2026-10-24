// Jev promotion gate (PLAN.md §3.12, K15).
//
// Promote Jev (provider `typesafe`) to README default judge only if
//  (a) Jev's held-out κ point > the lexical baseline's κ (lexical undefined ⇒ `cannot_assess`:
//      "cannot assess usefulness"), and
//  (b) either (b1) the paired Δκ(Jev − generative) 95% CI lies entirely within ±margin (s36-v1:
//      0.05), or (b2) the CI lower bound > −margin AND Jev's measured cost/100 is lower.
// An interval that merely overlaps 0 is NEVER read as equivalence.
//
// Pairing across judges: both confirmed reports come from preregistrations whose CHOSEN rubric
// hash is identical on the same split (and content); Δκ uses identical item draws over items
// usable by both judges with the frozen-annotator-basis rule (judgestats `pairedJudgeDelta`, with
// the generative judge as "baseline" and Jev as "chosen"). Each judge config keeps its own
// two-looks scope; this function only reads already-confirmed held-out verdict rows.

import type { Annotation, Interval, JudgeScore, Provider, Stat } from '../types.ts';
import { allItemKeys, type ResampleUnit } from '../judgestats/bootstrap.ts';
import { judgeAgreement } from '../judgestats/agreement.ts';
import { pairedJudgeDelta } from '../judgestats/paired.ts';
import { formatStat, undefinedInterval, undef } from '../judgestats/undefined.ts';
import type { HeldoutPolicy } from './policyConst.ts';
import { policyBootstrapOptions, S36_V1 } from './policyConst.ts';

export type JevGateOutcome = 'promoted' | 'not_promoted' | 'inconclusive' | 'cannot_assess';

export type JevGateReason =
  // pairing / input problems (cannot_assess)
  | 'jev_not_typesafe'
  | 'generative_is_typesafe'
  | 'same_judge_config'
  | 'report_not_confirmed'
  | 'rubric_hash_differs'
  | 'split_differs'
  | 'lexical_undefined'
  | 'jev_kappa_undefined'
  // decisions
  | 'not_better_than_lexical'
  | 'paired_interval_undefined'
  | 'equivalent_within_margin'
  | 'non_inferior_and_cheaper'
  | 'interval_straddles_margin'
  | 'worse_beyond_margin'
  | 'non_inferior_but_not_cheaper'
  | 'cost_unmeasured';

export type JevGateJudge = {
  judgeConfigHash: string;
  provider: Provider;
  preregId: string;
  /** Chosen rubric hash of the preregistration this held-out run belongs to. */
  chosenRubricHash: string;
  splitHash: string;
  contentHash: string;
  /** true when the held-out report for this preregistration is confirmed (runs complete). */
  confirmed: boolean;
  /** Per-item held-out verdict rows of the CHOSEN rubric (null score = unusable). */
  heldoutVerdicts: readonly JudgeScore[];
  /** Lexical baseline held-out κ from this judge's report (same set and split for both judges). */
  lexicalKappa: Stat;
  /** Measured cost per 100 items in USD (from settled ledger rows); null when not measured. */
  costPer100Usd: number | null;
};

export type JevGateInput = {
  jev: JevGateJudge;
  generative: JevGateJudge;
  /** Held-out annotations of the shared split (released only for confirmed reports). */
  heldoutAnnotations: readonly Annotation[];
  /** Number of scale levels K. */
  k: number;
  /** Resampling units of the held-out split (groups). */
  units: readonly ResampleUnit[];
};

export type JevGateResult = {
  outcome: JevGateOutcome;
  reasons: JevGateReason[];
  messages: string[];
  jevKappa: Stat;
  generativeKappa: Stat;
  lexicalKappa: Stat;
  /** Paired Δκ (Jev − generative). */
  delta: Interval;
  margin: number;
  costPer100Usd: { jev: number | null; generative: number | null };
  criteria: { a: boolean | null; b1: boolean | null; b2: boolean | null };
  commonItemCount: number;
  basisSize: number;
  policyVersion: string;
};

function pairingProblems(jev: JevGateJudge, gen: JevGateJudge): { reasons: JevGateReason[]; messages: string[] } {
  const reasons: JevGateReason[] = [];
  const messages: string[] = [];
  if (jev.provider !== 'typesafe') {
    reasons.push('jev_not_typesafe');
    messages.push(`the Jev input must be a typesafe judge (got ${jev.provider})`);
  }
  if (gen.provider === 'typesafe') {
    reasons.push('generative_is_typesafe');
    messages.push('the comparison judge must be a generative (non-typesafe) judge');
  }
  if (jev.judgeConfigHash === gen.judgeConfigHash) {
    reasons.push('same_judge_config');
    messages.push('both inputs use the same judge config');
  }
  if (!jev.confirmed || !gen.confirmed) {
    reasons.push('report_not_confirmed');
    messages.push('both held-out reports must be confirmed');
  }
  if (jev.chosenRubricHash !== gen.chosenRubricHash) {
    reasons.push('rubric_hash_differs');
    messages.push('the two preregistrations must share the same chosen rubric hash');
  }
  if (jev.splitHash !== gen.splitHash || jev.contentHash !== gen.contentHash) {
    reasons.push('split_differs');
    messages.push('the two held-out runs must use the same frozen split of the same content');
  }
  return { reasons, messages };
}

function fmtUsd(v: number | null): string {
  return v === null ? 'not measured' : `$${v.toFixed(4)}`;
}

export function jevGate(input: JevGateInput, policy: HeldoutPolicy = S36_V1): JevGateResult {
  const { jev, generative: gen } = input;
  const margin = policy.jevMargin;
  const opts = policyBootstrapOptions(policy);
  const lexicalKappa = jev.lexicalKappa;
  const costs = { jev: jev.costPer100Usd, generative: gen.costPer100Usd };

  const base = {
    lexicalKappa,
    margin,
    costPer100Usd: costs,
    policyVersion: policy.version,
  };

  const pairing = pairingProblems(jev, gen);
  if (pairing.reasons.length > 0) {
    const na = undef('pairing requirements not met');
    return {
      ...base,
      outcome: 'cannot_assess',
      reasons: pairing.reasons,
      messages: pairing.messages,
      jevKappa: na,
      generativeKappa: na,
      delta: undefinedInterval(na, 'pairing requirements not met'),
      criteria: { a: null, b1: null, b2: null },
      commonItemCount: 0,
      basisSize: 0,
    };
  }

  const itemKeys = allItemKeys(input.units);
  const agreeOpts = { overlapFloor: opts.overlapFloor, itemKeys };
  const jevKappa = judgeAgreement(jev.heldoutVerdicts, input.heldoutAnnotations, input.k, agreeOpts).value;
  const generativeKappa = judgeAgreement(gen.heldoutVerdicts, input.heldoutAnnotations, input.k, agreeOpts).value;
  const paired = pairedJudgeDelta(gen.heldoutVerdicts, jev.heldoutVerdicts, input.heldoutAnnotations, input.k, input.units, opts);
  const decision = decideJevGate({ jevKappa, lexicalKappa, delta: paired.delta, costPer100Usd: costs, margin });
  return {
    ...base,
    ...decision,
    jevKappa,
    generativeKappa,
    delta: paired.delta,
    commonItemCount: paired.commonItemKeys.length,
    basisSize: paired.basis.length,
  };
}

export type JevGateDecisionInput = {
  jevKappa: Stat;
  lexicalKappa: Stat;
  /** Paired Δκ (Jev − generative). */
  delta: Interval;
  costPer100Usd: { jev: number | null; generative: number | null };
  margin: number;
};

export type JevGateDecision = {
  outcome: JevGateOutcome;
  reasons: JevGateReason[];
  messages: string[];
  criteria: { a: boolean | null; b1: boolean | null; b2: boolean | null };
};

/** The §3.12 decision rule on already-computed statistics (pure; exported for tests and recompute). */
export function decideJevGate(d: JevGateDecisionInput): JevGateDecision {
  const { jevKappa, lexicalKappa, delta, margin } = d;
  const costs = d.costPer100Usd;
  if (lexicalKappa.kind === 'undefined') {
    return {
      outcome: 'cannot_assess',
      reasons: ['lexical_undefined'],
      messages: [`cannot assess usefulness: lexical baseline κ is ${formatStat(lexicalKappa)}`],
      criteria: { a: null, b1: null, b2: null },
    };
  }
  if (jevKappa.kind === 'undefined') {
    return {
      outcome: 'cannot_assess',
      reasons: ['jev_kappa_undefined'],
      messages: [`Jev held-out κ is ${formatStat(jevKappa)}`],
      criteria: { a: null, b1: null, b2: null },
    };
  }
  const a = jevKappa.value > lexicalKappa.value;
  if (!a) {
    return {
      outcome: 'not_promoted',
      reasons: ['not_better_than_lexical'],
      messages: [`Jev κ ${formatStat(jevKappa)} is not above lexical κ ${formatStat(lexicalKappa)}`],
      criteria: { a, b1: null, b2: null },
    };
  }
  if (delta.lo.kind === 'undefined' || delta.hi.kind === 'undefined' || delta.point.kind === 'undefined') {
    const why = delta.point.kind === 'undefined' ? delta.point.reason : delta.lo.kind === 'undefined' ? delta.lo.reason : 'undefined bound';
    return {
      outcome: 'inconclusive',
      reasons: ['paired_interval_undefined'],
      messages: [`paired Δκ(Jev − generative) interval undefined (${why})`],
      criteria: { a, b1: null, b2: null },
    };
  }
  const lo = delta.lo.value;
  const hi = delta.hi.value;
  const ci = `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
  const b1 = lo >= -margin && hi <= margin;
  const cheaper = costs.jev !== null && costs.generative !== null ? costs.jev < costs.generative : null;
  const b2 = lo > -margin && cheaper === true;
  const criteria = { a, b1, b2 };
  if (b1) {
    return { outcome: 'promoted', reasons: ['equivalent_within_margin'], messages: [`paired Δκ 95% CI ${ci} lies within ±${margin}`], criteria };
  }
  if (b2) {
    return {
      outcome: 'promoted',
      reasons: ['non_inferior_and_cheaper'],
      messages: [`paired Δκ 95% CI lower bound ${lo.toFixed(3)} > −${margin}; cost/100 ${fmtUsd(costs.jev)} < ${fmtUsd(costs.generative)}`],
      criteria,
    };
  }
  if (hi < -margin) {
    return { outcome: 'not_promoted', reasons: ['worse_beyond_margin'], messages: [`paired Δκ 95% CI ${ci} lies below −${margin}`], criteria };
  }
  if (lo > -margin) {
    // Non-inferior, not within the margin (so hi > margin), and not shown cheaper.
    if (cheaper === null) {
      return {
        outcome: 'inconclusive',
        reasons: ['cost_unmeasured'],
        messages: [`paired Δκ 95% CI ${ci} is non-inferior but not within ±${margin}, and cost/100 is not measured for both judges`],
        criteria,
      };
    }
    return {
      outcome: 'not_promoted',
      reasons: ['non_inferior_but_not_cheaper'],
      messages: [`paired Δκ 95% CI ${ci} is not within ±${margin} and Jev cost/100 ${fmtUsd(costs.jev)} is not lower than ${fmtUsd(costs.generative)}`],
      criteria,
    };
  }
  return {
    outcome: 'inconclusive',
    reasons: ['interval_straddles_margin'],
    messages: [`paired Δκ 95% CI ${ci} crosses −${margin}; overlap with 0 is not equivalence`],
    criteria,
  };
}

