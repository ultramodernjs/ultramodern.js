#!/usr/bin/env node
// Consumer: read-only prepare-sidecars job; no framework staging or publication.
import fs from 'node:fs';
import path from 'node:path';
import cliKit from '../lib/cli-kit.js';
import { isDirectRun } from './lib/direct-run.mjs';
import { rejectInlineOptionSyntax } from './lib/option-syntax.mjs';
import { repoRoot } from './lib/prepare-bleedingdev-packages/constants.mjs';
import {
  resolveSourceIdentity,
  resolveToolVersions,
} from './lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  collectSidecarPackages,
  stageSidecarPackages,
  validateAliasConsistency,
  writeSidecarStagingManifest,
} from './lib/prepare-bleedingdev-packages/sidecars.mjs';
import { assertCleanCommittedSource } from './lib/release-source-state.mjs';
import {
  assertSidecarProducerContext,
  readSidecarBundleInputs,
  resolveSidecarOutput,
  sidecarProfile,
  writeSidecarBundle,
} from './sidecar-bundle.mjs';
import { sidecarProfileRecipes } from './sidecar-profiles.mjs';

export async function prepareSidecarBundle(
  out,
  { env = process.env, profile = 'parser' } = {},
) {
  const selected = sidecarProfile(profile);
  const output = resolveSidecarOutput(out);
  if (fs.existsSync(output))
    throw new Error(
      'Sidecar preparation output already exists; choose a new owned output',
    );
  const commit = assertCleanCommittedSource(repoRoot);
  const source = resolveSourceIdentity({ env });
  if (source.commit !== commit || env.GITHUB_SHA !== commit)
    throw new Error(
      'Sidecar preparation must use the exact committed workflow source',
    );
  assertSidecarProducerContext(env, source);
  readSidecarBundleInputs(profile);
  const tools = resolveToolVersions();
  const sidecars = collectSidecarPackages(repoRoot, {
    roots: selected.recipeIds.map(id => `packages/sidecar/${id}`),
    reviewedRecipes: sidecarProfileRecipes(profile),
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), 'stage-'));
  try {
    const staged = await stageSidecarPackages(sidecars, staging);
    validateAliasConsistency([], staged);
    fs.mkdirSync(output);
    const { descriptor } = writeSidecarStagingManifest(output, staged, {
      publishBefore: selected.publishBefore,
    });
    assertCleanCommittedSource(repoRoot, { expectedCommit: commit });
    return writeSidecarBundle(output, {
      descriptor,
      source,
      tools,
      env,
      profile,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (isDirectRun(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    rejectInlineOptionSyntax(argv, {
      valueOptions: new Set(['--out', '--profile']),
      booleanOptions: new Set(),
    });
    const options = cliKit.parseCliArgs(argv, {
      defaults: {
        out: path.join(repoRoot, '.modern', 'bleedingdev-sidecars', 'bundle'),
        profile: 'parser',
      },
      options: { out: {}, profile: {} },
    });
    const accepted = await prepareSidecarBundle(options.out, {
      profile: options.profile,
    });
    console.log(
      `Prepared ${accepted.sidecars.packages.length} source-bound sidecars: ${accepted.bundleSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
