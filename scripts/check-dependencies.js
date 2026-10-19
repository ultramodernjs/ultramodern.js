// The published generator selects the Module Federation sidecar alias; the
// monorepo resolves the same patched upstream through .pnpmfile.cjs.
const ignoreDeps = [
  'fs-extra',
  'tailwindcss',
  '@module-federation/modern-js-v3',
];

const {
  assertRendererRouterCore,
} = require('./check-renderer-router-core.cjs');

async function main() {
  const { CDVC } = await import('check-dependency-version-consistency');
  const workspace = new CDVC('.', { ignorePackagePattern: ['^@examples/'] });
  // Octane's accepted snapshot API requires its own Core archive. Check that
  // exact package-specific contract before checking the remaining dependencies.
  assertRendererRouterCore(workspace.getDependency('@tanstack/router-core'));

  // Use the workspace-pinned version to avoid unexpected breaking changes from @latest.
  const command = `pnpm exec check-dependency-version-consistency . ${[
    ...ignoreDeps,
    '@tanstack/router-core',
  ]
    .map(dep => `--ignore-dep "${dep}"`)
    .join(' ')} --ignore-package-pattern "^@examples/"`;

  console.log(`> ${command}`);

  try {
    require('child_process').execSync(command, { stdio: 'inherit' });
  } catch {
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
