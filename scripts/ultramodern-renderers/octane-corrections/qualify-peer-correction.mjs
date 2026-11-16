// Adapter-only owning acceptance. Reconstruct all four immutable inputs, but do
// not rebuild/requalify the unchanged runtime or claim a native descriptor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  repository,
  repositoryId,
  sha256,
  workflow,
} from '../native-artifacts/protocol.mjs';
import { releaseRecipe } from '../native-artifacts/recipes.mjs';
import { reconstruct } from '../native-artifacts/reconstruct.mjs';
import { qualifyAdapterSource } from '../native-artifacts/source-qualification.mjs';
import { source } from './inputs.mjs';

assert(
  process.env.OWNED_TEMP_DIR,
  'Use owned-temp-dir --need-gib 20 --run native-peer-actual -- node .../qualify-peer-correction.mjs',
);
const work = process.env.OWNED_TEMP_DIR;
const recipe = releaseRecipe();
const directory = path.join(work, 'actual-archives');
// Local reconstruction identity only, never uploaded, signed or accepted.
const sourceCommit = '21716c86bfda8004d9adfc825f40ec57a4e358b4';
const producer = {
  repository,
  repositoryId,
  workflow,
  source: sourceCommit,
  runId: 1,
  runAttempt: 1,
  tag: `native-renderers-${sourceCommit}-1-1`,
};
await reconstruct({ recipe, directory, producer });
for (const file of fs.readdirSync(directory))
  console.log(
    'ACTUAL ARCHIVE',
    file,
    sha256(fs.readFileSync(path.join(directory, file))),
  );
const evidence = await qualifyAdapterSource({
  item: recipe.packages['@octanejs/tanstack-router'],
  source,
  workDirectory: work,
  packedDirectory: directory,
});
console.log(
  'ADAPTER ACTUAL SOURCE+PACKED PASS',
  sha256(evidence.builtPatchBytes),
);
console.log(
  'Full runtime unchanged / NOT rerun; no accepted native descriptor',
);
