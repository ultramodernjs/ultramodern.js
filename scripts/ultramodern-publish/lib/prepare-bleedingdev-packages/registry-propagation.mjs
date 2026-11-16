// Consumers: the cohort post-publish verifier (registry.mjs
// verifyRegistryPackage) and the sidecar post-publish wait
// (publish-sidecars.mjs awaitPublishedSidecar). Both lanes run after an
// unrollbackable publish and must outlast the same npm propagation lag.
import { sleep } from './commands.mjs';

// Delays spent between registry reads, front-loaded so a version that is
// already coherent is accepted in seconds, then backing off to 20s reads.
// The total must outlast npm's propagation of a freshly published version:
// run 34689880072 (cohort) saw a packument stay without its version for more
// than 360s, and run 36137116871 (sidecars) failed a publish that became
// readable a few minutes after the 90s sidecar-only window gave up. This
// schedule waits 855s over 60 reads.
const registryPropagationDelaysMs = Object.freeze([
  2000,
  3000,
  5000,
  5000,
  ...Array.from({ length: 24 }, () => 10000),
  ...Array.from({ length: 8 }, () => 15000),
  ...Array.from({ length: 24 }, () => 20000),
]);

// The schedule above expressed as a single wall-clock budget, so one publish
// set (one preflight phase, one publish loop, one post-publish cohort
// verification, one sidecar lane) can share it as one absolute deadline.
//
// A per-call window cannot express this: verifyRegistryTarball is reached 50
// times at concurrency 8 from validateRegistryCohort and once per sidecar from
// the sequential sidecar loop, so a per-call propagation window multiplies into
// the job timeout. The measured failure is the other direction: an 8 x 15s
// (~2 min) per-call window gave up on @bleedingdev/mf-dts-plugin@2.9.5 in run
// 43804632305 and cost 11.4 min of wall clock, while run 43780469169 measured
// real propagation of 402.9s and 331.4s. One shared deadline waits as long as
// npm actually needs and still bounds the set's extra wall clock to one window.
const registryPropagationBudgetMs = registryPropagationDelaysMs.reduce(
  (total, delay) => total + delay,
  0,
);

/**
 * One absolute deadline for a whole publish set. `remainingMs()` is what is
 * left of the budget for every waiter sharing it; once it is <= 0 the next
 * transient registry state is reported as the failure it is.
 *
 * The budget runs from the first `remainingMs()` call - the first moment the
 * set actually has to wait - not from construction. The set that owns the
 * deadline is created before its registry reads (a publish loop can take ten
 * minutes before a single read needs to wait), and a deadline anchored to
 * construction would hand that set a window npm has already consumed.
 */
function createRegistryPropagationDeadline({
  budgetMs = registryPropagationBudgetMs,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error(
      `A registry propagation budget must be a positive number of milliseconds, received ${String(budgetMs)}`,
    );
  }
  if (typeof now !== 'function') {
    throw new Error('A registry propagation deadline requires a clock');
  }
  let expiresAtMs;
  return Object.freeze({
    budgetMs,
    remainingMs: () => {
      expiresAtMs ??= now() + budgetMs;
      return expiresAtMs - now();
    },
  });
}

/**
 * Poll the registry until `probe` reports a settled state.
 *
 * `probe(attempt)` returns `{ settled: true, value }` once the registry read is
 * decisive, or `{ settled: false, detail }` while it is still propagating. A
 * throw from `probe` is terminal and propagates immediately: only the probe
 * knows which registry states can resolve on their own, so this loop never
 * retries anything the probe did not explicitly report as pending.
 *
 * Resolves to `{ settled: true, value, attempts, firstDetail }`, or to
 * `{ settled: false, detail, attempts, firstDetail }` once every delay has
 * been spent; `firstDetail` is the first pending state (undefined when the
 * first read settled). The caller owns the failure message.
 */
async function pollRegistryPropagation(
  probe,
  { delaysMs = registryPropagationDelaysMs, wait = sleep } = {},
) {
  const attempts = delaysMs.length + 1;
  let detail;
  let firstDetail;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await probe(attempt);
    if (outcome.settled) {
      return {
        attempts: attempt,
        firstDetail,
        settled: true,
        value: outcome.value,
      };
    }
    detail = outcome.detail;
    if (attempt === 1) firstDetail = detail;
    if (attempt < attempts) {
      await wait(delaysMs[attempt - 1]);
    }
  }
  return { attempts, detail, firstDetail, settled: false };
}

export {
  createRegistryPropagationDeadline,
  pollRegistryPropagation,
  registryPropagationBudgetMs,
  registryPropagationDelaysMs,
};
