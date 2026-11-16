#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import * as core from '../../ultramodern-artifacts/main.mjs';
import * as protocol from './protocol.mjs';
import { releaseRecipe } from './recipes.mjs';
import { reconstruct } from './reconstruct.mjs';
export const currentProducer = (env = process.env) =>
  core.currentProducer({ protocol, env });
export const writerApi = token => core.writerApi({ protocol, token });
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    recipeFactory = releaseRecipe,
    reconstructArtifacts = reconstruct,
  } = {},
) {
  return core.runArtifactCommand({
    protocol,
    recipeFactory,
    argv,
    env,
    reconstructArtifacts,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
