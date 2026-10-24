# Vendored / shared-contract modules

The portfolio's shared contract (`PortfolioBuilder/ideas/small-apps/00-shared-contract.md`, §3 "Shared
modules") names modules that an owning repo publishes and consumers copy in, recording the source commit
here. For this lab, spec review finding F8 was accepted: the three modules this app consumes are **minimal,
original TypeScript implementations** written in this repository under `src/shared/`. The owning repos'
modules are specified for a Python stack, and **no upstream TypeScript source exists to copy or cite**, so
there is no upstream commit to record. Nothing below was copied from another codebase.

| Module (contract §3) | File here | Contract interface followed | Provenance | What is deliberately narrower than the contract |
|---|---|---|---|---|
| `callledger` (owner S3) | `src/shared/callledger.ts` (+ pure cost helpers in `src/core/plan/costBound.ts`) | Per-call record of run id, provider, model, provider-reported input/output tokens, cost from a **dated price table**, status and raw response; a **hard budget cap enforced before the call** | Original TypeScript, this repo (S36 construction run, 2026-10-24). No upstream TS source. | In-memory only (MemoryStore); the durable copy is the SQL ledger in `supabase/migrations/…02_ledger.sql`, which mirrors the same claim / mark_sent / settle / fail_before_call / ambiguous semantics. No JSONL/SQLite files, no `ledger report` CLI, no latency/TTFT spans, no OpenTelemetry export. Adds lease + claim-token fencing, max 2 attempts per item/replicate, worst-case reservation, ambiguous-attempt handling and an event-sum reconciliation that the contract does not require. |
| `rulings` (owner S2) | `src/shared/rulings.ts` | Append-only log of human decisions keyed by a stable id; conflict detection when the underlying record changed | Original TypeScript, this repo (S36 construction run, 2026-10-24). No upstream TS source. | Keyed by suggestion id (not item/field id); "underlying record changed" is the `input_hash` staleness rule (a newer completed dev score run for the same set/rubric/judge config, or a hash that no longer matches its run, rejects the ruling). No JSONL file, no replay-on-rerun, no export of decisions as gold labels (rulings here decide rubric-edit suggestions, not labels). Durable copy: `rulings` table + `append_ruling` RPC. |
| `providers` (owner S3) | `src/shared/providers.ts` (written in a later M3 pass) | Follows the contract §3 `providers` interface: one adapter interface with `anthropic`, `openai_compatible`, `typesafe` (Jev) and `mock` adapters and schema validation of the output | Original TypeScript implementation, this repo. **No upstream TypeScript source exists.** | Pure request builders / response parsers only; network calls (with timeout) live in the `judge-run` edge function, and every call goes through the call ledger. |

If an owning repo later publishes a TypeScript version of any of these modules, replace the row's
provenance with the upstream repository and commit and note any behavioural differences.
