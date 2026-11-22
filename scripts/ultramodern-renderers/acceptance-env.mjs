import { createAcceptanceWorkspaceEnv } from '../ultramodern-production-readiness/published-create-proof/process.mjs';

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
    pnpm_config_minimum_release_age: '0',
  };
}
