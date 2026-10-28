import { createAcceptanceWorkspaceEnv } from '../ultramodern-production-readiness/published-create-proof/process.mjs';
import { releaseAgeExemptions } from '../ultramodern-production-readiness/published-create-proof/release-age-audit.mjs';
import { defaultReleaseAgePolicyPath } from '../ultramodern-publish/run-release-acceptance.mjs';

export function createRendererAcceptanceEnv(
  runtimeEnv,
  { mode, release, registryEnv, storeDir },
) {
  // Environment lists replace workspace YAML lists in pnpm. Compose the
  // verified source cohort with the authenticated generator's exact compiler
  // exception; forwarding registryEnv alone discards that compiler exception.
  const workspaceEnv = createAcceptanceWorkspaceEnv(
    { ...runtimeEnv, ...registryEnv },
    { mode, release, registryEnv },
  );
  return {
    ...workspaceEnv,
    // Renderer acceptance already runs the pinned manager; retain its policy.
    pnpm_config_pm_on_fail: runtimeEnv.pnpm_config_pm_on_fail,
    npm_config_store_dir: storeDir,
    pnpm_config_minimum_release_age: '1440',
    pnpm_config_minimum_release_age_strict: 'true',
    pnpm_config_minimum_release_age_ignore_missing_time: 'false',
    pnpm_config_minimum_release_age_exclude: JSON.stringify(
      releaseAgeExemptions(release, {
        policyPath: defaultReleaseAgePolicyPath,
      }),
    ),
  };
}
