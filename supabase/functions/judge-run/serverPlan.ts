import { err, ok, type Result } from './_core/core/result.ts';
import { buildRunPlan, type RunPlan, type RunPlanError } from './_core/core/plan/runPlan.ts';
import type { LiveJob, RunBundle } from './contracts.ts';

type PlanBundle = Pick<RunBundle, 'jobs' | 'config' | 'prices'> & { run: { plan: RunPlan | null } };

/**
 * Nonempty server jobs and their plan are installed atomically by ensure_run_jobs.
 * The installed plan is a saved estimate, preserved when dated prices change.
 * claim_attempt independently prices each reservation from the current price book;
 * its cap check and the attempt's real usage settlement remain authoritative.
 */
export function planForServerJobs(
  bundle: PlanBundle,
  jobs: readonly LiveJob[],
  promptBytes: (jobId: string) => number,
  itemCount: number,
): Result<RunPlan, RunPlanError> {
  if (bundle.jobs.length > 0) {
    if (!bundle.run.plan) return err({ reason: 'bad_request', message: 'installed server jobs require their saved plan' });
    return ok(bundle.run.plan);
  }
  const planned = buildRunPlan({ itemKeys: jobs.map((job) => job.id), replicates: 1, kinds: ['score'], promptBytes,
    config: bundle.config, priceBook: bundle.prices });
  if (!planned.ok) return planned;
  return ok({ ...planned.value, items: itemCount, kinds: [...new Set(jobs.map((job) => job.kind))] });
}
