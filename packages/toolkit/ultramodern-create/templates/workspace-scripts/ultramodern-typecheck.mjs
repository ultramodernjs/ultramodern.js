#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';

const args = process.argv.slice(2);
const workspaceRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT
  ? resolve(process.env.ULTRAMODERN_WORKSPACE_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readArgs() {
  let buildTarget;
  let projectTarget;
  let emit = false;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--') {
      passthrough.push(...args.slice(index + 1));
      break;
    }

    if (arg === '--build' || arg === '-b') {
      buildTarget = next && !next.startsWith('-') ? next : 'tsconfig.json';
      if (buildTarget === next) {
        index += 1;
      }
      continue;
    }

    if (arg === '--project' || arg === '-p') {
      if (!next || next.startsWith('-')) {
        fail(`${arg} requires a tsconfig path.`);
      }
      projectTarget = next;
      index += 1;
      continue;
    }

    if (arg === '--emit') {
      emit = true;
      continue;
    }

    passthrough.push(arg);
  }

  if (buildTarget && projectTarget) {
    fail('Choose either --build or --project, not both.');
  }
  if (buildTarget && emit) {
    fail('--emit is only supported with project mode.');
  }

  return {
    mode: buildTarget ? 'build' : 'project',
    target: buildTarget ?? projectTarget ?? 'tsconfig.json',
    emit,
    passthrough,
  };
}

const parsed = readArgs();
const tsgoBin = resolveEffectTsgoCompiler({
  from: pathToFileURL(join(workspaceRoot, 'package.json')),
});

const tsgoArgs =
  parsed.mode === 'build'
    ? [
        '--build',
        parsed.target,
        '--pretty',
        'false',
        '--stopBuildOnErrors',
        ...parsed.passthrough,
      ]
    : [
        '--project',
        parsed.target,
        ...(parsed.emit ? [] : ['--noEmit']),
        '--pretty',
        'false',
        ...parsed.passthrough,
      ];

const result = spawnSync(tsgoBin, tsgoArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    TSRS_CHECKER_ASSIGNMENT: process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
  },
});

if (result.error) {
  throw result.error;
}

process.exit(
  result.status ??
    (result.signal ? 128 + osConstants.signals[result.signal] : 1),
);
