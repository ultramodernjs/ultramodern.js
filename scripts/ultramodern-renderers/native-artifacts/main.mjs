#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as core from '../../ultramodern-artifacts/main.mjs';
import * as installedProtocol from './protocol.mjs';
import { octane20ArtifactProtocol, releaseRecipe } from './recipes.mjs';
export const currentProducer = (env = process.env) =>
  core.currentProducer({ protocol: installedProtocol, env });
export const writerApi = token =>
  core.writerApi({ protocol: installedProtocol, token });
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    recipeFactory = releaseRecipe,
    reconstructArtifacts,
  } = {},
) {
  const octaneCandidate = env.NATIVE_OCTANE_CANDIDATE ?? 'octane-0.18.0';
  assert(
    ['octane-0.18.0', 'octane-0.20.0'].includes(octaneCandidate),
    'unknown Octane candidate',
  );
  const protocol =
    octaneCandidate === 'octane-0.20.0'
      ? octane20ArtifactProtocol
      : installedProtocol;
  return core.runArtifactCommand({
    protocol,
    recipeFactory: () => recipeFactory({ octaneCandidate }),
    argv,
    env,
    reconstructArtifacts,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
