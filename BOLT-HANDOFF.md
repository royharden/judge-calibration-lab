# Bolt infrastructure handoff: LLM-Judge Calibration Mini-Lab

## Target and readiness

- App root: this repository root, the inner `judge-calibration-lab` product folder. The outer planning/agent workspace is not the import root.
- Branch: local `main`. No remote, push, import, publication, provisioning or deployment has occurred.
- Data path: **Bolt Database**, using Supabase-compatible PostgreSQL/auth and Deno functions. Do not provision a separate remote Supabase project as an incidental prerequisite.
- Intended target: a fresh empty database. Existing connections/applied migration history: **unknown / not inspected**. If an existing target is selected, inspect its baseline first and preserve it.
- Status: **implementation complete, runtime unverified (Dirty Mode)**. Source reviews and syntax/file checks do not establish runtime readiness.
- Future Bolt action: **inspect and prepare only**. No cloud mutations or publication are authorized by this handoff.
- Owner prerequisites for a later activation: close Dirty Mode, authorize installation/validation and any GitHub transfer, choose the target and model IDs, verify dated prices and supply server secrets through settings.

## Build and connection

| Item | Implemented source / later command |
|---|---|
| Runtime | Node 24, npm; exact package versions in `package.json` |
| Initial install | `npm install` creates the absent lockfile; review/commit it, then use `npm ci` |
| Local development | `npm run dev`; explicit offline demo when browser config is absent |
| Build/output | `npm run build` → `dist/`; never run during construction |
| Type/lint/test | `npm run typecheck`, `npm run lint`, `npm test`; all pending |
| Edge check | `deno check supabase/functions/judge-run/index.ts`; pending separately |
| Client / env | `src/lib/supabase.ts`, `src/lib/env.ts`; `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only |
| Missing configuration | Setup screen, explicit offline demo; no silent fallback from live failure |
| Evidence | `npm run eval -- --self-test`; optional real input documented in `docs/DATA.md`; never executed here |

## Database inventory

Apply in this order only after explicit activation authorization and baseline inspection. None has been applied. Source assumes PostgreSQL 15+ and `pgcrypto` available in `extensions`; confirm compatibility and extension location first.

| Order | Exact migration | Main resources |
|---|---|---|
| 1 | `supabase/migrations/20261024000001_core.sql` | Canonical hashes, gold sets/items/staging/dev/held-out annotations, probes, immutable rubrics/configs, runs/jobs/verdicts, freeze/import/dev-run RPCs, RLS |
| 2 | `supabase/migrations/20261024000002_ledger.sql` | Dated price book, budgets/changes, attempts/events/cache, suggestions/rulings, request receipts, atomic lease/claim/send/settle/ambiguity RPCs, service bundles, reconciliation |
| 3 | `supabase/migrations/20261024000003_heldout.sql` | Pinned `s36-v1`, scopes/preregistrations/look-and-burn log, serialized look reuse, completion-gated report bundles, public snapshots/contamination, lineage guards |

The schema has 24 tables, each with RLS enabled. Private rows are owner-scoped through direct or parent ownership. Authenticated users cannot select held-out labels or directly write runs/verdicts/attempts/preregistrations/look logs/dev or held-out annotations/rulings. Consequential owner actions use authenticated RPCs; ledger/service operations are service-role only. These are source properties awaiting two-user runtime verification.

RPCs use a single `p_args jsonb` argument and camelCase DTOs. Core owner entrypoints include `public_snapshot`, `import_set`, `freeze_input`, `freeze_set`, `import_probe_sets`, `create_rubric`, `create_judge_config`, `create_dev_run`, `dev_run_rows`, `append_suggestions`, `append_ruling`, `request_heldout_look`, `burn_scope`, `scope_status`, `list_verdicts`, `set_budget`, `resolve_ambiguous`, and `reconcile_ledger`. Service functions cover bundles, job installation, request receipts, preregistration and ledger transitions. See the actual migrations for signatures/grants; do not infer privilege from a name.

Price rows are not a claim about current vendor prices. Enter verified dated model prices through an authorized administrative path before live calls. Missing prices refuse. Plans are saved estimates; per-attempt claims use current prices and retain an attempt price snapshot for real-usage settlement. Live cache rows are currently write-only; repeated new dev runs still call providers.

No seed migration contains real user data. Synthetic fixtures are loaded through explicit demo/import actions. Do not blindly replay migrations, drop/recreate resources or repair an existing migration ledger on a timeout. Inspect applied history and reconcile drift before retrying.

## Function

| Item | Contract |
|---|---|
| Name/source | `judge-run`, `supabase/functions/judge-run/index.ts` |
| Gateway | `supabase/config.toml`: `verify_jwt = true`; actual target JWT/gateway compatibility pending |
| Caller/auth | User JWT; `auth.getUser()` and resource ownership under user RLS before constructing/using the service client |
| Actions | `score {run_id,request_id,max_items}`, `preregister {set_id,judge_config_id,baseline_rubric_id,chosen_rubric_id,request_id}`, `report {prereg_id}` |
| Results/errors | Typed score progress, preregistration pins and computed reports; `{code,message,retryable}` failures |
| Browser transport | POST/OPTIONS CORS; CORS is not authorization |
| Call bounds | Up to 10 jobs per chunk, 45-second work budget, one call at a time, 20-second timeout plus 5-second settlement margin; proposals awaiting runtime measurement |
| Paid-call safety | Transactional reservations/caps, lease fencing, max attempts, real usage/model receipts; sent uncertainty remains ambiguous rather than free/retried |
| Shared files | `_core/` copies from `src/core` and `src/shared`; `scripts/function-shared-files.json` is the exact deployment inventory |

Handlers are `score.ts` and `integrity.ts`; `serverPlan.ts` retains installed plans. Provider wrappers live in `providers/`. The function package must include every manifest file. Recheck bundle equality after shared changes; a frontend build cannot establish Deno bundle completeness.

## Server settings — names only

| Name | Consumer / requirement |
|---|---|
| `SUPABASE_URL` | `judge-run`; platform-injected value assumed, verify availability |
| `SUPABASE_ANON_KEY` | User-context auth/ownership client; platform-injected assumption |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged client only after ownership; platform-injected assumption |
| `ANTHROPIC_API_KEY` | Anthropic live adapter |
| `OPENAI_COMPATIBLE_API_KEY` | Compatible provider adapter |
| `OPENAI_COMPATIBLE_BASE_URL` | Server-controlled compatible endpoint; no base URL from imported data |
| `TYPESAFE_API_KEY` | TypeSafe live adapter; `jev-1.13.0` is the pinned model under test |

Only the selected provider's configuration is needed for its live path. Reverify actual provider request/response fields, model availability, token limits and pricing before calling. Missing secrets produce explicit errors; no fake live verdict is substituted. Never place service/provider secrets in browser variables, source, chat, logs or this handoff.

## Auth and other services

- Email/password sign-up, login/logout, confirmation/session refresh and recovery are implemented in source.
- Configure the chosen Site URL and allow `<origin>/auth/callback` and `<origin>/auth/recovery`. Decide email confirmation policy and verify redirects at the final origin. No origin is provisioned here.
- Verify remote sign-out/account changes clear private live views and fence old asynchronous responses; same-user refresh and offline demo behavior should remain intact.
- Buckets/object storage: **not required**. Realtime: **not required**. Webhooks: **not required**. Scheduler/worker: **not required**; runs are browser-driven. Docker/CI/Terraform: **not provided or required for construction**.
- Real data, licences/article rights, provider accounts, exact generative model IDs and verified prices remain owner activation work. No real dataset is shipped.

## Acceptance debt

Every runtime check is pending. Use synthetic data and authorized scratch accounts. Follow `docs/DEFERRED-VALIDATION.md` for exact commands, including initial lockfile, type/lint/Vitest/build, Deno, SQL parsing/execution, actual grants/RLS, two-user isolation, concurrent claims/looks, fault recovery, SQL/TS Unicode/numeric/result/policy hash parity, missing-secret behavior, provider usage/cost and full browser journeys. Generate self-test evidence before making any performance claim. Missing real data means the real table and Jev gate remain unmeasured.

## One prompt after a separately authorized GitHub import

> Read BOLT-HANDOFF.md and inspect the imported source at the intended revision. The target is Bolt Database and the current status is implementation complete, runtime unverified (Dirty Mode). Compare the three implemented migrations, judge-run bundle, environment names and auth routes with the intended target. If authorized read-only access exists, inspect applied migration history and schema; preserve existing connections and data. Report concrete setup gaps, compatibility issues, owner prerequisites and a reviewable activation/validation plan. Do not create or change cloud resources, apply migrations, deploy functions, enter secrets, enable schedules or publish. Do not describe source checks or prepared resources as executed infrastructure. Keep the app design and distinguish every unverified assumption.
