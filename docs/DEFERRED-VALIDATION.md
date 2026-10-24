# Deferred validation

This project was built in **Dirty Mode**: source and tests were written but nothing was installed,
compiled, linted, executed, migrated or deployed. The only check run at build time was
`node scripts/syntax-check.mjs <files>` (Node 24 type-strip parse of `.ts` files; it parses, never
executes). Every check below is still owed. Runtime readiness is **unverified**.

Each milestone appends its rows. Run commands from the inner repo root
(`judge-calibration-lab/`).

| Component | What is deferred | Why | Exact later command / steps |
|---|---|---|---|
| Dependencies (M1) | `npm install` and generation of `package-lock.json` for the exact pins in `package.json` | Dirty Mode forbids installs and network | `npm install` (first time, creates the lockfile; commit it), then `npm ci` everywhere else |
| Type check (M1) | `tsc --noEmit` over `src`, `tests`, `scripts` and the two config files (strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`) | Needs installed `typescript` and type packages | `npm ci && npm run typecheck` |
| Lint (M1) | ESLint flat config (`@eslint/js` + `typescript-eslint` recommended + `react-hooks`, pure-import restriction on `src/core`/`src/shared`) | Needs installed `eslint` packages | `npm ci && npm run lint` |
| Unit tests (M1) | Vitest suites `tests/core/{sha256,canonical,prng,tokenize}.test.ts` and `tests/core/judgestats/*.test.ts` (QWK hand vectors, undefined conditions, Wilson, quantile, bootstrap reproducibility and 10%/11% boundary, paired same-draw sign and basis rule, PAV, bands, consensus, ceiling overlap floor) | Dirty Mode forbids running tests | `npm ci && npm test` (or `npx vitest run tests/core`) |
| SHA-256 cross-check (M1) | Confirm `src/core/sha256.ts` matches a platform implementation on random inputs beyond the NIST vectors | Requires execution | One-off: `npx tsx -e "import {sha256Hex} from './src/core/sha256.ts'; import {createHash} from 'node:crypto'; for (let i=0;i<1000;i++){const s='x'.repeat(i)+String(i); if (sha256Hex(s)!==createHash('sha256').update(s,'utf8').digest('hex')) throw new Error(String(i));} console.log('ok')"` |
| PRNG golden sequence (M1) | No pinned reference outputs exist for `createPrng(36)` / `deriveStream(36, label)`; only determinism is tested | Producing golden values requires execution | After the first green test run, record the first 8 `nextUint32()` outputs of `createPrng(36)` in `tests/core/prng.test.ts` as a regression vector and compare against a reference xoshiro128** implementation |
| `@types/node` (M1 note) | `@types/node` is not in the PLAN §3.1 pin list; Node-API scripts (`scripts/*.ts`, M6) will need it for `tsc` | Pins are fixed by the plan; adding an unpinned version was out of scope | Integrator decision: add an exact `@types/node` pin, or exclude `scripts/` from `tsconfig.json` and type-check scripts separately |
| `index.html` entry | Points at `/src/ui/main.tsx`, which is created in M4; `npm run dev`/`build` cannot succeed before M4 exists | Runtime build is deferred in Dirty Mode anyway | After M4: `npm ci && npm run build` |
