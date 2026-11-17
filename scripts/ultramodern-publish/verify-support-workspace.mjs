#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { supportProtocol as protocol } from '../ultramodern-support-artifacts/protocol.mjs';
import { isDirectRun } from './lib/direct-run.mjs';
import {
  supportWorkspaceImporters,
  verifySupportConsumer,
} from './verify-support-consumer.mjs';

export { supportWorkspaceImporters } from './verify-support-consumer.mjs';

export async function verifySupportWorkspace({
  root,
  fetchArtifact,
  readGithub,
  signal,
}) {
  const receipts = [];
  let descriptor;
  for (const importer of supportWorkspaceImporters(root)) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(importer, 'package.json'), 'utf8'),
    );
    const selected = Object.keys(protocol.cohort).filter(name =>
      ['dependencies', 'devDependencies', 'optionalDependencies'].some(block =>
        Object.hasOwn(manifest[block] ?? {}, name),
      ),
    );
    const commits = Object.hasOwn(
      manifest.ultramodern ?? {},
      'supportArtifacts',
    );
    if (commits) {
      protocol.validateDescriptor(manifest.ultramodern.supportArtifacts);
      if (descriptor)
        assert.deepEqual(
          manifest.ultramodern.supportArtifacts,
          descriptor,
          'Workspace importers disagree on support authority',
        );
      descriptor = manifest.ultramodern.supportArtifacts;
    }
    if (!selected.length) continue;
    receipts.push(
      await verifySupportConsumer({
        root: importer,
        workspaceRoot: root,
        descriptor: manifest.ultramodern?.supportArtifacts,
        fetchArtifact,
        readGithub,
        signal,
      }),
    );
  }
  assert(
    receipts.length,
    'Release acceptance requires actual selected support importers; registry fallback is not accepted',
  );
  return {
    schema: 'ultramodern.support-workspace.v1',
    root: fs.realpathSync(root),
    importers: receipts,
  };
}

if (isDirectRun(import.meta.url)) {
  try {
    assert(
      process.argv.length === 4 && process.argv[2] === '--root',
      'Usage: --root <installed workspace>',
    );
    console.log(
      JSON.stringify(
        await verifySupportWorkspace({ root: process.argv[3] }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
