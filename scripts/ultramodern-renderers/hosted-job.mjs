/**
 * Supported GHA runner identity, not cryptographic provider attestation.
 * Depot's GHA runners report self-hosted and a depot-* runner name. Never use
 * this alone as a filesystem lease: callers still validate the job's paths,
 * ownership and run identity. Generic self-hosted runners are not supported.
 */
export function isSupportedHostedJob(env) {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    (env.RUNNER_ENVIRONMENT === 'github-hosted' ||
      (env.RUNNER_ENVIRONMENT === 'self-hosted' &&
        typeof env.RUNNER_NAME === 'string' &&
        /^depot-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(env.RUNNER_NAME)))
  );
}
