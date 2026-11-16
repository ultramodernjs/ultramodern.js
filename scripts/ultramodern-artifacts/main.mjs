#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifactPolicy } from './protocol.mjs';
import {
  reconstructArtifact,
  validateRecipe,
  verifySourceQualification,
} from './reconstruct.mjs';
import { publishArtifactRelease, verifyPayloads } from './release.mjs';

export function currentProducer({ protocol, env = process.env }) {
  const policy = artifactPolicy(protocol);
  const { repository, repositoryId, workflow, validateProducer } = protocol;
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(Number(env.GITHUB_REPOSITORY_ID), repositoryId);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main-ultramodern');
  assert.equal(env.GITHUB_ACTOR, 'BleedingDev');
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, 'BleedingDev');
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${repository}/${workflow}@refs/heads/main-ultramodern`,
  );
  const source = env.GITHUB_SHA;
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  return validateProducer({
    repository,
    repositoryId,
    workflow,
    source,
    runId,
    runAttempt,
    tag: `${policy.tagPrefix}-${source}-${runId}-${runAttempt}`,
  });
}
function payloadsAt(directory) {
  return new Map(
    fs.readdirSync(directory).map(filename => {
      assert(
        fs.lstatSync(path.join(directory, filename)).isFile(),
        'Only release files may be transported',
      );
      return [filename, fs.readFileSync(path.join(directory, filename))];
    }),
  );
}
export function writerApi({ protocol, token }) {
  artifactPolicy(protocol);
  const { repository, repositoryId } = protocol;
  assert(token, 'Release job token required');
  return async (
    method,
    route,
    body,
    { optional = false, bytes = false } = {},
  ) => {
    assert(
      route.startsWith(`/repos/${repository}/`) ||
        route === `/repositories/${repositoryId}`,
    );
    const upload = method === 'UPLOAD';
    const response = await fetch(
      `https://${upload ? 'uploads' : 'api'}.github.com${route}`,
      {
        method: upload ? 'POST' : method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: bytes
            ? 'application/octet-stream'
            : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body
            ? {
                'Content-Type': upload
                  ? 'application/octet-stream'
                  : 'application/json',
              }
            : {}),
        },
        body: body ? (upload ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(120000),
      },
    );
    if (optional && response.status === 404) return null;
    assert(response.ok, `GitHub ${method} ${route}: HTTP ${response.status}`);
    return bytes ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}
export async function runArtifactCommand({
  protocol,
  recipeFactory,
  argv = process.argv.slice(2),
  env = process.env,
  reconstructArtifacts = options =>
    reconstructArtifact({ ...options, protocol }),
}) {
  const policy = artifactPolicy(protocol);
  const { manifestFilename, validateManifest, descriptorFor } = protocol;
  let [command, directory] = argv;
  assert(
    ['produce', 'qualify', 'publish'].includes(command) && directory,
    'Use produce|qualify|publish <owned-directory>',
  );
  directory = path.resolve(directory);
  const producer = currentProducer({ protocol, env });
  if (command === 'produce') {
    const recipe = recipeFactory();
    validateRecipe({ protocol, recipe });
    // Owning source build must prove its complete npm-layout patch before packing.
    const evidence = await recipe.qualifySource({
      producer,
      workDirectory: env.RUNNER_TEMP,
    });
    await verifySourceQualification({ protocol, recipe, evidence });
    await reconstructArtifacts({ recipe, producer, directory });
    return;
  }
  const manifest = validateManifest(
    JSON.parse(fs.readFileSync(path.join(directory, manifestFilename))),
  );
  assert.deepEqual(
    manifest.producer,
    producer,
    'Transported artifact belongs to another source/run/attempt',
  );
  assert.equal(manifest.protocol, protocol.protocol);
  const descriptor = descriptorFor(manifest);
  const payloads = payloadsAt(directory);
  verifyPayloads({ protocol, descriptor, payloads });
  if (command === 'qualify') {
    const recipe = recipeFactory();
    validateRecipe({ protocol, recipe });
    for (const [name, item] of Object.entries(recipe.packages)) {
      assert.deepEqual(item.upstream, manifest.packages[name].upstream);
      assert.equal(item.patchSha256, manifest.packages[name].patchSha256);
    }
    assert(env.RUNNER_TEMP, 'Qualification needs an owned runner workspace');
    const verification = fs.mkdtempSync(
      path.join(env.RUNNER_TEMP, policy.reconstructionPrefix),
    );
    try {
      const rebuilt = path.join(verification, 'archives');
      await reconstructArtifacts({ recipe, producer, directory: rebuilt });
      const rebuiltPayloads = payloadsAt(rebuilt);
      assert.deepEqual(
        [...rebuiltPayloads.keys()].sort(),
        [...payloads.keys()].sort(),
      );
      for (const [filename, bytes] of payloads)
        assert.deepEqual(
          rebuiltPayloads.get(filename),
          bytes,
          `Transport differs from independent exact reconstruction: ${filename}`,
        );
    } finally {
      fs.rmSync(verification, { recursive: true, force: true });
    }
    await recipe.qualifyPacked({
      producer,
      directory,
      manifest,
      workDirectory: env.RUNNER_TEMP,
    });
  } else
    await publishArtifactRelease({
      protocol,
      descriptor,
      payloads,
      api: writerApi({ protocol, token: env.GH_TOKEN }),
    });
}
