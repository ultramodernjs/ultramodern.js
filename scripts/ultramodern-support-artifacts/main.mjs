#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  currentProducer as producer,
  runArtifactCommand,
} from '../ultramodern-artifacts/main.mjs';
import { supportProtocol as protocol } from './protocol.mjs';
import { releaseRecipe } from './recipes.mjs';
export const currentProducer = env => producer({ protocol, env });
export const main = (argv = process.argv.slice(2), env = process.env) =>
  runArtifactCommand({
    protocol,
    recipeFactory: releaseRecipe,
    argv,
    env,
  });
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
