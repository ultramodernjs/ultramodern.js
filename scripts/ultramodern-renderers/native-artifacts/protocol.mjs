import assert from 'node:assert/strict';
import {
  bindArtifactProtocol,
  commit,
  digest,
  exactKeys,
  hash,
} from '../../ultramodern-artifacts/protocol.mjs';

function validateUpstream(value, name, version) {
  exactKeys(
    value,
    [
      'request',
      'integrity',
      'repository',
      'commit',
      'sourceArchiveIntegrity',
      'licenseSha256',
    ],
    'upstream',
  );
  assert.equal(
    value.request,
    `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  );
  digest(value.integrity);
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  commit(value.commit);
  digest(value.sourceArchiveIntegrity);
  hash(value.licenseSha256);
}

const nativePolicy = Object.freeze({
  protocol: 'ultramodern.native-artifacts.v1',
  repository: 'ultramodernjs/ultramodern.js',
  repositoryId: 1151231350,
  workflow: '.github/workflows/native-renderer-artifacts.yml',
  cohort: Object.freeze({
    octane: '0.18.0',
    '@octanejs/tanstack-router': '0.3.4',
    '@octanejs/rspack-plugin': '0.2.10',
    '@tanstack/router-core': '1.171.39',
  }),
  manifestFilename: 'native-artifacts.json',
  tagPrefix: 'native-renderers',
  releaseTitle: 'Native renderer artifacts',
  reconstructionPrefix: 'native-reconstruction-',
  validateUpstream,
});

// Qualify and publish the next Octane tuple before any workspace selects it.
// The default binding below remains the authority for installed consumers.
export const octane20ArtifactProtocol = bindArtifactProtocol({
  ...nativePolicy,
  cohort: {
    ...nativePolicy.cohort,
    octane: '0.20.0',
    '@octanejs/tanstack-router': '0.3.6',
    '@octanejs/rspack-plugin': '0.2.12',
  },
});

export const {
  protocol,
  repository,
  repositoryId,
  workflow,
  cohort,
  manifestFilename,
  sha256,
  integrity,
  assetFilename,
  releaseUrl,
  validateProducer,
  validatePackages,
  validateManifest,
  validateDescriptor,
  manifestBytes,
  descriptorFor,
} = bindArtifactProtocol(nativePolicy);
export { commit, digest, exactKeys, hash, validateUpstream };
