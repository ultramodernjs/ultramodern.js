import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportProtocol as protocol } from '../../ultramodern-support-artifacts/protocol.mjs';
import {
  inspectNpmTarball,
  readVerifiedPackageArtifactBytes,
} from './prepare-bleedingdev-packages/release-artifacts.mjs';
import { authSupportDescriptor } from './support-artifact-inputs.mjs';

const blocks = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];
export const supportEdges = manifest =>
  Object.keys(protocol.cohort).filter(name =>
    blocks.some(block => Object.hasOwn(manifest[block] ?? {}, name)),
  );

// Release owners must provide the real descriptor. No generated URL, registry
// substitute, or environment override is an authority for an owning manifest.
export function assertReleaseSupportOwners(manifests) {
  let descriptor;
  for (const manifest of manifests) {
    const edges = supportEdges(manifest);
    const commits = Object.hasOwn(
      manifest.ultramodern ?? {},
      'supportArtifacts',
    );
    const generator = [
      manifest.name,
      manifest.ultramodern?.sourceName,
    ].includes('@modern-js/ultramodern-create');
    if (!edges.length && !commits && !generator) continue;
    const current = manifest.ultramodern?.supportArtifacts;
    assert(
      current,
      `${manifest.name}: support descriptor required; hosted acceptance is pending`,
    );
    protocol.validateDescriptor(current);
    if (descriptor)
      assert.deepEqual(
        current,
        descriptor,
        `${manifest.name}: conflicting support descriptor`,
      );
    descriptor = current;
    for (const name of edges) {
      assert(
        !Object.hasOwn(manifest.dependencies ?? {}, name) &&
          !Object.hasOwn(manifest.optionalDependencies ?? {}, name),
        `${name}: framework owner must use a peer, not a private correction dependency`,
      );
      const development = manifest.devDependencies?.[name];
      if (development !== undefined)
        assert(
          development === protocol.cohort[name] ||
            development === current.packages[name].request,
          `${name}: wrong framework development authority`,
        );
      if (
        development === undefined ||
        Object.hasOwn(manifest.peerDependencies ?? {}, name) ||
        Object.hasOwn(manifest.peerDependenciesMeta ?? {}, name)
      ) {
        assert.equal(
          manifest.peerDependencies?.[name],
          protocol.cohort[name],
          `${name}: wrong framework peer`,
        );
        if (manifest.peerDependenciesMeta?.[name]?.optional === true)
          assert.equal(
            name,
            '@effect/opentelemetry',
            'Only Effect support integration may be optional',
          );
      }
    }
  }
  return descriptor;
}

// Envelope authentication is not archive/installed acceptance. Final package
// manifests are read from immutable tarballs again, including publish recovery.
export async function verifyReleaseSupportOwners(packages, transport = {}) {
  const descriptor = assertReleaseSupportOwners(
    packages.map(item => {
      const bytes =
        item.bytes ?? readVerifiedPackageArtifactBytes(item, item.artifactPath);
      assert(Buffer.isBuffer(bytes), 'Actual release archive bytes required');
      return inspectNpmTarball(bytes).packageJson;
    }),
  );
  if (!descriptor) return null;
  await authSupportDescriptor({ ...transport, descriptor });
  return descriptor;
}

// runAcceptanceProfile's command seam is synchronous. Keep it synchronous and
// make the real frozen-install command fail if any importer fails admission.
export function verifyInstalledSupportWorkspace(
  root,
  env = process.env,
  { githubToken } = {},
) {
  const scratch = fs.mkdtempSync(
    path.join(env.TMPDIR ?? os.tmpdir(), 'support-installed-admission-'),
  );
  try {
    const checked = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../verify-support-workspace.mjs', import.meta.url)),
        '--root',
        root,
      ],
      {
        cwd: root,
        env: {
          ...env,
          OWNED_TEMP_DIR: scratch,
          ...(githubToken ? { GH_TOKEN: githubToken } : {}),
        },
        stdio: 'inherit',
      },
    );
    if (checked.error) throw checked.error;
    assert.equal(checked.status, 0, 'Installed support importer admission failed');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function supportAdmissionRun(run, { githubToken } = {}) {
  return (command, args, options) => {
    const result = run(command, args, options);
    if (
      command === 'pnpm' &&
      args[0] === 'install' &&
      args.includes('--frozen-lockfile') &&
      !args.includes('--lockfile-only')
    ) {
      verifyInstalledSupportWorkspace(
        options.cwd,
        { ...process.env, ...options.env },
        { githubToken },
      );
    }
    return result;
  };
}
