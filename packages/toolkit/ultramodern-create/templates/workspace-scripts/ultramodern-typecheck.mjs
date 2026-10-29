#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, constants as osConstants } from 'node:os';
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

// Measured on a 27-project workspace on 10 cores, with identical diagnostics:
// the tsrs fast preset alone used about 20% less memory, and 8 checkers per
// project then cut check time by about 20% at the original peak memory.
// tsrs builds 4 projects at once, so more checkers oversubscribe the cores.
// Small machines keep tsrs's own 4.
const TYPECHECK_DEFAULTS = { fast: true, checkers: 'auto', builders: undefined };
const AUTO_BUILD_CHECKERS = { min: 4, max: 8, reservedCores: 2 };
const TYPECHECK_CONFIG_KEYS = Object.keys(TYPECHECK_DEFAULTS);

function parseFast(value, source) {
  if (value === undefined || typeof value === 'boolean') return value;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  fail(`${source} must be true or false (or 1 or 0), received ${JSON.stringify(value)}.`);
}

function parseCount(value, source, { allowAuto }) {
  if (value === undefined || (allowAuto && value === 'auto')) return value;
  const count = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (Number.isInteger(count) && count > 0) return count;
  fail(
    `${source} must be a positive integer${allowAuto ? ' or "auto"' : ''}, received ${JSON.stringify(value)}.`,
  );
}

// The workspace root package.json owns project defaults:
// { "ultramodern": { "typecheck": { "fast": true, "checkers": "auto", "builders": 4 } } }
function readProjectTypecheckConfig() {
  const manifestPath = join(workspaceRoot, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    fail(`Cannot read typecheck settings from ${manifestPath}: ${error.message}`);
  }
  const config = manifest?.ultramodern?.typecheck;
  if (config === undefined) return {};
  const source = `${manifestPath} "ultramodern.typecheck"`;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail(`${source} must be an object.`);
  }
  const unknown = Object.keys(config).filter(key => !TYPECHECK_CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(`${source} has unknown settings: ${unknown.join(', ')}. Use ${TYPECHECK_CONFIG_KEYS.join(', ')}.`);
  }
  if (config.fast !== undefined && typeof config.fast !== 'boolean') {
    fail(`${source}.fast must be true or false, received ${JSON.stringify(config.fast)}.`);
  }
  return {
    fast: config.fast,
    checkers: parseCount(config.checkers, `${source}.checkers`, { allowAuto: true }),
    builders: parseCount(config.builders, `${source}.builders`, { allowAuto: false }),
  };
}

function nonEmptyEnvironment(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

// Precedence: compiler flags passed to this command, then environment
// variables, then the project's package.json, then the measured defaults.
function resolveTypecheckSettings() {
  const project = readProjectTypecheckConfig();
  return {
    fast:
      parseFast(nonEmptyEnvironment('TSRS_FAST'), 'TSRS_FAST') ??
      project.fast ??
      TYPECHECK_DEFAULTS.fast,
    checkers:
      parseCount(nonEmptyEnvironment('ULTRAMODERN_TYPECHECK_CHECKERS'), 'ULTRAMODERN_TYPECHECK_CHECKERS', {
        allowAuto: true,
      }) ??
      project.checkers ??
      TYPECHECK_DEFAULTS.checkers,
    builders:
      parseCount(nonEmptyEnvironment('ULTRAMODERN_TYPECHECK_BUILDERS'), 'ULTRAMODERN_TYPECHECK_BUILDERS', {
        allowAuto: false,
      }) ??
      project.builders ??
      TYPECHECK_DEFAULTS.builders,
  };
}

function autoBuildCheckers() {
  const { min, max, reservedCores } = AUTO_BUILD_CHECKERS;
  return Math.min(max, Math.max(min, availableParallelism() - reservedCores));
}

function hasFlag(passthrough, flag) {
  return passthrough.some(arg => arg === flag || arg.startsWith(`${flag}=`));
}

function performanceArgs(mode, passthrough, settings) {
  const performance = [];
  // "auto" leaves project mode to the fast preset, which sizes checkers per
  // program. Build mode otherwise keeps 4 checkers per project.
  const checkers =
    settings.checkers === 'auto'
      ? mode === 'build'
        ? autoBuildCheckers()
        : undefined
      : settings.checkers;
  if (checkers !== undefined && !hasFlag(passthrough, '--checkers') && !hasFlag(passthrough, '--singleThreaded')) {
    performance.push('--checkers', String(checkers));
  }
  if (mode === 'build' && settings.builders !== undefined && !hasFlag(passthrough, '--builders')) {
    performance.push('--builders', String(settings.builders));
  }
  return performance;
}

// Effect-Go accepts --checkers and --builders and ignores TSRS_* variables,
// so these settings stay valid on hosts without tsrs.
function compilerEnvironment(settings) {
  const env = { ...process.env, TSRS_FAST: settings.fast ? '1' : '0' };
  const assignment = nonEmptyEnvironment('TSRS_CHECKER_ASSIGNMENT');
  if (assignment) {
    env.TSRS_CHECKER_ASSIGNMENT = assignment;
  } else if (settings.fast) {
    // An explicit assignment would switch off the preset's work stealing.
    delete env.TSRS_CHECKER_ASSIGNMENT;
  } else {
    env.TSRS_CHECKER_ASSIGNMENT = 'locality';
  }
  return env;
}

const parsed = readArgs();
const settings = resolveTypecheckSettings();
const tsgoBin = resolveEffectTsgoCompiler({
  from: pathToFileURL(join(workspaceRoot, 'package.json')),
});
const performance = performanceArgs(parsed.mode, parsed.passthrough, settings);

const tsgoArgs =
  parsed.mode === 'build'
    ? [
        '--build',
        parsed.target,
        '--pretty',
        'false',
        '--stopBuildOnErrors',
        ...performance,
        ...parsed.passthrough,
      ]
    : [
        '--project',
        parsed.target,
        ...(parsed.emit ? [] : ['--noEmit']),
        '--pretty',
        'false',
        ...performance,
        ...parsed.passthrough,
      ];

const result = spawnSync(tsgoBin, tsgoArgs, {
  stdio: 'inherit',
  env: compilerEnvironment(settings),
});

if (result.error) {
  throw result.error;
}

process.exit(
  result.status ??
    (result.signal ? 128 + osConstants.signals[result.signal] : 1),
);
