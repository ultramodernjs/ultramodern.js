#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { supportProtocol as protocol } from '../ultramodern-support-artifacts/protocol.mjs';
import { isDirectRun } from './lib/direct-run.mjs';
import { verifySupportConsumer } from './verify-support-consumer.mjs';

export function supportWorkspaceImporters(root) {
  root = fs.realpathSync(root);
  const workspace = path.join(root, 'pnpm-workspace.yaml');
  const patterns = fs.existsSync(workspace)
    ? parse(fs.readFileSync(workspace, 'utf8')).packages
    : [];
  assert(Array.isArray(patterns), 'Workspace packages must be an array');
  assert(
    patterns.every(
      pattern =>
        typeof pattern === 'string' &&
        !path.isAbsolute(pattern) &&
        !pattern.split('/').includes('..'),
    ),
    'Invalid workspace package pattern',
  );
  const included = patterns
    .filter(pattern => !pattern.startsWith('!'))
    .map(pattern => `${pattern.replace(/\/$/u, '')}/package.json`);
  const excluded = [
    '**/node_modules/**',
    '**/.git/**',
    ...patterns
      .filter(pattern => pattern.startsWith('!'))
      .map(pattern => `${pattern.slice(1)}/package.json`),
  ];
  return [
    ...new Set([
      root,
      ...fs
        .globSync(included, { cwd: root, exclude: excluded })
        .map(filename =>
          fs.realpathSync(path.dirname(path.join(root, filename))),
        ),
    ]),
  ].sort();
}

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
