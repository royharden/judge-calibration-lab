# LLM-Judge Calibration Mini-Lab

Compare a pointwise rubric judge with individual human annotators, inspect dev-set failures, make one human rubric edit, and confirm it against a baseline on a locked held-out split.

**Implementation complete, runtime unverified (Dirty Mode).** Source and regression tests were written and independently reviewed. Only static syntax parsing, file comparisons and manual source traces have run. Dependencies have never been installed here; TypeScript type checking, ESLint, Vitest, the evaluation scripts, Vite, Deno, migrations, browsers and provider calls have not run. No infrastructure was provisioned or deployment performed.

| Evidence | Status |
|---|---|
| Planted-defect detection and clean false flags | Not yet measured |
| Bootstrap interval coverage | Not yet measured |
| Real judge / lexical / human comparison | Not yet measured |
| Jev promotion gate | Not yet assessed; Jev is not the default |
| Live cost and provider behavior | Not yet measured |

No benchmark results are shipped. When evaluated later, `scripts/eval.ts` writes the evidence under `results/`; README performance claims must come from those outputs.

## What is built

- JSONL/manifest and per-annotator CSV import, complete refusal reports, formula-safe labelling sheets, content fingerprints and a deterministic grouped freeze.
- Immutable rubric versions, a human editor, strict judge-output parsing, seeded mock judges, lexical and modal baselines.
- Original TypeScript QWK, grouped percentile bootstrap, paired differences, Wilson intervals, PAV remap and undefined-value handling.
- Dev-only repeatability, verbosity, scale-order and injection probes; templated suggestions and append-only accept/reject rulings.
- Preregistration, two distinct held-out rubric looks per owner/content/judge scope, structural run reuse, explicit permanent burn and contamination reporting.
- A keyless page-memory journey and a Supabase-compatible live store, three ordered migrations, and the authenticated `judge-run` edge function.
- Planned calls/tokens/cost, server reservations, lease fencing, resumable chunks, ambiguous-attempt handling and ledger reconciliation.

The human reference is observed pairwise annotator agreement, **not an upper bound**. An unusable score is counted, never turned into zero. Undefined statistics remain undefined. A paired interval yields `improved`, `worse`, `no detectable change`, or `cannot support`; the UI displays the computed result.

## Run later

These are future validation commands, not checks completed during construction. Use Node 24 and npm from this inner repository root.

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

The first install creates the currently absent `package-lock.json`. Review and commit it; use `npm ci` on subsequent clean installations. Exact dependency versions are in `package.json`. Keep both browser connection variables empty for the keyless demo. See [.env.example](.env.example).

The complete activation debt and exact later checks are in [DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md). A successful frontend build alone will not validate the edge function, SQL, authorization or live providers.

## Keyless walkthrough

1. Choose **Run offline demo**. The synthetic set goes through the real importer. It starts staged, with a root rubric and the `merges-3-4` mock. Optionally validate the planted import trap and inspect its refusal details.
2. Freeze the selected set with seed `36`. Inspect achieved dev/held-out counts and compute the **dev** human reference. No held-out human reference is shown before confirmation.
3. Open **Run plan**, preview the dry run, review calls/token/USD fields, tick confirmation, and score the dev set with probes. Calls are driven by this browser; paused runs have an explicit Resume action.
4. In **Diagnostics**, load the completed dev run. Inspect intervals, baselines, confusion, probe flags and worst dev items. Accept or reject a suggestion with an optional note.
5. Open **Rubrics**, edit the relevant descriptions and supply a change note. For the synthetic merge defect, **Fill demo repair in editor** inserts `[[fixture:distinguish-3-4]]` into level 4; review it and create the child. This mechanical fixture repair proves plumbing, not judge quality.
6. Preview and confirm a dev run for the child. Revisit its diagnostics.
7. In **Confirmation**, choose the original baseline and child, then pin the comparison. Fits are computed inside the store from baseline dev evidence; the browser does not submit learned fit values.
8. Explicitly confirm both pinned held-out versions. The store authorizes the looks before scoring, then computes the report only after both runs complete. Inspect uncertainty, denominators, unusable scores, human pairs, baselines and the free remap comparison.
9. Create a third version with different text and try another comparison against the original. Its held-out authorization is refused. A typed burn and reason allow more looks, permanently marking later reports contaminated.

**Offline demo — synthetic data — page memory only: reload or reset clears everything, including look counts.** MemoryStore refuses live-provider execution. Live errors never trigger an automatic demo fallback.

## Generate evidence later

After installing and passing the normal checks, run:

```sh
npm run eval -- --self-test
npx tsx scripts/gen-fixtures.ts --seed 36 --out fixtures/synthetic
npm run eval -- --real-input /path/to/real-evaluation.json --out results/real-run-001
```

The self-test defaults to at least 201 seeds per planted behavior. Optional `--seeds` cannot reduce that floor. Detection, false-flag and coverage pass lines are proposals; the script writes actual outcomes when executed, including failures and undefined cases. Evaluation accepts a new directory, an empty directory, or the tracked `results/` containing only `.gitkeep`. It refuses directories containing prior evidence or other entries and writes new files exclusively. Use a separate `--out` path for each later invocation; prior evidence is preserved. The fixture generator requires a new output directory. These commands have not run here.

`--real-input` accepts local rows and recorded responses, never calls a provider, and recomputes reports. Its exported `RealEvaluationInput` schema is documented in [DATA.md](docs/DATA.md). Combine `--self-test --real-input <file> --out results/combined-run-001` to generate both evidence sections in a separate directory. Missing judge roles, probes or gate inputs are labelled not measured.

For a separately authorized download after licence verification:

```sh
npx tsx scripts/fetch-real-set.ts --url <explicit-https-url> --dest <new-local-file> --license-ack I-verified-dataset-and-source-licences
```

There is no default download source or bundled real data. The acknowledgement records an owner decision; the script cannot establish rights or annotator suitability.

## Live workspace

The target is **Bolt Database**, using Supabase-compatible PostgreSQL, auth and Deno interfaces. No target has been created, connected or verified. [BOLT-HANDOFF.md](BOLT-HANDOFF.md) is the single infrastructure inventory and contains an inspect-and-prepare-only prompt.

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` belong in browser configuration. Provider credentials and service-role credentials are server-only. Sign-up, login, logout, callback, recovery and live identity-change handling are implemented as source. Session loss or account change clears live snapshots and requires reopening; in-flight responses cannot reinstall an old account's snapshot.

Before live scoring, configure verified model IDs, dated price-book entries, auth settings and server secrets. Missing prices or secrets refuse the operation. Jev is pinned to `jev-1.13.0` as a judge under test; endpoint/schema/model availability must be reverified before activation. It becomes a recommended default only if the measured held-out gate supports that choice.

Run plans are saved estimates. New attempts reserve at the current dated price and settle provider-reported usage at that attempt's captured price. Unknown usage retains an ambiguous reservation for explicit owner resolution. Provider framing/token bounds and actual billing still require verification.

**Known live cache limitation:** settlement writes `response_cache`, but there is no live cache read/replay path. Identical new live dev runs still call the provider. Plan all those calls; no live cache savings are claimed. Confirmed held-out versions reuse their authorized runs structurally. Computed live report DTOs are cached locally for display; after reload, recompute them from durable rows.

## Source map

| Path | Responsibility |
|---|---|
| `src/core/` | Pure formats, statistics, probes, diagnostics, fits, report and lock policy |
| `src/shared/` | Original TypeScript provider, ledger and ruling contracts |
| `src/store/` | Common Store interface, page-memory implementation, runner and live RPC adapter |
| `src/ui/` | Explicit setup, workflow screens, human decisions and session guards |
| `supabase/migrations/` | Core/freeze, ledger/rulings, held-out/snapshot SQL |
| `supabase/functions/judge-run/` | User authentication, ownership gates, three actions and server provider calls |
| `scripts/` | Deferred evaluation, fixture generation, download and shared-file maintenance |

`scripts/function-shared-files.json` is the bundle inventory. `_core/` holds exact copies of the pure `src/core` and `src/shared` files so the function is self-contained. After changing a shared source, update its copy and verify byte equality; `npm run sync:fn` is the later maintenance command.

Read [LIMITATIONS](docs/LIMITATIONS.md), [DATA](docs/DATA.md), [VENDORED](docs/VENDORED.md), and [NOTICE](NOTICE). Source is MIT-licensed. No third-party dataset or upstream implementation code is bundled.
