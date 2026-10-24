# Data and provenance

Use public or synthetic data only. Imported task text, answers, sources, facts and judge output are untrusted text. They are never executed or fetched as URLs; CSV exports escape formula prefixes. The lab is not an appropriate place for private or confidential records.

## Bundled synthetic material

`src/core/fixtures/synthetic.ts` defines original invented passages, planted truth, controlled-noise annotators, separately written probe pairs and injected answers. It generates the fixture in memory from an explicit seed. Its model behavior is synthetic, including the marker-based merge repair. This material is part of the MIT-licensed source.

Small hand-written trap files live in `fixtures/traps/` and are mirrored by constants in `src/core/fixtures/traps.ts`. Named traps cover invalid imports, malformed judge output, padded pairs, constant scores, thin data, random annotators, consensus ties, injection and third-look refusal. Some are generated variants or scenario descriptions rather than standalone datasets.

No generator or evaluation script has run. `fixtures/synthetic/` generated copies and measured `results/results.md` / `results/results.jsonl` do not yet exist. Generate and verify parity only during the later validation phase.

## Real material

No real dataset is committed or verified. SummEval consistency annotations are a possible candidate, subject to checking the annotation licence, source-article rights, individual-rater availability and overlap on the intended subset. A project name or third-party fixture reference does not establish those rights. The fallback is a blind set of original synthetic answers labelled offline by Roy and another person through the blank CSV sheet.

The download script requires an explicit source and licence acknowledgement; it does not establish a dataset's licence and does not turn a downloaded file into the lab's accepted gold-set format. Inspect provenance, map individual scores onto a fixed ordinal scale, retain annotator IDs and validate with the importer. Never substitute consensus averages for individual annotations.

For every real input, record source URL/revision, licence and verification date, article rights, transformations, annotator coverage, exclusions, seed/split and content/annotation hashes. Keep downloaded or private material out of git. Public data may have appeared in model training; report that limitation.

## Local evaluation input

`npm run eval -- --real-input <file> --out results/real-run-001` reads the exported `RealEvaluationInput` contract in `scripts/eval.ts`. Use a separate output directory for each invocation; a new, empty, or `.gitkeep`-only directory is accepted, and prior evidence is never overwritten:

```ts
{
  schemaVersion: 's36-real-eval/v1',
  reports: [{
    id: 'a-local-judge-id',
    role: 'generative-small' | 'generative-large' | 'jev',
    provider: 'anthropic' | 'openai_compatible' | 'typesafe',
    split: { seed: 36, heldoutFraction: 0.5 },
    input: ReportInput,
    baselineDev: Omit<DevInput, 'probes'>,
    dev: Omit<DevInput, 'probes'>,
    recordedProbes: {
      rubric: Rubric,
      items: ExploratoryItem[],
      pairs: ExploratoryPair[],
      injections: ExploratoryInjection[],
      responses: [{ kind: 'repeatability' | 'verbosity' | 'scaleOrder' | 'injection', itemKey, replicate, presentation: 'ascending' | 'reversed', raw }]
    }
  }],
  gatePair: { jevId: 'a-local-judge-id', generativeId: 'another-local-judge-id' }
}
```

`ReportInput` is defined in `src/core/report/beforeAfter.ts`: it contains confirmed preregistration pins, current hashes, the held-out item/annotation universe, baseline/chosen verdict rows, dev fits, scale, contamination/lineage and measured costs/attempt denominators. `DevInput` is in `src/core/diagnostics/findings.ts`. **`baselineDev` and `split` are required:** supply the complete baseline dev items, annotations, keys, scale, run ID and verdicts, plus the original seed and held-out fraction. The script recomputes full content/annotation hashes and the grouped split, then fits and their input hash; the baseline run ID must match its preregistered pin. Dev/held-out items, fingerprints and groups must not overlap. Optional `dev` holds chosen-version diagnostics; `recordedProbes` and `gatePair` are also optional. Scores inside these contracts are **indices** `0..K−1`, not displayed scale values. Preserve the exact hashes, algorithm versions, run IDs and policy from the recorded comparison. Example split values above are examples only; use the actual recorded split.

When supplied, chosen-version `dev` must contain the complete same gold population as `baselineDev`: identical keys, content, groups, individual annotation rows, displayed scale values/labels and level count. Row order may differ. Chosen verdicts and their matching run ID may differ; changed labels, scales or dev subsets are refused before diagnostics are computed.

Probe recordings are optional and replayed through the strict parser without network calls. Omitted judge roles, probe recordings and gate pairs are not measured; they are not inferred from unrelated data. A confirmed rubric verdict and Jev gate require reproducible dev-fit provenance and matching held-out comparisons. Missing data must remain explicit rather than being supplied with invented rows or zero costs.

This is a reproducibility input, not an authenticated export signature or proof of how labels were obtained. Retain the original durable run records and provenance alongside it. No real inputs or evaluation outputs have been generated during construction.
