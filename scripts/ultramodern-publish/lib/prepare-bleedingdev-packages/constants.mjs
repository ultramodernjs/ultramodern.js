// Consumer: BleedingDev release staging, publishing, and acceptance contracts.
import fsKit from '../../../lib/fs-kit.js';

const { repoRoot } = fsKit;

// Rekor can stay slow for minutes; its client then retries an entry it
// already logged and fails with 409 before npm sees the publish.
const npmPublishAttempts = 6;

const npmPublishRetryDelayMs = 15_000;

const npmRegistryOrigin = 'https://registry.npmjs.org';

const trustedPublishRepository = 'ultramodernjs/ultramodern.js';

// GitHub preserves this immutable identity through the organization transfer.
// Both exact paths are needed while the release change lands before transfer
// and when verifying the already-published registry chronology afterward.
const trustedPublishRepositoryId = '1151231350';
const trustedPublishRepositories = Object.freeze([
  trustedPublishRepository,
  'BleedingDev/ultramodern.js',
]);

function isTrustedPublishRepository(repository) {
  return trustedPublishRepositories.includes(repository);
}

function isTrustedPublishRepositoryContext(env) {
  return (
    isTrustedPublishRepository(env.GITHUB_REPOSITORY) &&
    env.GITHUB_REPOSITORY_ID === trustedPublishRepositoryId
  );
}

function packageMetadataRepository(env = process.env) {
  if (env.GITHUB_REPOSITORY === undefined) return trustedPublishRepository;
  if (!isTrustedPublishRepositoryContext(env)) {
    throw new Error(
      'Package metadata requires the original trusted GitHub repository identity',
    );
  }
  return env.GITHUB_REPOSITORY;
}

const trustedPublishRef = 'refs/heads/main-ultramodern';

const trustedPublishWorkflowPath = '.github/workflows/publish-bleedingdev.yml';

const trustedPublishOidcIssuer = 'https://token.actions.githubusercontent.com';

const transientNpmPublishErrorPatterns = [
  /TLOG_CREATE_ENTRY_ERROR/u,
  /error creating tlog entry/u,
  /rekor\.sigstore\.dev/u,
  /ETIMEDOUT/u,
  /ECONNRESET/u,
  /EAI_AGAIN/u,
  /ESOCKETTIMEDOUT/u,
  /socket hang up/u,
];

const incorporatedModernCreateSourceName = '@modern-js/create';
const ultramodernCreateSourceName = '@modern-js/ultramodern-create';
const ultramodernCreateTargetName = '@bleedingdev/modern-js-ultramodern-create';
const retiredBleedingdevCreateTargetName = '@bleedingdev/modern-js-create';

// Sidecar republications are staged beside the cohort but never inside it:
// they keep their own stable versions and their own npm scope.
const sidecarScope = '@bleedingdev';
const sidecarStagingDirectory = 'sidecars';
const sidecarTarballsDirectory = 'sidecar-tarballs';
const sidecarManifestFile = 'sidecars.json';
const sidecarManifestSchema = 'bleedingdev.ultramodern.sidecar-manifest';
const sidecarManifestSchemaVersion = 2;
const sidecarAliasConsumerTargetName = '@bleedingdev/modern-js-image';
const createTemplateRequiredFiles = [
  'template-workspace/.agents/agent-reference-repos.json',
  'template-workspace/.codex/rstackjs-agent-skills-LICENSE',
  'template-workspace/.codex/skills-lock.json',
  'template-workspace/.codex/hooks.json',
  'template-workspace/.github/renovate.json',
  'template-workspace/.github/workflows/ultramodern-workspace-gates.yml.handlebars',
  'template-workspace/.gitignore.handlebars',
  'template-workspace/.mise.toml.handlebars',
];

export {
  createTemplateRequiredFiles,
  incorporatedModernCreateSourceName,
  npmPublishAttempts,
  npmPublishRetryDelayMs,
  npmRegistryOrigin,
  repoRoot,
  sidecarAliasConsumerTargetName,
  sidecarManifestFile,
  sidecarManifestSchema,
  sidecarManifestSchemaVersion,
  sidecarScope,
  sidecarStagingDirectory,
  sidecarTarballsDirectory,
  trustedPublishOidcIssuer,
  trustedPublishRef,
  trustedPublishRepository,
  trustedPublishRepositoryId,
  trustedPublishRepositories,
  isTrustedPublishRepository,
  isTrustedPublishRepositoryContext,
  packageMetadataRepository,
  trustedPublishWorkflowPath,
  transientNpmPublishErrorPatterns,
  retiredBleedingdevCreateTargetName,
  ultramodernCreateSourceName,
  ultramodernCreateTargetName,
};
