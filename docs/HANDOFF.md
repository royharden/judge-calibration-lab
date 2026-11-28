# Successor handoff

Logical project: `bolt-judge-calibration-lab`.

The accepted activation candidate is `4b35a5048eea4f4ccfe02c0c9c0abedfb8f07e89`. This phase continues in worktree `C:\Worktrees\Bolt.New\judge-calibration-lab\gdl09-activation-001` on branch `gdl09/activation-001`. The primary checkout stays at `2cd49d394a90fc14f7c5148a2ff7347d8bd616eb`. Do not push and do not change `origin`.

Startup is `AGENTS.md`. Chat export uses the outer shell `C:\Users\Roy Harden\OneDrive\PJ-OD\Bolt.New\judge-calibration-lab\.chatexports` with `--format both`. Transcripts stay out of this Git repository.

The carried behavior check is the existing local suite:

`npm ci --no-fund --no-audit`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

Eval, held-out, live or paid model calls, Deno deploy, Supabase, browser gold, and a dev server stay outside this slice. Two `react-hooks/exhaustive-deps` warnings in `src/ui/screens/Preregister.tsx` do not fail lint.
