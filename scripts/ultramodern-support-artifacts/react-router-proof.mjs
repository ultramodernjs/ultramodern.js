#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isolatedEnvironment,
  prepare,
} from '../ultramodern-renderers/react-router-corrections/proof.mjs';
import {
  qualifyReactSupport,
  readCoreArchive,
} from '../ultramodern-renderers/react-router-corrections/support-adapter.mjs';
import { inputs, supportProtocol as p } from './protocol.mjs';
import { readRecipes } from './recipes.mjs';
import { reconstruct } from './reconstruct.mjs';
import { verifyPayloads } from './release.mjs';

/** Bounded real React acceptance, not a substitute for the other five owning suites. */
export async function proveReactSupport({ workDirectory, toolchain }) {
  assert(path.isAbsolute(workDirectory));
  const work = fs.mkdtempSync(path.join(workDirectory, 'support-v2-proof-'));
  try {
    const source = await qualifyReactSupport({
      workDirectory: work,
      toolchain,
    });
    const input = inputs['@tanstack/react-router'];
    assert.equal(
      p.integrity(source.sourceArchiveBytes),
      input.upstream.sourceArchiveIntegrity,
    );
    assert.equal(p.sha256(source.builtPatchBytes), input.patchSha256);
    assert.equal(p.sha256(source.licenseBytes), input.upstream.licenseSha256);
    const producer = {
      repository: p.repository,
      repositoryId: p.repositoryId,
      workflow: p.workflow,
      source: 'a'.repeat(40),
      runId: 1,
      runAttempt: 1,
      tag: `support-artifacts-${'a'.repeat(40)}-1-1`,
    };
    const directory = path.join(work, 'archives');
    const manifest = await reconstruct({
      recipe: {
        packages: readRecipes(),
        // Reconstruction does not claim any owning suite ran.
        qualifySource() {
          throw new Error('Run the complete source recipe separately');
        },
        qualifyPacked() {
          throw new Error('Run the complete packed recipe separately');
        },
      },
      producer,
      directory,
    });
    const payloads = new Map(
      fs
        .readdirSync(directory)
        .map(filename => [
          filename,
          fs.readFileSync(path.join(directory, filename)),
        ]),
    );
    assert.equal(payloads.size, 7);
    verifyPayloads(p.descriptorFor(manifest), payloads);
    const missingReact = new Map(payloads);
    missingReact.delete(p.assetFilename('@tanstack/react-router', '1.170.46'));
    assert.throws(() =>
      verifyPayloads(p.descriptorFor(manifest), missingReact),
    );
    assert.throws(() =>
      verifyPayloads(
        p.descriptorFor(manifest),
        new Map([
          ...payloads,
          ['native-artifacts.json', Buffer.from('not support')],
        ]),
      ),
    );
    const coreWork = path.join(work, 'authenticated-core');
    fs.mkdirSync(coreWork);
    const env = isolatedEnvironment(coreWork);
    const core = await prepare({
      work: coreWork,
      run: (command, args, cwd, options = {}) =>
        execFileSync(command, args, { cwd, env, stdio: 'pipe', ...options }),
    });
    // The input here is an actual independently reconstructed archive. The packed
    // callback must preserve these exact supplied bytes, not rebuild a replacement.
    const coreFile = path.join(work, 'actual-core.tgz');
    fs.writeFileSync(coreFile, core.coreBytes);
    await qualifyReactSupport({
      workDirectory: work,
      toolchain,
      reactArchiveBytes: payloads.get(
        p.assetFilename('@tanstack/react-router', '1.170.46'),
      ),
      coreArchiveBytes: readCoreArchive(coreFile),
    });
    console.log(
      'SUPPORT_V2_REACT_SOURCE_TRANSPORT_PASS',
      JSON.stringify({
        protocol: p.protocol,
        packages: Object.keys(manifest.packages),
        assets: payloads.size,
        patchSha256: input.patchSha256,
        actualReactIntegrity:
          manifest.packages['@tanstack/react-router'].integrity,
        actualCoreIntegrity: p.integrity(core.coreBytes),
        otherOwningSuites: 'not run by this bounded proof',
        hostedAuthentication: 'not run; local producer identity is a fixture',
      }),
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.env.OWNED_TEMP_DIR, 'Use owned-temp-dir --run');
  assert(
    process.env.SUPPORT_PNPM_STORE,
    'Explicit external pnpm store required',
  );
  await proveReactSupport({
    workDirectory: process.env.OWNED_TEMP_DIR,
    toolchain: {
      node: process.execPath,
      pnpm: process.env.SUPPORT_PNPM_BINARY ?? 'pnpm',
      storeDirectory: process.env.SUPPORT_PNPM_STORE,
      sourceRepository: process.env.SUPPORT_REACT_SOURCE_REPOSITORY,
    },
  });
}
