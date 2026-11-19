// Fabricated controls only. Never use these identities or bytes as a recipe.
import { releaseBody } from '../../ultramodern-artifacts/transport.mjs';
import * as nativeProtocol from './protocol.mjs';
import { packFiles } from './reconstruct.mjs';
export function fixture(artifactProtocol = nativeProtocol) {
  const {
    assetFilename,
    cohort,
    descriptorFor,
    integrity,
    manifestBytes,
    manifestFilename,
    protocol,
    releaseUrl,
    repository,
    repositoryId,
    sha256,
    workflow,
  } = artifactProtocol;
  const producer = {
    repository,
    repositoryId,
    workflow,
    source: 'a'.repeat(40),
    runId: 123,
    runAttempt: 2,
    tag: `native-renderers-${'a'.repeat(40)}-123-2`,
  };
  const payloads = new Map();
  const packages = Object.fromEntries(
    Object.entries(cohort).map(([name, version]) => {
      const pkg = {
        name,
        version,
        ...(name === '@octanejs/tanstack-router'
          ? {
              peerDependencies: {
                '@tanstack/router-core': cohort['@tanstack/router-core'],
              },
            }
          : {}),
      };
      const bytes = packFiles(
        new Map([
          [
            'package.json',
            { bytes: Buffer.from(JSON.stringify(pkg)), mode: 0o644 },
          ],
          [
            'LICENSE',
            { bytes: Buffer.from('unit control license'), mode: 0o644 },
          ],
          [
            'index.js',
            {
              bytes: Buffer.from('export const control = true;\n'),
              mode: 0o644,
            },
          ],
        ]),
      );
      const filename = assetFilename(name, version);
      payloads.set(filename, bytes);
      return [
        name,
        {
          version,
          request: releaseUrl(producer, filename),
          integrity: integrity(bytes),
          upstream: {
            request: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
            integrity: integrity(bytes),
            repository: 'unit/control',
            commit: 'b'.repeat(40),
            sourceArchiveIntegrity: integrity(Buffer.from('unit source')),
            licenseSha256: sha256(Buffer.from('unit control license')),
          },
          patchSha256: 'c'.repeat(64),
        },
      ];
    }),
  );
  const manifest = { protocol, producer, packages };
  const descriptor = descriptorFor(manifest);
  payloads.set(manifestFilename, manifestBytes(manifest));
  const release = {
    id: 42,
    tag_name: producer.tag,
    target_commitish: producer.source,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${repository}/releases/tag/${producer.tag}`,
    body: releaseBody({ protocol: artifactProtocol, descriptor }),
    assets: [...payloads].map(([name, bytes], index) => ({
      id: index + 1,
      name,
      state: 'uploaded',
      digest: `sha256:${sha256(bytes)}`,
      browser_download_url: releaseUrl(producer, name),
    })),
  };
  const repo = { id: repositoryId, full_name: repository };
  const run = {
    id: producer.runId,
    run_attempt: producer.runAttempt,
    repository: repo,
    head_repository: repo,
    head_sha: producer.source,
    path: workflow,
    event: 'workflow_dispatch',
    head_branch: 'main-ultramodern',
    actor: { login: 'BleedingDev' },
    triggering_actor: { login: 'BleedingDev' },
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = {
    total_count: 2,
    jobs: ['produce', 'qualify'].map(name => ({
      name,
      head_sha: producer.source,
      status: 'completed',
      conclusion: 'success',
    })),
  };
  const ref = {
    ref: `refs/tags/${producer.tag}`,
    object: { type: 'commit', sha: producer.source },
  };
  const evidence = { repo, run, jobs, ref, release };
  const readGithub = async route => {
    if (route === `/repositories/${repositoryId}`) return evidence.repo;
    if (route.endsWith('/jobs?per_page=100')) return evidence.jobs;
    if (route.includes('/actions/runs/')) return evidence.run;
    if (route.includes('/git/ref/tags/')) return evidence.ref;
    if (route.includes('/releases/tags/')) return evidence.release;
    throw new Error(`Unexpected API request ${route}`);
  };
  const fetchArtifact = async url => {
    const bytes = payloads.get(new URL(url).pathname.split('/').at(-1));
    return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
  };
  return {
    producer,
    payloads,
    manifest,
    descriptor,
    evidence,
    readGithub,
    fetchArtifact,
  };
}
