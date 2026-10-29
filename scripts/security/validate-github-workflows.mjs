#!/usr/bin/env node
/**
 * Repo-wide GitHub workflow security gate.
 *
 * Every workflow (plus the template-workspace handlebars workflow) is checked
 * for:
 *   - actions pinned to a full 40-hex commit SHA (local `./` actions exempt)
 *   - a top-level `permissions:` block (least privilege by default)
 *   - no `pull_request_target` trigger
 *   - no privileged trigger (`pull_request_target` / `workflow_run`) combined
 *     with write permissions, secrets exposure, or checkout of untrusted refs
 *   - no npm token environment variables
 *   - no `${{ inputs.* }}` / `${{ github.event.inputs.* }}` interpolation
 *     inside `run:` blocks (shell-injection vector; route through `env:`)
 *   - no runtime skip-CI gate (`skipCI`, `steps.skip-ci`, `git diff
 *     origin/main`) and no trigger path filter that skips an edit of the
 *     workflow itself
 *   - in `.github/workflows/`, every `node <script>` run before the job's
 *     dependency install loads only Node builtins and tracked files through
 *     its eager import closure (the template workflow runs scripts of the
 *     generated workspace, which this repository cannot resolve)
 *
 * Sensitive workflows (publish/nightly/production-readiness/...) additionally
 * require persist-credentials: false, timeout-minutes, harden-runner egress
 * policy (audit or block), and the publish workflow must use OIDC trusted
 * publishing through the npm-publish environment.
 *
 * Intentional exceptions go into ALLOWLIST below with a written reason.
 *
 * Generate its js-yaml input with `pnpm --filter @scripts/prebundle start js-yaml`
 * before running it without a package build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';
import {
  conditionCalls,
  evaluateJobSchedule,
  parseJobCondition,
} from './github-job-condition.mjs';
import {
  findUnloadableImports,
  listTrackedFiles,
} from './static-import-closure.mjs';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const workflowDirs = [
  '.github/workflows',
  'packages/toolkit/ultramodern-create/template-workspace/.github/workflows',
];

const sensitiveWorkflowPaths = new Set([
  '.github/workflows/publish-bleedingdev.yml',
  '.github/workflows/ultramodern-nightly.yml',
  '.github/workflows/workflow-security.yml',
  '.github/workflows/superapp-certification.yml',
  'packages/toolkit/ultramodern-create/template-workspace/.github/workflows/ultramodern-workspace-gates.yml.handlebars',
]);

/**
 * Intentional, reviewed exceptions. Every entry MUST explain why the
 * exception is safe. `match` (optional) narrows the entry to error messages
 * containing that substring; without it the whole rule is waived for the
 * file.
 *
 * @type {Array<{ file: string, rule: string, match?: string, reason: string }>}
 */
export const ALLOWLIST = [
  {
    file: '.github/workflows/boundary-anti-patterns.yml',
    rule: 'pull-request-target',
    reason:
      'Trusted-base orchestration selects a hosted runner before executing an external fork head; workflow permissions remain contents: read.',
  },
  {
    file: '.github/workflows/boundary-anti-patterns.yml',
    rule: 'privileged-trigger-checkout-ref',
    match: 'github.event.pull_request.head.sha || github.sha',
    reason:
      'The read-only boundary job intentionally checks out the immutable fork head only after trusted-base runner selection.',
  },
];

const shaPattern = /^[a-f0-9]{40}$/;
const tractorBaselinePinPath =
  'scripts/ultramodern-publish/tractor-baseline-revision';

function isAllowed(allowlist, relativePath, rule, message) {
  return allowlist.some(
    entry =>
      entry.file === relativePath &&
      entry.rule === rule &&
      (entry.match === undefined || message.includes(entry.match)),
  );
}

export function collectWorkflowFiles(rootDir = repoRoot) {
  const files = [];
  for (const workflowDir of workflowDirs) {
    const absoluteDir = path.join(rootDir, workflowDir);
    if (!fs.existsSync(absoluteDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /\.(?:ya?ml|ya?ml\.handlebars)$/u.test(entry.name)
      ) {
        files.push(path.posix.join(workflowDir, entry.name));
      }
    }
  }
  return files.sort();
}

export function collectUses(content) {
  const { value } = parseYaml(content);
  return value === undefined ? [] : collectActionUses(value);
}

const runInputPattern =
  /\$\{\{[^}]*\b(?:github\.event\.inputs|inputs)\s*\.[^}]*\}\}/;

const privilegedTriggerNames = ['pull_request_target', 'workflow_run'];
const exactWorkflowRunHeadShaRefPattern =
  /^\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}\s*(?:#.*)?$/u;

const isObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function parseYaml(content) {
  try {
    return { value: yaml.load(content) };
  } catch (error) {
    return { error };
  }
}

function parseWorkflow(content) {
  const parsed = parseYaml(content);
  if (!isObject(parsed.value)) {
    return {
      error: parsed.error ?? new Error('workflow root must be a mapping'),
    };
  }
  return { workflow: parsed.value };
}

const sourceLines = content => content.split('\n');

const sourceFinding = (content, matcher, fallback = '') => {
  const lines = sourceLines(content);
  const index = lines.findIndex(line => matcher.test(line));
  return {
    line: index === -1 ? 1 : index + 1,
    text: (lines[index] ?? fallback).trim(),
  };
};

const sourceFindingForValue = (content, value, fallback) => {
  const fragments = String(value)
    .split('\n')
    .map(fragment => fragment.trim())
    .filter(Boolean);
  const fragment = fragments.find(part => part.includes('${{')) ?? fragments[0];
  return sourceFinding(
    content,
    fragment
      ? new RegExp(escapeRegExp(fragment), 'u')
      : new RegExp(escapeRegExp(fallback), 'u'),
    fallback,
  );
};

function walkValues(value, visit, valuePath = []) {
  visit(value, valuePath);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkValues(item, visit, [...valuePath, index]),
    );
  } else if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) =>
      walkValues(item, visit, [...valuePath, key]),
    );
  }
}

const collectActionUses = workflow => {
  const uses = [];
  walkValues(workflow, (value, valuePath) => {
    if (valuePath.at(-1) !== 'uses' || typeof value !== 'string') {
      return;
    }
    const separator = value.lastIndexOf('@');
    if (separator <= 0 || separator === value.length - 1) {
      return;
    }
    uses.push({
      action: value.slice(0, separator).trim(),
      ref: value.slice(separator + 1).trim(),
    });
  });
  return uses;
};

const normalizeNeeds = job =>
  typeof job?.needs === 'string'
    ? [job.needs]
    : Array.isArray(job?.needs)
      ? job.needs
      : [];

const workflowSteps = workflow =>
  isObject(workflow.jobs)
    ? Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
        isObject(job) && Array.isArray(job.steps)
          ? job.steps
              .filter(isObject)
              .map((step, stepIndex) => ({ job, jobId, step, stepIndex }))
          : [],
      )
    : [];

const actionMatches = (step, action) =>
  typeof step.uses === 'string' &&
  step.uses.toLowerCase().startsWith(`${action.toLowerCase()}@`);

const stripShellComments = command => {
  let quote;
  let escaped = false;
  let result = '';

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      result += character;
      escaped = true;
      continue;
    }

    if (quote !== undefined) {
      result += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      continue;
    }

    if (
      character === '#' &&
      (index === 0 || /[\s;|&()]/u.test(command[index - 1]))
    ) {
      while (index < command.length && command[index] !== '\n') {
        index += 1;
      }
      result += '\n';
      continue;
    }

    result += character;
  }

  return result;
};

const runIncludes = (step, value) =>
  typeof step.run === 'string' && stripShellComments(step.run).includes(value);

const shellCommandWords = command => {
  const commands = [[]];
  let current = '';
  let escaped = false;
  let quote;
  let wordStarted = false;

  const pushWord = () => {
    if (!wordStarted) {
      return;
    }
    commands.at(-1).push(current);
    current = '';
    wordStarted = false;
  };

  const pushCommand = () => {
    pushWord();
    if (commands.at(-1).length > 0) {
      commands.push([]);
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      if (character !== '\n') {
        current += character;
      }
      escaped = false;
      wordStarted = true;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      escaped = true;
      wordStarted = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      wordStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (character === '\n') {
        pushCommand();
      } else {
        pushWord();
      }
      continue;
    }

    if (character === ';' || character === '&' || character === '|') {
      pushCommand();
      if (command[index + 1] === character) {
        index += 1;
      }
      continue;
    }

    current += character;
    wordStarted = true;
  }

  pushWord();
  return commands.filter(words => words.length > 0);
};

const nodeExecutablePattern = /(?:^|\/)node(?:\.exe)?$/u;
const receiptVerifierScript =
  'scripts/ultramodern-publish/run-release-acceptance.mjs';

const hasShellOption = (words, option) =>
  words.some(word => word === option || word.startsWith(`${option}=`));

const receiptVerificationCommands = command =>
  shellCommandWords(stripShellComments(command)).flatMap(words => {
    if (!nodeExecutablePattern.test(words[0])) {
      return [];
    }
    const scriptIndex = words.indexOf(receiptVerifierScript, 1);
    if (scriptIndex === -1) {
      return [];
    }
    const argumentsAfterScript = words.slice(scriptIndex + 1);
    return hasShellOption(argumentsAfterScript, '--verify-receipt')
      ? [argumentsAfterScript]
      : [];
  });

const hasDryRunPublishBranches = workflow => {
  const input = workflow.on?.workflow_dispatch?.inputs?.dry_run;
  const validation = workflow.jobs?.['validate-release'];
  const publication = workflow.jobs?.publish;
  return (
    isObject(input) &&
    isObject(validation) &&
    isObject(publication) &&
    typeof validation.if === 'string' &&
    validation.if.includes('inputs.dry_run == true') &&
    typeof publication.if === 'string' &&
    publication.if.includes('inputs.dry_run == false')
  );
};

function collectReceiptRunIdentityErrors(workflow, relativePath) {
  return workflowSteps(workflow).flatMap(({ jobId, step }) => {
    const receiptCommands =
      typeof step.run === 'string' ? receiptVerificationCommands(step.run) : [];
    return receiptCommands.some(
      argumentsAfterScript =>
        !hasShellOption(argumentsAfterScript, '--run-identity'),
    )
      ? [
          `${relativePath} job ${jobId} receipt verification must pass an authenticated --run-identity`,
        ]
      : [];
  });
}

// Node options that load a module before the entrypoint.
const nodePreloadOptions = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
]);

// `node [options] <script>` invocations in a run block, parsed as shell
// words (quotes, continuations, `$(node ...)` also inside a quoted word).
const normalizeShellContinuations = run => run.replace(/\\\r?\n/gu, ' ');

// Ordinary Node commands load the first script; node --test loads every fixed
// script argument. Globs and separate option values are excluded.
const nodeInvocations = run =>
  shellCommandWords(normalizeShellContinuations(run)).flatMap(command => {
    const words = command.filter(word => word !== '');
    const substituted = words.flatMap(word =>
      word.startsWith('$(')
        ? []
        : [...word.matchAll(/\$\(([^()]*)\)/gu)].flatMap(match =>
            nodeInvocations(match[1]),
          ),
    );
    const nodeAt = words.findIndex(word => /^(?:\$\(|`)?node$/u.test(word));
    if (nodeAt === -1) {
      return substituted;
    }
    const args = words
      .slice(nodeAt + 1)
      .map(word => word.replace(/[)`]+$/u, ''));
    const preloads = args
      .map(arg => arg.split('=')[0])
      .filter(option => nodePreloadOptions.has(option));
    const scriptArguments = args.filter(
      arg =>
        !arg.startsWith('-') &&
        !/[*?[]/u.test(arg) &&
        /\.(?:mjs|cjs|js)$/u.test(arg),
    );
    const scripts = args.includes('--test')
      ? scriptArguments
      : scriptArguments.slice(0, 1);
    return [
      ...substituted,
      ...(scripts.length > 0 ? scripts : [undefined]).map(script => ({
        preloads,
        script: script?.replace(/^\.\//u, ''),
      })),
    ];
  });

const dependencyInstallCommands = ['pnpm install', 'npm install', 'npm ci'];

// A command line ending in a single `&` runs in the background.
const backgroundCommandPattern = /(?:^|[^&])&\s*$/mu;
// A step that waits for a background process: `wait` or a `kill -0` poll.
const joinCommandPattern = /(?:^|[\s;&|(])(?:wait|kill\s+-0)(?:\s|$)/mu;

// npm options whose value is a separate word.
const npmValueOptions = new Set([
  '--prefix',
  '--registry',
  '--cache',
  '--tag',
  '-w',
  '--workspace',
]);

// `@scope/name@range` or `name@range` -> package name.
const packageNameOf = spec =>
  spec.startsWith('@')
    ? spec.split('@').slice(0, 2).join('@')
    : spec.split('@')[0];

// `@scope/name/sub` or `name/sub` -> package name.
const specifierPackage = specifier =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

// Package names of `npm install <pkg>...` in a run block. Naming packages
// installs only those (e.g. into a --prefix), not the workspace.
const scopedInstallPackages = run =>
  shellCommandWords(run).flatMap(words => {
    const npmAt = words.indexOf('npm');
    if (npmAt === -1 || !['install', 'i', 'add'].includes(words[npmAt + 1])) {
      return [];
    }
    const names = [];
    for (let index = npmAt + 2; index < words.length; index += 1) {
      if (npmValueOptions.has(words[index])) {
        index += 1;
      } else if (words[index] !== '' && !words[index].startsWith('-')) {
        names.push(packageNameOf(words[index]));
      }
    }
    return names;
  });

// Run text that executes before an unconditional dependency install has
// finished, with the packages a scoped `npm install <pkg>` made available.
// A backgrounded install finishes at the first later step that joins it.
const bareSteps = (steps, defaultCwd) => {
  const result = [];
  const available = new Set();
  let installInFlight = false;
  for (const step of steps) {
    const run =
      typeof step.run === 'string' ? stripShellComments(step.run) : '';
    const cwd =
      typeof step['working-directory'] === 'string'
        ? step['working-directory']
        : defaultCwd;
    const push = text =>
      result.push({ available: new Set(available), cwd, run: text });
    const join = installInFlight ? joinCommandPattern.exec(run) : null;
    if (join !== null) {
      // Commands before the join still run while the install is in flight.
      push(run.slice(0, join.index));
      break;
    }
    const installAt =
      step.if === undefined
        ? Math.min(
            ...dependencyInstallCommands.map(command => {
              const at = run.indexOf(command);
              return at === -1 ? Number.POSITIVE_INFINITY : at;
            }),
          )
        : Number.POSITIVE_INFINITY;
    if (installAt === Number.POSITIVE_INFINITY) {
      push(run);
      continue;
    }
    // Commands before the install in the same step still run bare.
    push(run.slice(0, installAt));
    const scoped = scopedInstallPackages(run.slice(installAt));
    if (scoped.length > 0) {
      for (const name of scoped) {
        available.add(name);
      }
      push(run.slice(installAt));
      continue;
    }
    if (!backgroundCommandPattern.test(run)) {
      break;
    }
    // Commands after a backgrounded install run while it is in flight.
    push(run.slice(installAt));
    installInFlight = true;
  }
  return result;
};

// Workspace path of this repository's checkout: the first actions/checkout
// of this repository, at its `with.path` (default: the workspace root).
const repositoryCheckoutPath = steps => {
  const checkout = steps.find(
    step =>
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/checkout@') &&
      (step.with?.repository === undefined ||
        String(step.with.repository).includes('github.repository')),
  );
  return typeof checkout?.with?.path === 'string' ? checkout.with.path : '.';
};

const bareJobRuns = workflow =>
  Object.entries(isObject(workflow.jobs) ? workflow.jobs : {}).map(
    ([jobId, job]) => {
      const steps = Array.isArray(job?.steps) ? job.steps.filter(isObject) : [];
      return {
        checkoutPath: repositoryCheckoutPath(steps),
        jobId,
        runs: bareSteps(
          steps,
          [job?.defaults, workflow.defaults]
            .map(defaults => defaults?.run?.['working-directory'])
            .find(cwd => typeof cwd === 'string') ?? '.',
        ),
      };
    },
  );

// Repository-relative path of a script run from a workspace-relative
// working directory, or undefined when it lies outside this checkout.
const repositoryScriptPath = (checkoutPath, cwd, script) => {
  const workspaceCwd =
    cwd.replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/u, '') || '.';
  if (workspaceCwd.includes('${{') || path.posix.isAbsolute(workspaceCwd)) {
    return undefined;
  }
  const relative = path.posix.relative(
    checkoutPath,
    path.posix.join(workspaceCwd, script),
  );
  return relative.startsWith('..') ? undefined : relative;
};

/**
 * A step that runs before an unconditional dependency install (`pnpm
 * install`, `npm install`, `npm ci`) has finished runs from a bare checkout,
 * so every eager import reachable from its `node <script>` entrypoints must be a
 * Node builtin or a tracked repository file. Otherwise the job fails with
 * ERR_MODULE_NOT_FOUND at run time, possibly after it already published.
 */
function collectBareJobImportErrors(workflow, relativePath, options) {
  const jobs = bareJobRuns(workflow);
  const invocations = jobs.flatMap(({ checkoutPath, jobId, runs }) =>
    runs.flatMap(({ available, cwd, run }) =>
      nodeInvocations(run).map(invocation => ({
        ...invocation,
        available,
        jobId,
        script:
          invocation.script === undefined
            ? undefined
            : repositoryScriptPath(checkoutPath, cwd, invocation.script),
      })),
    ),
  );
  const preloadErrors = invocations.flatMap(({ jobId, preloads }) =>
    preloads.map(
      option =>
        `${relativePath} job ${jobId} runs node ${option} before any dependency install; a preloaded module is not checked, so import it from the entrypoint instead`,
    ),
  );
  // Available packages only grow within a job, so the first invocation of a
  // script is its strictest state.
  const entrypoints = [];
  const seen = new Set();
  for (const { available, jobId, script } of invocations) {
    if (script !== undefined && !seen.has(`${jobId}\0${script}`)) {
      seen.add(`${jobId}\0${script}`);
      entrypoints.push({ available, entrypoint: script, jobId });
    }
  }
  if (entrypoints.length === 0) {
    return preloadErrors;
  }
  const rootDir = options.rootDir ?? repoRoot;
  const trackedFiles = options.trackedFiles ?? listTrackedFiles(rootDir);
  return preloadErrors.concat(
    entrypoints.flatMap(({ available, entrypoint, jobId }) =>
      findUnloadableImports(rootDir, entrypoint, trackedFiles)
        .filter(({ specifier }) => !available.has(specifierPackage(specifier)))
        .map(({ chain, specifier }) =>
          chain.length === 0
            ? `${relativePath} job ${jobId} runs ${entrypoint}, which is not a tracked file`
            : `${relativePath} job ${jobId} runs ${entrypoint} before any dependency install, but it statically loads ${specifier} via ${chain.join(' -> ')}; add a dependency install step before it or move the import into a function behind a dynamic import()`,
        ),
    ),
  );
}

function collectPublishOutcomeErrors(workflow, relativePath) {
  if (
    relativePath !== bleedingdevPublishWorkflowPath &&
    !hasDryRunPublishBranches(workflow)
  ) {
    return [];
  }
  const errors = [];
  const outcomeJob = workflow.jobs?.['record-publish-outcome'];
  if (!isObject(outcomeJob)) {
    return [
      `${relativePath} dry-run and publish branches must converge on record-publish-outcome`,
    ];
  }
  const needs = new Set(normalizeNeeds(outcomeJob));
  for (const requiredJob of ['accept-release', 'publish', 'validate-release']) {
    if (!needs.has(requiredJob)) {
      errors.push(
        `${relativePath} record-publish-outcome must depend on ${requiredJob}`,
      );
    }
  }
  const condition = typeof outcomeJob.if === 'string' ? outcomeJob.if : '';
  for (const requiredCondition of [
    'always()',
    "needs.validate-release.result == 'success'",
    "needs.publish.result == 'success'",
    "needs.validate-release.result == 'skipped'",
    "needs.publish.result == 'skipped'",
  ]) {
    if (!condition.includes(requiredCondition)) {
      errors.push(
        `${relativePath} record-publish-outcome must gate both exclusive successful branch results`,
      );
      break;
    }
  }
  const steps = Array.isArray(outcomeJob.steps)
    ? outcomeJob.steps.filter(isObject)
    : [];
  const createSteps = steps.filter(step =>
    runIncludes(step, 'publish-outcome.mjs create'),
  );
  const uploads = steps.filter(step =>
    actionMatches(step, 'actions/upload-artifact'),
  );
  if (createSteps.length !== 1) {
    errors.push(
      `${relativePath} record-publish-outcome must create exactly one structured outcome`,
    );
  } else if (
    !runIncludes(createSteps[0], '--dry-run') ||
    !runIncludes(createSteps[0], '--producer-run-identity') ||
    !runIncludes(createSteps[0], '--source-commit') ||
    !runIncludes(createSteps[0], '--version') ||
    !runIncludes(createSteps[0], '--run-id') ||
    !runIncludes(createSteps[0], '--run-attempt')
  ) {
    errors.push(
      `${relativePath} publish outcome must bind dry-run, source, version, producer, and workflow run identity`,
    );
  }
  if (
    uploads.length !== 1 ||
    uploads[0].with?.name !==
      ['${{', 'steps.publish-outcome.outputs.artifact_name', '}}'].join(' ') ||
    typeof uploads[0].with?.path !== 'string' ||
    !uploads[0].with.path
      .split('\n')
      .map(value => value.trim())
      .includes('.modern/bleedingdev-publish/publish-outcome.json')
  ) {
    errors.push(
      `${relativePath} record-publish-outcome must upload exactly one deterministically named outcome artifact`,
    );
  }
  const actionExpression = name => ['${{', name, '}}'].join(' ');
  if (
    outcomeJob.outputs?.artifact_name !==
    actionExpression('steps.publish-outcome.outputs.artifact_name')
  ) {
    errors.push(
      `${relativePath} record-publish-outcome must expose its exact artifact name`,
    );
  }

  const changeRecordJob = workflow.jobs?.['publish-change-record'];
  if (!isObject(changeRecordJob)) {
    errors.push(
      `${relativePath} authenticated publish outcome must converge on publish-change-record`,
    );
    return errors;
  }
  const changeRecordNeeds = normalizeNeeds(changeRecordJob);
  if (
    changeRecordNeeds.length !== 1 ||
    changeRecordNeeds[0] !== 'record-publish-outcome'
  ) {
    errors.push(
      `${relativePath} publish-change-record must depend only on record-publish-outcome`,
    );
  }
  const changeRecordPermissions = changeRecordJob.permissions;
  if (
    !isObject(changeRecordPermissions) ||
    changeRecordPermissions.actions !== 'read' ||
    changeRecordPermissions.contents !== 'write' ||
    Object.keys(changeRecordPermissions).length !== 2
  ) {
    errors.push(
      `${relativePath} publish-change-record must grant only actions: read and contents: write`,
    );
  }
  const changeRecordSteps = Array.isArray(changeRecordJob.steps)
    ? changeRecordJob.steps.filter(isObject)
    : [];
  const outcomeDownloads = changeRecordSteps.filter(step =>
    actionMatches(step, 'actions/download-artifact'),
  );
  const [outcomeDownload] = outcomeDownloads;
  if (
    outcomeDownloads.length !== 1 ||
    outcomeDownload.with?.['github-token'] !==
      actionExpression('github.token') ||
    outcomeDownload.with?.name !==
      actionExpression('needs.record-publish-outcome.outputs.artifact_name') ||
    outcomeDownload.with?.path !== '.modern/bleedingdev-publish' ||
    outcomeDownload.with?.repository !==
      actionExpression('github.repository') ||
    outcomeDownload.with?.['run-id'] !== actionExpression('github.run_id')
  ) {
    errors.push(
      `${relativePath} publish-change-record must download the authenticated publish outcome artifact`,
    );
  }
  const generateChangeRecordSteps = changeRecordSteps.filter(step =>
    runIncludes(step, 'gen-cohort-change-record.mjs'),
  );
  if (
    generateChangeRecordSteps.length !== 1 ||
    generateChangeRecordSteps[0].id !== 'change-record' ||
    !runIncludes(
      generateChangeRecordSteps[0],
      '--manifest "$BLEEDINGDEV_RELEASE_MANIFEST"',
    ) ||
    !runIncludes(
      generateChangeRecordSteps[0],
      '--github-output "$GITHUB_OUTPUT"',
    ) ||
    runIncludes(generateChangeRecordSteps[0], '--version')
  ) {
    errors.push(
      `${relativePath} publish-change-record must derive record identity from the verified release manifest`,
    );
  }

  let changeRecordCondition;
  try {
    changeRecordCondition = parseJobCondition(changeRecordJob.if);
  } catch {
    changeRecordCondition = undefined;
  }
  const successfulPublishResults = {
    'accept-published': 'success',
    'accept-release': 'success',
    'prepare-release': 'success',
    publish: 'success',
    'publish-security': 'success',
    'publish-sidecars': 'success',
    'record-publish-outcome': 'success',
    'tractor-downstream': 'success',
    'validate-release': 'skipped',
  };
  const successfulPublishContext = {
    github: {
      actor: 'BleedingDev',
      ref: 'refs/heads/main-ultramodern',
      repository_owner: 'ultramodernjs',
      triggering_actor: 'BleedingDev',
    },
    inputs: { mode: 'cohort', dry_run: false },
    vars: {},
  };
  const schedulesChangeRecord = ({ context, results } = {}) =>
    evaluateJobSchedule({
      workflow,
      jobId: 'publish-change-record',
      results: results ?? successfulPublishResults,
      context: context ?? successfulPublishContext,
    });
  if (
    changeRecordCondition === undefined ||
    !conditionCalls(changeRecordCondition, 'always') ||
    !schedulesChangeRecord() ||
    schedulesChangeRecord({
      context: {
        ...successfulPublishContext,
        inputs: { mode: 'cohort', dry_run: true },
      },
    }) ||
    ['failure', 'cancelled', 'skipped'].some(result =>
      schedulesChangeRecord({
        results: {
          ...successfulPublishResults,
          'record-publish-outcome': result,
        },
      }),
    )
  ) {
    errors.push(
      `${relativePath} publish-change-record must survive the intentional branch skip, require a successful authenticated outcome, and reject dry-runs`,
    );
  }
  return errors;
}

// Structural fail-closed contract for the trusted-publishing release workflow,
// previously enforced by scripts/ultramodern-publish/validate-publish-security.mjs.
// Consumer: .github/workflows/publish-bleedingdev.yml.
const bleedingdevPublishWorkflowPath =
  '.github/workflows/publish-bleedingdev.yml';

// Consumer: publish-bleedingdev.yml — `publish` and `publish-sidecars` mint
// npm OIDC tokens (id-token: write), while `publish-change-record` commits the
// change record (contents: write). No other release job may hold either.
const bleedingdevElevatedPermissionJobs = Object.freeze([
  'publish',
  'publish-change-record',
  'publish-sidecars',
]);
const bleedingdevGuardedPermissionScopes = Object.freeze([
  'contents',
  'id-token',
]);

// Consumer: publish-bleedingdev.yml — the closed release job graph, so a new job
// cannot be smuggled between the acceptance, publish, outcome, and record gates.
const bleedingdevPublishJobs = Object.freeze([
  'accept-published',
  'accept-release',
  'integration',
  'prepare-release',
  'prepare-sidecars',
  'publish',
  'publish-change-record',
  'publish-sidecars',
  'publish-security',
  'qualify-source',
  'qualify-source-compute',
  'qualify-sidecars',
  'reconcile-sidecars',
  'record-publish-outcome',
  'rehearse-tractor',
  'tractor-downstream',
  'validate-release',
]);

// Consumer: publish-bleedingdev.yml — fail-fast edges. The seconds-long
// registry gates must finish before the clean-room acceptance starts, and a
// dry run is green only when the Tractor rehearsal is.
const bleedingdevRequiredNeeds = Object.freeze({
  'accept-release': ['reconcile-sidecars'],
  publish: [
    'publish-security',
    'integration',
    'qualify-source-compute',
    'qualify-source',
    'accept-release',
    'rehearse-tractor',
    'publish-sidecars',
  ],
  'publish-sidecars': [
    'publish-security',
    'integration',
    'qualify-source-compute',
    'qualify-source',
    'accept-release',
    'rehearse-tractor',
    'prepare-sidecars',
    'qualify-sidecars',
  ],
  'qualify-sidecars': ['publish-security', 'prepare-sidecars'],
  'reconcile-sidecars': ['prepare-release', 'publish-security'],
  'validate-release': ['qualify-source', 'rehearse-tractor'],
});

// Consumer: publish-bleedingdev.yml — @bleedingdev/* publishes latest-only.
const bleedingdevPublishTag = 'latest';

const elevatedPermissionScopes = (permissions, scopes) =>
  permissionIsWrite(permissions)
    ? [...scopes]
    : isObject(permissions)
      ? scopes.filter(scope => permissionIsWrite(permissions[scope]))
      : [];

// A sidecar receipt authorizes only its exact third-party bundle. The shared
// OIDC job has skipped prerequisites in either mode, so its status checks must
// remain explicit instead of inheriting GitHub's implicit success().
const bleedingdevCohortJobs = Object.freeze([
  'integration',
  'qualify-source-compute',
  'qualify-source',
  'prepare-release',
  'reconcile-sidecars',
  'accept-release',
  'validate-release',
  'rehearse-tractor',
  'publish',
  'accept-published',
  'tractor-downstream',
  'record-publish-outcome',
  'publish-change-record',
]);
const bleedingdevSidecarJobs = Object.freeze([
  'prepare-sidecars',
  'qualify-sidecars',
]);

function collectBleedingdevModeInputErrors(workflow, relativePath) {
  const errors = [];
  const normalizedRun = step =>
    normalizeShellContinuations(stripShellComments(String(step?.run ?? '')))
      .replace(/\s+/gu, ' ')
      .trim();
  const jobs = workflow.jobs ?? {};
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  if (
    inputs.mode?.type !== 'choice' ||
    inputs.mode?.required !== true ||
    inputs.mode?.default !== 'cohort' ||
    JSON.stringify(inputs.mode?.options) !==
      JSON.stringify(['cohort', 'sidecars']) ||
    inputs.version?.required !== false ||
    inputs.version?.default !== ''
  ) {
    errors.push(
      `${relativePath} dispatch mode must be the required cohort/sidecars choice with cohort default and a conditional cohort version`,
    );
  }
  if (
    inputs.sidecar_profile?.type !== 'choice' ||
    inputs.sidecar_profile?.required !== true ||
    inputs.sidecar_profile?.default !== 'parser' ||
    JSON.stringify(inputs.sidecar_profile?.options) !==
      JSON.stringify(['parser', 'mf-sdk', 'tanstack-redact'])
  ) {
    errors.push(
      `${relativePath} sidecar profile must be the required parser/mf-sdk/tanstack-redact choice with parser default`,
    );
  }
  const expression = value => ['${{', value, '}}'].join(' ');
  const profileExpression = expression('inputs.sidecar_profile');
  const overridesProfile = env =>
    isObject(env) &&
    Object.hasOwn(env, 'BLEEDINGDEV_SIDECAR_PROFILE') &&
    env.BLEEDINGDEV_SIDECAR_PROFILE !== profileExpression;
  if (
    workflow.env?.BLEEDINGDEV_SIDECAR_PROFILE !== profileExpression ||
    Object.values(jobs).some(job => overridesProfile(job?.env)) ||
    workflowSteps(workflow).some(({ step }) => overridesProfile(step.env))
  ) {
    errors.push(
      `${relativePath} must bind the sidecar profile to dispatch through preparation, qualification and publication without job or step overrides`,
    );
  }
  const expectedConcurrency = expression(
    "inputs.dry_run == true && format('publish-bleedingdev-dry-run-{0}', github.run_id) || 'publish-bleedingdev'",
  );
  if (
    workflow.concurrency?.group !== expectedConcurrency ||
    workflow.concurrency?.['cancel-in-progress'] !== false
  ) {
    errors.push(
      `${relativePath} must keep one live-publication concurrency group across both modes and never cancel an active release`,
    );
  }
  if (workflow.env?.BLEEDINGDEV_PUBLISH_TAG !== 'latest') {
    errors.push(
      `${relativePath} both publication modes must pin the registry tag to latest`,
    );
  }
  const validation = jobs['publish-security']?.steps?.find(
    step => step.name === 'Validate publish inputs',
  );
  const validationRun = stripShellComments(String(validation?.run ?? ''));
  const modeCase = [
    'case "$PUBLISH_MODE" in',
    'cohort)',
    '[[ "$SIDECAR_PROFILE" == parser ]]',
    '[[ "$PUBLISH_VERSION" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-ultramodern\\.[1-9][0-9]*$ ]]',
    ';;',
    'sidecars)',
    '[[ "$SIDECAR_PROFILE" == parser || "$SIDECAR_PROFILE" == mf-sdk || "$SIDECAR_PROFILE" == tanstack-redact ]]',
    '[[ -z "$PUBLISH_VERSION" && -z "$RECOVERY_RUN_ID" && -z "$RECOVERY_RUN_ATTEMPT" && -z "$RECOVERY_QUALIFICATION_ATTEMPT" ]]',
    ';;',
    '*) exit 1 ;;',
    'esac',
  ].join(' ');
  if (
    validation?.if !== undefined ||
    validation?.env?.PUBLISH_MODE !== expression('inputs.mode') ||
    validation?.env?.SIDECAR_PROFILE !== profileExpression ||
    validation?.env?.PUBLISH_VERSION !== expression('inputs.version') ||
    validation?.env?.RECOVERY_RUN_ID !== expression('inputs.recovery_run_id') ||
    validation?.env?.RECOVERY_RUN_ATTEMPT !==
      expression('inputs.recovery_run_attempt') ||
    validation?.env?.RECOVERY_QUALIFICATION_ATTEMPT !==
      expression('inputs.recovery_qualification_attempt') ||
    !normalizeShellContinuations(validationRun)
      .replace(/\s+/gu, ' ')
      .includes(modeCase)
  ) {
    errors.push(
      `${relativePath} publish-security must reject unknown modes or sidecar profiles, mf-sdk in cohort mode and cohort version/recovery inputs in sidecars mode`,
    );
  }

  const registryChecks = workflowSteps(workflow).filter(
    ({ step }) =>
      runIncludes(step, 'publish-sidecars.mjs') &&
      runIncludes(step, '--check-registry'),
  );
  const expectedRegistryChecks = [
    {
      name: 'Check every sidecar name exists on npm',
      condition: "inputs.mode == 'cohort' && inputs.recovery_run_id == ''",
      command:
        'node scripts/ultramodern-publish/publish-sidecars.mjs --check-registry',
    },
    {
      name: 'Check selected sidecar names exist on npm',
      condition: "inputs.mode == 'sidecars'",
      command:
        'node scripts/ultramodern-publish/publish-sidecars.mjs --mode sidecars --profile "$BLEEDINGDEV_SIDECAR_PROFILE" --check-registry',
    },
  ];
  if (
    registryChecks.length !== expectedRegistryChecks.length ||
    expectedRegistryChecks.some(
      expected =>
        registryChecks.filter(
          ({ jobId, step }) =>
            jobId === 'publish-security' &&
            step.name === expected.name &&
            step.if === expected.condition &&
            normalizedRun(step) === expected.command,
        ).length !== 1,
    )
  ) {
    errors.push(
      `${relativePath} publish-security must keep exact full-cohort and dispatched-profile registry preflights`,
    );
  }

  for (const jobId of bleedingdevSidecarJobs) {
    const permissions = jobs[jobId]?.permissions ?? workflow.permissions;
    if (
      !isObject(permissions) ||
      Object.values(permissions).some(
        value => value !== 'read' && value !== 'none',
      )
    ) {
      errors.push(
        `${relativePath} job ${jobId} must keep every permission read-only during sidecar preparation and qualification`,
      );
    }
  }
  for (const jobId of ['publish', 'publish-sidecars']) {
    const job = jobs[jobId];
    if (
      job?.['runs-on'] !== 'ubuntu-24.04' ||
      job?.environment !== 'npm-publish' ||
      JSON.stringify(Object.entries(job?.permissions ?? {}).sort()) !==
        JSON.stringify(
          Object.entries({
            actions: 'read',
            contents: 'read',
            'id-token': 'write',
          }).sort(),
        )
    ) {
      errors.push(
        `${relativePath} job ${jobId} must use the hosted runner, npm-publish environment and only read permissions plus OIDC`,
      );
    }
  }

  return errors;
}

function collectBleedingdevModeScheduleErrors(workflow, relativePath) {
  const errors = [];
  const jobs = workflow.jobs ?? {};
  const successfulResults = Object.fromEntries(
    Object.keys(jobs).map(jobId => [jobId, 'success']),
  );
  const context = {
    github: {
      actor: 'BleedingDev',
      triggering_actor: 'BleedingDev',
      repository_owner: 'ultramodernjs',
      ref: 'refs/heads/main-ultramodern',
    },
    inputs: { mode: 'cohort', dry_run: false, recovery_run_id: '' },
    vars: {},
  };
  const schedule = (
    jobId,
    mode,
    overrides = {},
    contextOverrides = {},
    cancelled = false,
  ) =>
    evaluateJobSchedule({
      workflow,
      jobId,
      results: {
        ...successfulResults,
        ...(jobId === 'record-publish-outcome'
          ? { 'validate-release': 'skipped' }
          : {}),
        ...overrides,
      },
      context: {
        ...context,
        inputs: {
          ...context.inputs,
          mode,
          dry_run: jobId === 'validate-release',
        },
        ...contextOverrides,
      },
      cancelled,
    });
  for (const [ids, ownMode, otherMode] of [
    [bleedingdevCohortJobs, 'cohort', 'sidecars'],
    [bleedingdevSidecarJobs, 'sidecars', 'cohort'],
  ]) {
    for (const jobId of ids) {
      if (
        schedule(jobId, otherMode) ||
        schedule(jobId, '') ||
        schedule(jobId, 'unknown')
      ) {
        errors.push(
          `${relativePath} job ${jobId} must reject the other publication mode and unknown or missing modes`,
        );
      }
      if (
        ['actor', 'triggering_actor'].some(field =>
          schedule(
            jobId,
            ownMode,
            {},
            {
              github: { ...context.github, [field]: 'someone-else' },
            },
          ),
        ) ||
        schedule(
          jobId,
          ownMode,
          {},
          {
            github: { ...context.github, ref: 'refs/heads/untrusted' },
          },
        )
      ) {
        errors.push(
          `${relativePath} job ${jobId} must require the owner, triggering owner and trusted branch`,
        );
      }
    }
  }
  for (const jobId of [
    ...bleedingdevCohortJobs,
    ...bleedingdevSidecarJobs,
    'publish-sidecars',
  ]) {
    const mode = bleedingdevSidecarJobs.includes(jobId) ? 'sidecars' : 'cohort';
    if (schedule(jobId, mode, {}, {}, true)) {
      errors.push(
        `${relativePath} job ${jobId} must reject a cancelled run even when its prerequisites succeeded`,
      );
    }
  }
  if (schedule('publish-sidecars', 'sidecars', {}, {}, true)) {
    errors.push(
      `${relativePath} standalone publish-sidecars must reject a cancelled run even when its prerequisites succeeded`,
    );
  }
  const badResults = ['failure', 'cancelled', 'skipped', undefined];
  const inactiveSidecars = Object.fromEntries(
    bleedingdevSidecarJobs.map(jobId => [jobId, 'skipped']),
  );
  const inactiveCohort = Object.fromEntries(
    bleedingdevCohortJobs.map(jobId => [jobId, 'skipped']),
  );
  const publicationPrerequisites = {
    cohort: [
      'publish-security',
      'integration',
      'qualify-source-compute',
      'qualify-source',
      'accept-release',
      'rehearse-tractor',
    ],
    sidecars: ['publish-security', 'prepare-sidecars', 'qualify-sidecars'],
  };
  for (const [mode, prerequisites] of Object.entries(
    publicationPrerequisites,
  )) {
    const inactive = mode === 'cohort' ? inactiveSidecars : inactiveCohort;
    if (
      !schedule('publish-sidecars', mode, inactive) ||
      prerequisites.some(jobId =>
        badResults.some(result =>
          schedule('publish-sidecars', mode, { ...inactive, [jobId]: result }),
        ),
      )
    ) {
      errors.push(
        `${relativePath} publish-sidecars must require every ${mode} prerequisite to succeed while surviving only the inactive branch skips`,
      );
    }
    if (
      schedule('publish-sidecars', mode, inactive, {
        inputs: { ...context.inputs, mode, dry_run: true },
      })
    ) {
      errors.push(
        `${relativePath} publish-sidecars must reject dry runs in both modes`,
      );
    }
  }
  if (
    schedule('publish-sidecars', 'unknown') ||
    schedule('publish-sidecars', '') ||
    ['actor', 'triggering_actor'].some(field =>
      ['cohort', 'sidecars'].some(mode =>
        schedule(
          'publish-sidecars',
          mode,
          {},
          {
            github: { ...context.github, [field]: 'someone-else' },
          },
        ),
      ),
    ) ||
    ['cohort', 'sidecars'].some(mode =>
      schedule(
        'publish-sidecars',
        mode,
        {},
        {
          github: { ...context.github, ref: 'refs/heads/untrusted' },
        },
      ),
    )
  ) {
    errors.push(
      `${relativePath} publish-sidecars must require an explicit mode, owner, triggering owner and trusted branch`,
    );
  }
  for (const [jobId, prerequisites] of Object.entries({
    publish: [...publicationPrerequisites.cohort, 'publish-sidecars'],
    'accept-published': ['publish', 'accept-release'],
    'tractor-downstream': ['prepare-release', 'publish'],
    'qualify-sidecars': ['publish-security', 'prepare-sidecars'],
  })) {
    const mode = jobId === 'qualify-sidecars' ? 'sidecars' : 'cohort';
    const inactive = mode === 'cohort' ? inactiveSidecars : inactiveCohort;
    if (
      !schedule(jobId, mode, inactive) ||
      prerequisites.some(need =>
        badResults.some(result =>
          schedule(jobId, mode, { ...inactive, [need]: result }),
        ),
      )
    ) {
      errors.push(
        `${relativePath} job ${jobId} must require successful prerequisites; failure, cancellation or skip must never authorize publication or a sidecar qualification receipt`,
      );
    }
  }
  const liveCohort = { ...inactiveSidecars, 'validate-release': 'skipped' };
  const dryCohort = {
    ...inactiveSidecars,
    'validate-release': 'success',
    'publish-sidecars': 'skipped',
    publish: 'skipped',
    'accept-published': 'skipped',
    'tractor-downstream': 'skipped',
  };
  for (const [dryRun, results, prerequisites] of [
    [
      false,
      liveCohort,
      [
        'publish-security',
        'accept-release',
        'rehearse-tractor',
        'publish-sidecars',
        'publish',
        'accept-published',
        'tractor-downstream',
      ],
    ],
    [
      true,
      dryCohort,
      [
        'publish-security',
        'accept-release',
        'rehearse-tractor',
        'validate-release',
      ],
    ],
  ]) {
    const overrides = { inputs: { ...context.inputs, dry_run: dryRun } };
    if (
      !schedule('record-publish-outcome', 'cohort', results, overrides) ||
      prerequisites.some(need =>
        badResults.some(result =>
          schedule(
            'record-publish-outcome',
            'cohort',
            { ...results, [need]: result },
            overrides,
          ),
        ),
      )
    ) {
      errors.push(
        `${relativePath} cohort publish outcome must require every successful branch prerequisite and reject failed, cancelled, skipped or missing results`,
      );
    }
  }

  return errors;
}

function collectSidecarArtifactFlowErrors(workflow, relativePath) {
  const errors = [];
  const jobs = workflow.jobs ?? {};
  const expression = value => ['${{', value, '}}'].join(' ');
  const normalizedRun = step =>
    normalizeShellContinuations(stripShellComments(String(step?.run ?? '')))
      .replace(/\s+/gu, ' ')
      .trim();
  const sidecarBundleName =
    'bleedingdev-sidecar-bundle-run-' +
    expression('github.run_id') +
    '-attempt-' +
    expression('github.run_attempt');
  const sidecarReceiptName =
    'bleedingdev-sidecar-qualification-run-' +
    expression('github.run_id') +
    '-attempt-' +
    expression('github.run_attempt');
  const bundlePath = '.modern/bleedingdev-sidecars/bundle';
  const receiptPath = '.modern/bleedingdev-sidecars/qualification.json';
  const validDownload = (step, name, destination) =>
    actionMatches(step, 'actions/download-artifact') &&
    step.with?.name === name &&
    step.with?.path === destination &&
    step.with?.repository === expression('github.repository') &&
    step.with?.['run-id'] === expression('github.run_id') &&
    step.with?.['github-token'] === expression('github.token');
  const validUpload = (step, name, location) =>
    actionMatches(step, 'actions/upload-artifact') &&
    step.if === undefined &&
    step.with?.name === name &&
    step.with?.path === location &&
    step.with?.['include-hidden-files'] === true &&
    step.with?.['if-no-files-found'] === 'error';
  const prepareSteps = jobs['prepare-sidecars']?.steps ?? [];
  const prepareCommand =
    'node scripts/ultramodern-publish/prepare-sidecar-bundle.mjs --profile "$BLEEDINGDEV_SIDECAR_PROFILE" --out "$BLEEDINGDEV_SIDECAR_DIR"';
  if (
    normalizeNeeds(jobs['prepare-sidecars']).length !== 0 ||
    prepareSteps.filter(
      step => normalizedRun(step) === prepareCommand && step.if === undefined,
    ).length !== 1 ||
    prepareSteps.filter(step =>
      validUpload(step, sidecarBundleName, bundlePath),
    ).length !== 1
  ) {
    errors.push(
      `${relativePath} prepare-sidecars must prepare and upload exactly one immutable sidecar bundle bound to this run and attempt`,
    );
  }
  const qualifySteps = jobs['qualify-sidecars']?.steps ?? [];
  const qualifyCommand =
    'node scripts/ultramodern-publish/qualify-sidecar-bundle.mjs --out "$BLEEDINGDEV_SIDECAR_DIR" --receipt "$BLEEDINGDEV_SIDECAR_QUALIFICATION"';
  const publishBase =
    'node scripts/ultramodern-publish/publish-sidecars.mjs --mode sidecars --out "$BLEEDINGDEV_SIDECAR_DIR" --qualification "$BLEEDINGDEV_SIDECAR_QUALIFICATION"';
  const publishCommand = `${publishBase} --tag "$BLEEDINGDEV_PUBLISH_TAG"`;
  const verifyCommand = `${publishBase} --check-staging`;
  const dryCommand = `${publishCommand} --dry-run`;
  const contractTestCommand =
    'node --test scripts/ultramodern-publish/__tests__/sidecar-bundle.test.js scripts/ultramodern-publish/__tests__/sidecar-qualification.test.js scripts/ultramodern-publish/__tests__/sidecar-provenance.test.js scripts/ultramodern-publish/__tests__/sidecar-publish-lane.test.js scripts/ultramodern-publish/__tests__/packed-mf-sdk-probe.test.js scripts/ultramodern-publish/__tests__/packed-redact-probe.test.js';
  const testAt = qualifySteps.findIndex(
    step =>
      normalizedRun(step) === contractTestCommand && step.if === undefined,
  );
  const qualifyAt = qualifySteps.findIndex(
    step => normalizedRun(step) === qualifyCommand && step.if === undefined,
  );
  const dryAt = qualifySteps.findIndex(
    step => normalizedRun(step) === dryCommand && step.if === undefined,
  );
  const uploadAt = qualifySteps.findIndex(step =>
    validUpload(step, sidecarReceiptName, receiptPath),
  );
  if (
    qualifySteps.filter(step =>
      validDownload(step, sidecarBundleName, bundlePath),
    ).length !== 1 ||
    testAt === -1 ||
    !(testAt < qualifyAt && qualifyAt < dryAt && dryAt < uploadAt)
  ) {
    errors.push(
      `${relativePath} qualify-sidecars must test and qualify the exact sidecar bundle, reconcile without publication, then upload its same-run qualification receipt`,
    );
  }
  const receiptSteps = workflowSteps(workflow).filter(
    ({ step }) =>
      runIncludes(step, 'qualify-sidecar-bundle.mjs') ||
      (actionMatches(step, 'actions/upload-artifact') &&
        String(step.with?.name).includes('bleedingdev-sidecar-qualification-')),
  );
  if (
    receiptSteps.length !== 2 ||
    receiptSteps.some(({ jobId }) => jobId !== 'qualify-sidecars')
  ) {
    errors.push(
      `${relativePath} sidecar qualification receipts must be issued only by qualify-sidecars`,
    );
  }
  const publisherSteps = jobs['publish-sidecars']?.steps ?? [];
  const sidecarSteps = publisherSteps.filter(
    step => step.if === "inputs.mode == 'sidecars'",
  );
  if (
    sidecarSteps.filter(step =>
      validDownload(step, sidecarBundleName, bundlePath),
    ).length !== 1 ||
    sidecarSteps.filter(step =>
      validDownload(step, sidecarReceiptName, '.modern/bleedingdev-sidecars'),
    ).length !== 1 ||
    sidecarSteps.filter(step => normalizedRun(step) === verifyCommand)
      .length !== 1 ||
    sidecarSteps.filter(step => normalizedRun(step) === publishCommand)
      .length !== 1
  ) {
    errors.push(
      `${relativePath} publish-sidecars must download and verify the exact sidecar bundle and qualification receipt before standalone publication`,
    );
  }
  const verifyAt = publisherSteps.findIndex(
    step =>
      normalizedRun(step) === verifyCommand &&
      step.if === "inputs.mode == 'sidecars'",
  );
  const publishAt = publisherSteps.findIndex(
    step =>
      normalizedRun(step) === publishCommand &&
      step.if === "inputs.mode == 'sidecars'",
  );
  const bundleDownloadAt = publisherSteps.findIndex(
    step =>
      validDownload(step, sidecarBundleName, bundlePath) &&
      step.if === "inputs.mode == 'sidecars'",
  );
  const receiptDownloadAt = publisherSteps.findIndex(
    step =>
      validDownload(step, sidecarReceiptName, '.modern/bleedingdev-sidecars') &&
      step.if === "inputs.mode == 'sidecars'",
  );
  if (
    !(
      bundleDownloadAt >= 0 &&
      receiptDownloadAt >= 0 &&
      bundleDownloadAt < verifyAt &&
      receiptDownloadAt < verifyAt &&
      verifyAt < publishAt
    )
  ) {
    errors.push(
      `${relativePath} standalone sidecar publication must follow both exact artifact downloads and qualification verification`,
    );
  }
  for (const step of publisherSteps) {
    const name = String(step.with?.name ?? '');
    if (
      (name.includes('BLEEDINGDEV_RELEASE_BUNDLE_ARTIFACT') ||
        name.includes('BLEEDINGDEV_RELEASE_ACCEPTANCE_ARTIFACT') ||
        runIncludes(step, 'run-release-acceptance.mjs') ||
        (runIncludes(step, 'publish-sidecars.mjs') &&
          !runIncludes(step, '--mode sidecars'))) &&
      step.if !== "inputs.mode == 'cohort'"
    ) {
      errors.push(
        `${relativePath} publish-sidecars must read cohort artifacts and receipts only in cohort mode`,
      );
    }
  }
  if (
    workflow.env?.BLEEDINGDEV_SIDECAR_DIR !== bundlePath ||
    workflow.env?.BLEEDINGDEV_SIDECAR_QUALIFICATION !== receiptPath
  ) {
    errors.push(
      `${relativePath} must pin sidecar artifact and qualification paths independently of the cohort`,
    );
  }
  return errors;
}

function collectBleedingdevModeErrors(workflow, relativePath) {
  return [
    ...collectBleedingdevModeInputErrors(workflow, relativePath),
    ...collectBleedingdevModeScheduleErrors(workflow, relativePath),
    ...collectSidecarArtifactFlowErrors(workflow, relativePath),
  ];
}

function collectBleedingdevPublishStructureErrors(workflow, relativePath) {
  if (relativePath !== bleedingdevPublishWorkflowPath) {
    return [];
  }
  const errors = collectBleedingdevModeErrors(workflow, relativePath);
  const jobs = isObject(workflow.jobs) ? workflow.jobs : {};

  for (const scope of elevatedPermissionScopes(
    workflow.permissions,
    bleedingdevGuardedPermissionScopes,
  )) {
    errors.push(
      `${relativePath} must not grant ${scope}: write at the workflow level`,
    );
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job) || bleedingdevElevatedPermissionJobs.includes(jobId)) {
      continue;
    }
    for (const scope of elevatedPermissionScopes(
      job.permissions,
      bleedingdevGuardedPermissionScopes,
    )) {
      errors.push(
        `${relativePath} job ${jobId} must not grant ${scope}: write; confined to ${bleedingdevElevatedPermissionJobs.join(
          ', ',
        )}`,
      );
    }
  }

  // A release job that fails must turn the run red so `gh run rerun --failed`
  // can finish it; continue-on-error hides the failure behind a green run.
  for (const [jobId, job] of Object.entries(jobs)) {
    if (isObject(job) && 'continue-on-error' in job) {
      errors.push(
        `${relativePath} job ${jobId} must not set continue-on-error; let the run fail so the job can be rerun with gh run rerun --failed`,
      );
    }
  }
  for (const { jobId, step } of workflowSteps(workflow)) {
    if ('continue-on-error' in step) {
      errors.push(
        `${relativePath} job ${jobId} step ${step.name ?? step.id ?? '<unnamed>'} must not set continue-on-error; let the run fail so the job can be rerun with gh run rerun --failed`,
      );
    }
  }

  for (const [jobId, required] of Object.entries(bleedingdevRequiredNeeds)) {
    const needs = new Set(normalizeNeeds(jobs[jobId]));
    for (const requiredJob of required) {
      if (!needs.has(requiredJob)) {
        errors.push(
          `${relativePath} job ${jobId} must need ${requiredJob} so a registry or rehearsal failure stops the release before the expensive jobs finish`,
        );
      }
    }
  }
  // The release reaches integration through needs on its own commit, never
  // by polling another run's check.
  if (
    jobs.integration?.uses !== `./${integrationWorkflowPath}` ||
    !normalizeNeeds(jobs['qualify-source']).includes('integration')
  ) {
    errors.push(
      `${relativePath} job qualify-source must need an integration job that uses ./${integrationWorkflowPath}, so a commit with red integration is never qualified`,
    );
  }
  const qualificationNeeds = normalizeNeeds(jobs['qualify-source']);
  if (
    qualificationNeeds.length !== 2 ||
    !qualificationNeeds.includes('qualify-source-compute') ||
    normalizeNeeds(jobs['qualify-source-compute']).length !== 0
  ) {
    errors.push(
      `${relativePath} qualify-source must join integration and independent qualify-source-compute before issuing a receipt`,
    );
  }
  const qualificationContext = {
    github: {
      actor: 'BleedingDev',
      ref: 'refs/heads/main-ultramodern',
      repository_owner: 'ultramodernjs',
      triggering_actor: 'BleedingDev',
    },
    inputs: { mode: 'cohort', dry_run: false, recovery_run_id: '' },
    vars: {},
  };
  const qualificationResults = {
    integration: 'success',
    'qualify-source-compute': 'success',
  };
  const schedulesQualification = (results, context = qualificationContext) =>
    evaluateJobSchedule({
      workflow,
      jobId: 'qualify-source',
      results,
      context,
    });
  if (
    !schedulesQualification(qualificationResults) ||
    ['integration', 'qualify-source-compute'].some(jobId =>
      ['failure', 'cancelled', 'skipped'].some(result =>
        schedulesQualification({ ...qualificationResults, [jobId]: result }),
      ),
    ) ||
    ['actor', 'triggering_actor'].some(field =>
      schedulesQualification(qualificationResults, {
        ...qualificationContext,
        github: { ...qualificationContext.github, [field]: 'someone-else' },
      }),
    )
  ) {
    errors.push(
      `${relativePath} qualify-source must require successful integration and qualification; failure, cancellation or skip must never authorize a source receipt`,
    );
  }
  const receiptSteps = workflowSteps(workflow).filter(
    ({ step }) =>
      runIncludes(step, 'source-qualification.mjs create') ||
      (actionMatches(step, 'actions/upload-artifact') &&
        String(step.with?.name).includes(
          'BLEEDINGDEV_SOURCE_QUALIFICATION_ARTIFACT',
        )),
  );
  if (
    receiptSteps.length !== 2 ||
    receiptSteps.some(
      ({ jobId, step }) =>
        jobId !== 'qualify-source' ||
        step.if !== "inputs.recovery_run_id == ''",
    )
  ) {
    errors.push(
      `${relativePath} source qualification receipts must be created and uploaded only by the successful qualify-source join in the source lane`,
    );
  }
  const securitySteps = Array.isArray(jobs['publish-security']?.steps)
    ? jobs['publish-security'].steps
    : [];
  if (
    !securitySteps.some(
      step =>
        typeof step?.run === 'string' &&
        /^node scripts\/ultramodern-publish\/publish-sidecars\.mjs --check-registry$/mu.test(
          stripShellComments(step.run),
        ),
    )
  ) {
    errors.push(
      `${relativePath} job publish-security must run publish-sidecars.mjs --check-registry so a never-bootstrapped sidecar fails the release at t=0`,
    );
  }

  // The Tractor baseline advances after every accepted adoption. Pinning it in
  // workflow YAML turns each advance into a workflow edit, and a workflow edit
  // landing during a publish run makes GitHub refuse that run's GITHUB_TOKEN
  // the release tag. Both lanes read the one reviewed pin file instead.
  for (const jobId of ['rehearse-tractor', 'tractor-downstream']) {
    if (
      jobs[jobId]?.uses !==
        './.github/workflows/ultramodern-tractor-downstream.yml' ||
      (isObject(jobs[jobId]?.with) && 'tractor_ref' in jobs[jobId].with)
    ) {
      errors.push(
        `${relativePath} job ${jobId} must call ultramodern-tractor-downstream.yml without a tractor_ref; the baseline lives in ${tractorBaselinePinPath}`,
      );
    }
  }
  for (const { jobId, step } of workflowSteps(workflow)) {
    if (typeof step.run !== 'string') continue;
    const command = stripShellComments(step.run);
    const hasInlineNode = shellCommandWords(
      normalizeShellContinuations(command),
    ).some(words => {
      const index = words.findIndex(word =>
        /(?:^|[/(])node(?:\.exe)?$/u.test(word),
      );
      if (index === -1) return false;
      const args = words.slice(index + 1);
      const fixedScript = value =>
        /^scripts\/[A-Za-z0-9_./-]+\.m?js$/u.test(value);
      if (args[0] === '--test') {
        return args.length < 2 || args.slice(1).some(arg => !fixedScript(arg));
      }
      return !fixedScript(args[0]);
    });
    if (command.includes('<<') || hasInlineNode) {
      errors.push(
        `${relativePath} job ${jobId} must use fixed Node script entrypoints, not inline programs`,
      );
    }
  }

  const actualJobs = Object.keys(jobs).sort();
  const unexpectedJobs = actualJobs.filter(
    jobId => !bleedingdevPublishJobs.includes(jobId),
  );
  const missingJobs = bleedingdevPublishJobs.filter(
    jobId => !actualJobs.includes(jobId),
  );
  if (unexpectedJobs.length > 0 || missingJobs.length > 0) {
    errors.push(
      `${relativePath} job set must be exactly ${bleedingdevPublishJobs.join(
        ', ',
      )}${
        unexpectedJobs.length > 0
          ? `; unexpected: ${unexpectedJobs.join(', ')}`
          : ''
      }${missingJobs.length > 0 ? `; missing: ${missingJobs.join(', ')}` : ''}`,
    );
  }

  const tag = isObject(workflow.env)
    ? workflow.env.BLEEDINGDEV_PUBLISH_TAG
    : undefined;
  if (tag !== bleedingdevPublishTag) {
    errors.push(
      `${relativePath} BLEEDINGDEV_PUBLISH_TAG must be ${bleedingdevPublishTag}, found ${String(
        tag,
      )}`,
    );
  }
  return errors;
}

// Consumer: .github/workflows/integration-test.yml — the integration gate
// runs on every pull request and merge-queue entry and is called by the
// release on the exact commit it publishes. Each suite is its own matrix job:
// a second suite step in one job would run only on the implicit success() of
// the first, so a red suite would hide the rest.
const integrationWorkflowPath = '.github/workflows/integration-test.yml';
const integrationTriggers = Object.freeze([
  'pull_request',
  'merge_group',
  'workflow_call',
]);
const testScriptPattern = /\btest:[\w:-]+/u;
const suiteConditionPattern = /^matrix\.suite\s*==\s*'([\w-]+)'$/u;

// Include entries can decorate an axis combination or add a standalone job.
// Only original combinations can be decorated by later include entries.
function expandIntegrationMatrix(matrix) {
  if (!isObject(matrix)) return [];
  const axes = Object.entries(matrix).filter(
    ([key, values]) =>
      !['include', 'exclude'].includes(key) && Array.isArray(values),
  );
  const excluded = combination =>
    (Array.isArray(matrix.exclude) ? matrix.exclude : []).some(
      rule =>
        isObject(rule) &&
        Object.entries(rule).every(
          ([key, value]) => String(combination[key]) === String(value),
        ),
    );
  const originals =
    axes.length === 0
      ? []
      : axes
          .reduce(
            (partial, [key, values]) =>
              partial.flatMap(combination =>
                values.map(value => ({ ...combination, [key]: value })),
              ),
            [{}],
          )
          .filter(combination => !excluded(combination));
  const combinations = originals.map(combination => ({ ...combination }));
  for (const include of Array.isArray(matrix.include) ? matrix.include : []) {
    if (!isObject(include)) continue;
    let decorated = false;
    for (const [index, original] of originals.entries()) {
      if (
        Object.entries(include).every(
          ([key, value]) =>
            !(key in original) || String(original[key]) === String(value),
        )
      ) {
        combinations[index] = { ...combinations[index], ...include };
        decorated = true;
      }
    }
    if (!decorated) combinations.push({ ...include });
  }
  return combinations;
}

function collectFrameworkPartitionErrors(workflow, relativePath) {
  const linuxRunner = [
    '${{',
    "vars.DEPOT_LINUX_RUNNER || 'ubuntu-24.04'",
    '}}',
  ].join(' ');
  const windowsRunner = [
    '${{',
    "vars.DEPOT_WINDOWS_RUNNER || 'windows-latest'",
    '}}',
  ].join(' ');
  const job = workflow.jobs?.integration;
  const combinations = expandIntegrationMatrix(job?.strategy?.matrix);
  const platforms = ['Linux', 'Windows'];
  const expected = platforms.flatMap(platform => [
    ...Array.from({ length: 6 }, (_, index) => ({
      platform,
      runner: platform === 'Linux' ? linuxRunner : windowsRunner,
      suite: 'framework',
      framework_suite: 'core',
      shard: `${index + 1}/6`,
    })),
    ...['generator-workspace', 'generator-bff'].map(frameworkSuite => ({
      platform,
      runner: platform === 'Linux' ? linuxRunner : windowsRunner,
      suite: `framework-${frameworkSuite}`,
      framework_suite: frameworkSuite,
    })),
  ]);
  const frameworkCombinations = combinations.filter(combination =>
    String(combination.suite).startsWith('framework'),
  );
  const key = ({ platform, runner, suite, framework_suite, shard }) =>
    JSON.stringify([platform, runner, suite, framework_suite, shard]);
  const complete =
    frameworkCombinations.length === expected.length &&
    expected.every(
      combination =>
        frameworkCombinations.filter(actual => key(actual) === key(combination))
          .length === 1,
    );
  const errors = [];
  if (!complete) {
    errors.push(
      `${relativePath} integration must schedule six core shards and exactly one unsharded generator-workspace and generator-bff job on Linux and Windows`,
    );
  }
  const expectedJobs = [
    ...expected,
    {
      platform: 'Linux',
      runner: linuxRunner,
      suite: 'rstest-adapter',
    },
    {
      platform: 'Windows',
      runner: windowsRunner,
      suite: 'rstest-adapter',
    },
    {
      platform: 'Linux',
      runner: linuxRunner,
      suite: 'utils',
    },
  ];
  if (
    combinations.length !== expectedJobs.length ||
    !expectedJobs.every(
      combination =>
        combinations.filter(actual => key(actual) === key(combination))
          .length === 1,
    )
  ) {
    errors.push(
      `${relativePath} integration must schedule exactly 19 jobs on their required runners: all core shards, generators, Linux and Windows adapters, and Linux package utilities`,
    );
  }
  const selector = job?.env?.MODERN_TEST_FRAMEWORK_SUITE;
  const selectorPattern =
    /^\s*\$\{\{\s*matrix\.framework_suite\s*\|\|\s*'full'\s*\}\}\s*$/u;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const selectorOverride = steps.some(
    step =>
      isObject(step) &&
      (step.env?.MODERN_TEST_FRAMEWORK_SUITE !== undefined ||
        /\bMODERN_TEST_FRAMEWORK_SUITE\s*=/u.test(String(step.run ?? '')) ||
        (testScriptPattern.test(stripShellComments(String(step.run ?? ''))) &&
          Boolean(step['continue-on-error']))),
  );
  const generatorCommands = ['generator-workspace', 'generator-bff'].every(
    suite => {
      const suiteSteps = steps.filter(
        step =>
          isObject(step) &&
          suiteConditionPattern.exec(String(step.if).trim())?.[1] ===
            `framework-${suite}` &&
          runIncludes(step, 'test:framework:prepared'),
      );
      return (
        suiteSteps.length === 1 &&
        !/--shard(?:\s|=|$)/u.test(stripShellComments(suiteSteps[0].run)) &&
        !runIncludes(suiteSteps[0], 'matrix.shard') &&
        !suiteSteps[0]['continue-on-error']
      );
    },
  );
  if (
    typeof selector !== 'string' ||
    !selectorPattern.test(selector) ||
    selectorOverride ||
    job?.['continue-on-error'] ||
    !generatorCommands
  ) {
    errors.push(
      `${relativePath} integration must select each framework partition from matrix.framework_suite and run both generator jobs without sharding, selector overrides or continue-on-error`,
    );
  }
  const aggregate = workflow.jobs?.['required-framework'];
  const aggregateCombinations = expandIntegrationMatrix(
    aggregate?.strategy?.matrix,
  );
  const aggregateMatrixComplete =
    aggregateCombinations.length === 6 &&
    platforms.every(platform =>
      [1, 2, 3].every(
        shard =>
          aggregateCombinations.filter(
            combination =>
              combination.platform === platform &&
              String(combination.required_shard) === String(shard),
          ).length === 1,
      ),
    );
  const aggregateSteps = Array.isArray(aggregate?.steps) ? aggregate.steps : [];
  const resultSteps = aggregateSteps.filter(
    step =>
      isObject(step) &&
      /^\s*test\s+"\$INTEGRATION_RESULT"\s*=\s*success\s*$/u.test(
        String(step.run ?? ''),
      ) &&
      /^\s*\$\{\{\s*needs\.integration\.result\s*\}\}\s*$/u.test(
        String(step.env?.INTEGRATION_RESULT ?? ''),
      ) &&
      step.if === undefined &&
      !step['continue-on-error'],
  );
  const schedulesAggregate = [
    'success',
    'failure',
    'cancelled',
    'skipped',
  ].every(result =>
    evaluateJobSchedule({
      workflow,
      jobId: 'required-framework',
      results: { integration: result },
      context: {},
    }),
  );
  const aggregateName =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions check name.
    'integration-${{ matrix.platform }} (framework ${{ matrix.required_shard }}/3)';
  if (
    !aggregateMatrixComplete ||
    aggregate?.name !== aggregateName ||
    JSON.stringify(normalizeNeeds(aggregate)) !==
      JSON.stringify(['integration']) ||
    aggregate?.['continue-on-error'] ||
    !schedulesAggregate ||
    resultSteps.length !== 1
  ) {
    errors.push(
      `${relativePath} required-framework must preserve all six protected check names and fail unless the entire integration matrix succeeds, including failed, cancelled or skipped generator jobs`,
    );
  }
  return errors;
}

function collectIntegrationConcurrencyErrors(workflow, relativePath) {
  const concurrency = workflow.concurrency;
  const group =
    typeof concurrency?.group === 'string'
      ? /^\s*\$\{\{([\s\S]+)\}\}\s*$/u.exec(concurrency.group)?.[1]
      : undefined;
  const directRef = 'refs/pull/209/merge';
  const directGithub = {
    event_name: 'pull_request',
    repository: 'BleedingDev/ultramodern.js',
    repository_id: '42',
    ref: directRef,
    workflow: 'Integration Test',
    workflow_ref: `BleedingDev/ultramodern.js/${integrationWorkflowPath}@${directRef}`,
    head_ref: 'main',
    event: { pull_request: { number: 209 } },
    run_id: '1001',
    run_attempt: '1',
  };
  const cases = [
    { github: directGithub, key: 'pr-209', cancel: true },
    {
      github: { ...directGithub, run_id: '1002' },
      key: 'pr-209',
      cancel: true,
    },
    {
      github: { ...directGithub, workflow: 'Renamed integration check' },
      key: 'pr-209',
      cancel: true,
    },
    {
      github: {
        ...directGithub,
        ref: 'refs/pull/210/merge',
        workflow_ref:
          'BleedingDev/ultramodern.js/.github/workflows/integration-test.yml@refs/pull/210/merge',
        event: { pull_request: { number: 210 } },
      },
      key: 'pr-210',
      cancel: true,
    },
    {
      github: {
        ...directGithub,
        workflow_ref:
          'BleedingDev/ultramodern.js/.github/workflows/publish-bleedingdev.yml@refs/pull/209/merge',
      },
      key: 'run-1001-attempt-1',
      cancel: false,
    },
    ...['push', 'merge_group', 'workflow_dispatch', 'workflow_call'].flatMap(
      eventName =>
        [
          ['1001', '1'],
          ['1002', '1'],
          ['1001', '2'],
        ].map(([runId, runAttempt]) => ({
          github: {
            ...directGithub,
            event_name: eventName,
            ref: 'refs/heads/main-ultramodern',
            workflow_ref:
              'BleedingDev/ultramodern.js/.github/workflows/integration-test.yml@refs/heads/main-ultramodern',
            run_id: runId,
            run_attempt: runAttempt,
          },
          key: `run-${runId}-attempt-${runAttempt}`,
          cancel: false,
        })),
    ),
  ];
  const evaluates = (condition, github) =>
    evaluateJobSchedule({
      workflow: { jobs: { probe: { if: condition } } },
      jobId: 'probe',
      context: { github },
    });
  if (
    group === undefined ||
    cases.some(
      ({ github, key, cancel }) =>
        evaluates(concurrency?.['cancel-in-progress'], github) !== cancel ||
        !evaluates(`(${group}) == 'integration-test-42-${key}'`, github),
    )
  ) {
    return [
      `${relativePath} integration concurrency must cancel only direct pull requests, isolate different PRs, and preserve every reusable, release, merge-queue and manual run attempt`,
    ];
  }
  return [];
}

function collectIntegrationGateErrors(workflow, relativePath) {
  if (relativePath !== integrationWorkflowPath) {
    return [];
  }
  const triggers = getTriggers(workflow);
  const errors = integrationTriggers
    .filter(trigger => !triggers.includes(trigger))
    .map(
      trigger =>
        `${relativePath} must trigger on ${trigger}: integration gates pull requests, the merge queue and the release`,
    );
  if (isObject(workflow.on)) {
    for (const [event, config] of Object.entries(workflow.on)) {
      if (
        isObject(config) &&
        ['paths', 'paths-ignore'].some(filter => filter in config)
      ) {
        errors.push(
          `${relativePath} on.${event} must not filter paths: a required check has to report on every change`,
        );
      }
    }
  }
  const suitesByJob = new Map();
  for (const { jobId, job, step } of workflowSteps(workflow)) {
    if (
      typeof step.run !== 'string' ||
      !testScriptPattern.test(stripShellComments(step.run))
    ) {
      continue;
    }
    const matrixSuites = expandIntegrationMatrix(job.strategy?.matrix).map(
      combination => combination.suite,
    );
    const suite = suiteConditionPattern.exec(
      typeof step.if === 'string' ? step.if.trim() : '',
    )?.[1];
    const seen = suitesByJob.get(jobId) ?? [];
    suitesByJob.set(jobId, [...seen, suite]);
    if (
      suite === undefined ||
      seen.includes(suite) ||
      !Array.isArray(matrixSuites) ||
      !matrixSuites.includes(suite)
    ) {
      errors.push(
        `${relativePath} job ${jobId} step ${step.name ?? '<unnamed>'} must run one suite per job, selected by if: matrix.suite == '<suite>' from the job's matrix.suite`,
      );
    }
  }
  // A sharded suite must run every slice on every platform: shards 1/N
  // through N/N, once each, in the matrix GitHub actually expands (axes minus
  // exclude). A dropped or duplicated shard would silently lose tests.
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const matrix = isObject(job) ? job.strategy?.matrix : undefined;
    if (!isObject(matrix) || matrix.shard === undefined) continue;
    const axes = Object.entries(matrix).filter(
      ([key, values]) =>
        !['include', 'exclude'].includes(key) && Array.isArray(values),
    );
    const combinations = expandIntegrationMatrix(matrix);
    const shards = Array.isArray(matrix.shard) ? matrix.shard.map(String) : [];
    const expected = shards.map((_, index) => `${index + 1}/${shards.length}`);
    const shardedSuites = new Set(
      (Array.isArray(job.steps) ? job.steps : [])
        .filter(step => isObject(step) && runIncludes(step, 'matrix.shard'))
        .map(step => suiteConditionPattern.exec(String(step.if).trim())?.[1]),
    );
    const groups = new Map();
    for (const { shard, ...rest } of combinations) {
      if (!shardedSuites.has(rest.suite)) continue;
      const key = JSON.stringify(
        Object.fromEntries(
          axes
            .filter(([key]) => key !== 'shard')
            .map(([key]) => [key, rest[key]]),
        ),
      );
      groups.set(key, [...(groups.get(key) ?? []), String(shard)]);
    }
    const expectedGroups = axes
      .filter(([key]) => key !== 'shard')
      .reduce(
        (partial, [key, values]) =>
          partial.flatMap(combination =>
            values.map(value => ({ ...combination, [key]: value })),
          ),
        [{}],
      )
      .filter(combination => shardedSuites.has(combination.suite))
      .map(JSON.stringify);
    const complete =
      shards.length > 1 &&
      shards.every((shard, index) => shard === expected[index]) &&
      groups.size > 0 &&
      expectedGroups.every(key => groups.has(key)) &&
      [...groups.values()].every(
        scheduled =>
          scheduled.length === expected.length &&
          expected.every(shard => scheduled.includes(shard)),
      );
    if (!complete) {
      errors.push(
        `${relativePath} job ${jobId} must schedule shards 1/N through N/N exactly once for every sharded suite combination, so the shards together run the whole suite`,
      );
    }
  }
  // A suite without its step would be a green job that tests nothing.
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const matrixSuites = isObject(job)
      ? [
          ...new Set(
            expandIntegrationMatrix(job.strategy?.matrix).map(
              combination => combination.suite,
            ),
          ),
        ]
      : [];
    for (const suite of matrixSuites.filter(
      suite => typeof suite === 'string',
    )) {
      if (!(suitesByJob.get(jobId) ?? []).includes(suite)) {
        errors.push(
          `${relativePath} job ${jobId} matrix suite ${suite} has no step gated by if: matrix.suite == '${suite}', so that job would pass without testing anything`,
        );
      }
    }
  }
  errors.push(...collectFrameworkPartitionErrors(workflow, relativePath));
  errors.push(...collectIntegrationConcurrencyErrors(workflow, relativePath));
  return errors;
}

// actions/cache versions an entry by the literal path strings, so a `..` or
// `.` segment spelling of a directory never shares an entry with its normalized
// spelling and hides which directory is cached. Pass a normalized path.
const cacheActionPattern = /^actions\/cache(?:\/(?:restore|save))?@/iu;
const relativePathSegmentPattern = /(?:^|[\\/])\.{1,2}(?=[\\/]|$)/u;

function collectCachePathErrors(workflow, relativePath) {
  const errors = [];
  for (const { jobId, step } of workflowSteps(workflow)) {
    const cachePath = step.with?.path;
    if (
      typeof step.uses !== 'string' ||
      !cacheActionPattern.test(step.uses) ||
      typeof cachePath !== 'string'
    ) {
      continue;
    }
    for (const line of cachePath.split('\n')) {
      if (relativePathSegmentPattern.test(line.trim())) {
        errors.push(
          `${relativePath} job ${jobId} step ${step.name ?? step.id ?? '<unnamed>'} caches ${line.trim()}, which contains a .. or . segment; pass the normalized path (e.g. from the step that provisions it)`,
        );
      }
    }
  }
  return errors;
}

// The `runner` context is unavailable in workflow- and job-level env, so a
// `runner.*` expression there fails the run before any step starts. Export
// runner paths from a step through GITHUB_ENV instead.
const runnerContextPattern = /\$\{\{[^}]*\brunner\./u;

function collectEnvRunnerContextErrors(workflow, relativePath) {
  const scopes = [['workflow', workflow.env]];
  if (isObject(workflow.jobs)) {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      scopes.push([`job ${jobId}`, isObject(job) ? job.env : undefined]);
    }
  }
  const errors = [];
  for (const [scope, env] of scopes) {
    if (!isObject(env)) continue;
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && runnerContextPattern.test(value)) {
        errors.push(
          `${relativePath} ${scope} env ${name} reads the runner context, which workflow- and job-level env cannot access; export it from a step through GITHUB_ENV`,
        );
      }
    }
  }
  return errors;
}

/**
 * Release gates must run whole suites. A node:test filter flag (argv or
 * NODE_OPTIONS) silently drops cases, so a qualify step can go green on a
 * suite that is partly skipped or sharded.
 */
const testFilterFlagPattern =
  /--test-(?:skip-pattern|name-pattern|only|shard)\b/u;

const collectTestFilterFindings = (workflow, content) => {
  const findings = [];
  walkValues(workflow, (value, valuePath) => {
    if (
      typeof value !== 'string' ||
      !(valuePath.at(-1) === 'run' || valuePath.includes('env'))
    ) {
      return;
    }
    const match = stripShellComments(value).match(testFilterFlagPattern);
    if (match) {
      findings.push(
        sourceFinding(
          content,
          new RegExp(escapeRegExp(match[0]), 'u'),
          match[0],
        ),
      );
    }
  });
  return findings;
};

/**
 * CI must never decide at runtime to skip itself. A step that diffs against a
 * guessed base (the old skipCI.js diffed `origin/main`, a branch this fork
 * does not target) and gates later steps on its output turns required checks
 * green without running them. Trigger-level `paths-ignore` is the one place to
 * skip docs-only changes, and it must never hide workflow edits.
 */
const skipGatePatterns = [
  /\bskipCI\b/u,
  /\bsteps\.skip-ci\b/u,
  /\bgit\s+diff\b[^\n]*\borigin\/main(?![\w-])/u,
];

const collectSkipGateFindings = (workflow, content) => {
  const findings = [];
  walkValues(workflow, value => {
    if (typeof value !== 'string') {
      return;
    }
    for (const pattern of skipGatePatterns) {
      const match = value.match(pattern);
      if (match) {
        findings.push(
          sourceFinding(
            content,
            new RegExp(escapeRegExp(match[0]), 'u'),
            match[0],
          ),
        );
      }
    }
  });
  return findings;
};

// The same gate under any name: a step that lists changed files (git diff,
// a changed-files action) whose outputs decide whether later steps run.
const changeDetectionRunPattern =
  /\bgit\s+(?:diff|log|show|whatchanged)\b[^\n]*--name-(?:only|status)\b|\bgit\s+diff\b/u;
const changeDetectionActions = [
  'dorny/paths-filter',
  'tj-actions/changed-files',
];

// `steps.<id>.outputs` in an expression, with either segment also in
// bracket form (`steps['<id>']['outputs']`). Only outputs carry a skip
// decision; `outcome` and `conclusion` references are failure reporting and
// cleanup.
const stepReferencePattern = id =>
  new RegExp(
    `\\bsteps(?:\\.${escapeRegExp(id)}(?![\\w-])|\\[\\s*(['"])${escapeRegExp(id)}\\1\\s*\\])\\s*(?:\\.\\s*outputs\\b|\\[\\s*(['"])outputs\\2\\s*\\])`,
    'u',
  );

const collectChangeGatedSteps = (workflow, content) => {
  const findings = [];
  const detectorIds = new Map();
  for (const { jobId, step } of workflowSteps(workflow)) {
    const detects =
      (typeof step.run === 'string' &&
        changeDetectionRunPattern.test(stripShellComments(step.run))) ||
      changeDetectionActions.some(action => actionMatches(step, action));
    if (detects && typeof step.id === 'string') {
      detectorIds.set(jobId, [...(detectorIds.get(jobId) ?? []), step.id]);
    }
  }
  for (const { jobId, step } of workflowSteps(workflow)) {
    const condition = typeof step.if === 'string' ? step.if : '';
    const reference = (detectorIds.get(jobId) ?? [])
      .map(stepReferencePattern)
      .find(pattern => pattern.test(condition));
    if (reference) {
      findings.push(sourceFinding(content, reference, condition));
    }
  }
  return findings;
};

// GitHub filter pattern syntax (docs: "Filter pattern cheat sheet"): `*` is
// any run of non-`/` characters, `**` any run of characters (`**/` also zero
// directories), `?` and `+` quantify the preceding character, `[...]` is a
// character class, `\` escapes the next character. Dots are ordinary
// characters, so `**` matches `.github`. Node glob differs on all of these,
// hence a direct translation.
const pathFilterRegExp = pattern => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      source += escapeRegExp(pattern[index + 1]);
      index += 1;
    } else if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*') {
      const double = pattern[index + 1] === '*';
      source += double ? '.*' : '[^/]*';
      index += double ? 1 : 0;
    } else if (char === '?' || char === '+') {
      source += char;
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      source += close === -1 ? '\\[' : `[${pattern.slice(index + 1, close)}]`;
      index = close === -1 ? index : close;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, 'u');
};
const pathFilterMatches = (file, pattern) =>
  pathFilterRegExp(pattern).test(file);

// A trigger path filter must let an edit of the workflow itself run it, with
// GitHub's semantics: any `paths-ignore` match skips the file, and in `paths`
// the last matching pattern wins (`!` negates).
const filterRunsFile = (filter, patterns, file) => {
  if (filter === 'paths-ignore') {
    return !patterns.some(pattern => pathFilterMatches(file, pattern));
  }
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (pathFilterMatches(file, negated ? pattern.slice(1) : pattern)) {
      included = !negated;
    }
  }
  return included;
};

const collectSelfHidingPathFilters = (workflow, relativePath) => {
  const findings = [];
  if (!isObject(workflow.on)) {
    return findings;
  }
  for (const [event, config] of Object.entries(workflow.on)) {
    if (!isObject(config)) {
      continue;
    }
    for (const filter of ['paths', 'paths-ignore']) {
      const patterns = config[filter];
      if (
        Array.isArray(patterns) &&
        !filterRunsFile(
          filter,
          patterns.filter(pattern => typeof pattern === 'string'),
          relativePath,
        )
      ) {
        findings.push({ event, filter });
      }
    }
  }
  return findings;
};

const getTriggers = workflow => {
  const triggers = workflow.on;
  if (typeof triggers === 'string') {
    return [triggers];
  }
  if (Array.isArray(triggers)) {
    return triggers.filter(trigger => typeof trigger === 'string');
  }
  return isObject(triggers) ? Object.keys(triggers) : [];
};

const workflowRunConfig = workflow =>
  isObject(workflow.on) && isObject(workflow.on.workflow_run)
    ? workflow.on.workflow_run
    : undefined;

/**
 * Find `${{ inputs.* }}` / `${{ github.event.inputs.* }}` interpolations
 * inside `run:` scalars (inline or block). `env:`-routed inputs and `if:`
 * expressions are fine — only shell text is an injection vector.
 */
export function collectRunBlockInputInterpolations(content) {
  const { value } = parseYaml(content);
  if (value === undefined) {
    return [];
  }
  const findings = [];
  walkValues(value, (item, valuePath) => {
    if (
      valuePath.at(-1) === 'run' &&
      typeof item === 'string' &&
      runInputPattern.test(item)
    ) {
      findings.push(sourceFindingForValue(content, item, 'run:'));
    }
  });
  return findings;
}

const collectPrivilegedTriggers = workflow =>
  getTriggers(workflow).filter(trigger =>
    privilegedTriggerNames.includes(trigger),
  );

const permissionIsWrite = permission =>
  typeof permission === 'string' &&
  /^(?:write|write-all)$/iu.test(permission.trim());

const collectElevatedPermissionLines = (workflow, content) => {
  const findings = [];
  const collect = permissions => {
    if (permissionIsWrite(permissions)) {
      findings.push(
        sourceFindingForValue(content, permissions, 'permissions:'),
      );
      return;
    }
    if (!isObject(permissions)) {
      return;
    }
    for (const [scope, value] of Object.entries(permissions)) {
      if (permissionIsWrite(value)) {
        findings.push(
          sourceFinding(
            content,
            new RegExp(`${escapeRegExp(scope)}\\s*:.*(?:write)`, 'iu'),
            'permissions:',
          ),
        );
      }
    }
  };
  collect(workflow.permissions);
  if (isObject(workflow.jobs)) {
    Object.values(workflow.jobs).forEach(job => {
      if (isObject(job)) {
        collect(job.permissions);
      }
    });
  }
  return findings;
};

const isLiteralWorkflowRunBranch = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/[\s#!$*?[\]{}\\]/u.test(value);

const hasLiteralWorkflowRunBranchRestriction = workflow => {
  const config = workflowRunConfig(workflow);
  return (
    isObject(config) &&
    Array.isArray(config.branches) &&
    config.branches.length > 0 &&
    config.branches.every(isLiteralWorkflowRunBranch)
  );
};

const secretExpressionPattern = /\$\{\{[^}]*\bsecrets\b[^}]*\}\}/u;

const collectSecretExposures = (workflow, content) => {
  const findings = [];
  walkValues(workflow, (value, valuePath) => {
    if (
      (valuePath.at(-1) === 'secrets' && value === 'inherit') ||
      (typeof value === 'string' && secretExpressionPattern.test(value))
    ) {
      findings.push({
        ...sourceFindingForValue(content, value, 'secrets:'),
        jobName:
          valuePath[0] === 'jobs' && typeof valuePath[1] === 'string'
            ? valuePath[1]
            : undefined,
      });
    }
  });
  return findings;
};

const unwrapIfExpression = value => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const expression = value.trim();
  const wrapped = expression.match(/^\$\{\{\s*(.*?)\s*\}\}$/u);
  return wrapped ? wrapped[1] : expression;
};

const workflowRunSameRepositoryGuardPatterns = [
  /^github\s*\.\s*event\s*\.\s*workflow_run\s*\.\s*head_repository\s*\.\s*full_name\s*==\s*github\s*\.\s*repository$/u,
  /^github\s*\.\s*repository\s*==\s*github\s*\.\s*event\s*\.\s*workflow_run\s*\.\s*head_repository\s*\.\s*full_name$/u,
];

const hasWorkflowRunSameRepositoryGuard = job => {
  const condition = unwrapIfExpression(job.if);
  if (!condition || condition.includes('||')) {
    return false;
  }
  return condition
    .split('&&')
    .map(conjunct => conjunct.trim())
    .some(conjunct =>
      workflowRunSameRepositoryGuardPatterns.some(pattern =>
        pattern.test(conjunct),
      ),
    );
};

const isJobLimitedToNonPrivilegedEvent = job => {
  const condition = unwrapIfExpression(job.if);
  if (!condition || condition.includes('||')) {
    return false;
  }
  const conjuncts = condition.split('&&').map(conjunct => conjunct.trim());
  if (conjuncts.some(conjunct => conjunct === '')) {
    return false;
  }
  const eventNameConjuncts = conjuncts.filter(conjunct =>
    /\bgithub\s*\.\s*event_name\b/u.test(conjunct),
  );
  if (eventNameConjuncts.length === 0) {
    return false;
  }
  const eventNames = eventNameConjuncts.map(conjunct => {
    const match = conjunct.match(
      /^github\s*\.\s*event_name\s*==\s*(['"])([A-Za-z_][\w-]*)\1$/u,
    );
    return match?.[2];
  });
  return (
    eventNames.every(Boolean) &&
    new Set(eventNames).size === 1 &&
    !privilegedTriggerNames.includes(eventNames[0])
  );
};

const isSecretReachableOnPrivilegedPath = (exposure, workflow) => {
  if (!exposure.jobName || !isObject(workflow.jobs?.[exposure.jobName])) {
    return true;
  }
  return !isJobLimitedToNonPrivilegedEvent(workflow.jobs[exposure.jobName]);
};

const getExpression = value => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = value.match(/^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/u);
  return match?.[1];
};

const getEnvironmentReference = value => {
  const expression = getExpression(value);
  return expression?.match(/^env\s*\.\s*([A-Za-z_][\w-]*)$/u)?.[1];
};

const envValue = (name, step, job, workflow) => {
  for (const env of [step.env, job.env, workflow.env]) {
    if (
      isObject(env) &&
      Object.hasOwn(env, name) &&
      typeof env[name] === 'string'
    ) {
      return env[name];
    }
  }
  return undefined;
};

const resolveCheckoutRef = (ref, step, job, workflow) => {
  const name = getEnvironmentReference(ref);
  if (!name) {
    return { value: ref, viaEnvironment: false };
  }
  const value = envValue(name, step, job, workflow);
  return { value, viaEnvironment: true };
};

const isFullSha = value =>
  typeof value === 'string' && shaPattern.test(value.trim());

const isExactWorkflowRunHeadSha = value =>
  typeof value === 'string' && exactWorkflowRunHeadShaRefPattern.test(value);

const isCheckoutAction = uses =>
  typeof uses === 'string' &&
  uses.toLowerCase().startsWith('actions/checkout@');

const isLocalReusableWorkflow = uses =>
  typeof uses === 'string' &&
  /^\.\/\.github\/workflows\/[^\s]+\.ya?ml$/iu.test(uses.trim());

const collectLocalReusableWorkflowDelegations = (workflow, content) => {
  if (!isObject(workflow.jobs)) {
    return [];
  }
  return Object.values(workflow.jobs).flatMap(job =>
    isObject(job) && isLocalReusableWorkflow(job.uses)
      ? [sourceFindingForValue(content, job.uses, 'uses:')]
      : [],
  );
};

const collectUntrustedCheckoutRefs = (
  workflow,
  content,
  hasTrustedWorkflowRunHeadShaPolicy,
) => {
  const findings = [];
  if (!isObject(workflow.jobs)) {
    return findings;
  }
  for (const job of Object.values(workflow.jobs)) {
    if (!isObject(job) || !Array.isArray(job.steps)) {
      continue;
    }
    for (const step of job.steps) {
      if (
        !isObject(step) ||
        typeof step.uses !== 'string' ||
        !isCheckoutAction(step.uses) ||
        !isObject(step.with) ||
        !Object.hasOwn(step.with, 'ref')
      ) {
        continue;
      }
      if (typeof step.with.ref !== 'string') {
        findings.push(sourceFindingForValue(content, step.with.ref, 'ref:'));
        continue;
      }
      const resolved = resolveCheckoutRef(step.with.ref, step, job, workflow);
      if (
        isFullSha(resolved.value) ||
        (hasTrustedWorkflowRunHeadShaPolicy &&
          hasWorkflowRunSameRepositoryGuard(job) &&
          isExactWorkflowRunHeadSha(resolved.value))
      ) {
        continue;
      }
      findings.push(sourceFindingForValue(content, step.with.ref, 'ref:'));
    }
  }
  return findings;
};

const requiredSensitiveChecks = [
  {
    label: 'permissions: contents: read',
    test: workflow => workflow.permissions?.contents === 'read',
  },
  {
    label: 'persist-credentials: false',
    test: workflow =>
      workflowSteps(workflow).some(
        ({ step }) =>
          isCheckoutAction(step.uses) &&
          step.with?.['persist-credentials'] === false,
      ),
  },
  {
    label: 'timeout-minutes:',
    test: workflow =>
      Object.values(workflow.jobs ?? {}).some(
        job =>
          isObject(job) &&
          Number.isInteger(job['timeout-minutes']) &&
          job['timeout-minutes'] > 0,
      ),
  },
  {
    // Accept either egress mode: `block` is the stronger posture and must
    // never fail the gate.
    label: 'egress-policy: audit|block',
    test: workflow =>
      workflowSteps(workflow).some(
        ({ step }) =>
          actionMatches(step, 'step-security/harden-runner') &&
          ['audit', 'block'].includes(step.with?.['egress-policy']),
      ),
  },
];

function collectAdvisoryInstallErrors(workflow, relativePath) {
  if (relativePath !== '.github/workflows/check-dependencies.yml') return [];
  const job = workflow.jobs?.advisories;
  const steps = job?.steps ?? [];
  const normalize = step =>
    normalizeShellContinuations(stripShellComments(String(step?.run ?? '')))
      .replace(/\s+/gu, ' ')
      .trim();
  const install = steps.findIndex(
    step =>
      normalize(step) ===
      'mise exec -- pnpm install --prod --frozen-lockfile --ignore-scripts',
  );
  const audits = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) =>
      normalize(step).includes('scripts/security/advisory-gate.mjs'),
    );
  if (
    job?.if !== undefined ||
    job?.['continue-on-error'] !== undefined ||
    install < 0 ||
    steps[install]?.if !== undefined ||
    steps[install]?.background !== undefined ||
    steps[install]?.['continue-on-error'] !== undefined ||
    audits.length !== 1 ||
    audits[0].index <= install ||
    audits[0].step.if !== undefined ||
    audits[0].step['continue-on-error'] !== undefined ||
    normalize(audits[0].step) !==
      'mise exec -- node scripts/security/advisory-gate.mjs'
  ) {
    return [
      `${relativePath} advisories must run the exact frozen production install before the mandatory repository advisory guard`,
    ];
  }
  return [];
}

export function validateWorkflowContent(relativePath, content, options = {}) {
  const allowlist = options.allowlist ?? ALLOWLIST;
  const sensitive =
    options.sensitive ?? sensitiveWorkflowPaths.has(relativePath);
  const parsed = parseWorkflow(content);
  if (!parsed.workflow) {
    const line = parsed.error?.mark?.line;
    const location = Number.isInteger(line) ? `:${line + 1}` : '';
    return [
      `${relativePath}${location} must contain valid workflow YAML: ${parsed.error.message}`,
    ];
  }
  const workflow = parsed.workflow;
  const privilegedTriggers = collectPrivilegedTriggers(workflow);
  const errors = [];
  const push = (rule, message) => {
    if (!isAllowed(allowlist, relativePath, rule, message)) {
      errors.push(message);
    }
  };

  if (getTriggers(workflow).includes('pull_request_target')) {
    push(
      'pull-request-target',
      `${relativePath} must not use pull_request_target`,
    );
  }
  if (privilegedTriggers.length > 0) {
    const triggerList = privilegedTriggers.join(', ');
    const elevatedPermissions = collectElevatedPermissionLines(
      workflow,
      content,
    );
    const reachableSecretExposures = collectSecretExposures(
      workflow,
      content,
    ).filter(exposure => isSecretReachableOnPrivilegedPath(exposure, workflow));
    for (const finding of elevatedPermissions) {
      push(
        'privileged-trigger-permissions',
        `${relativePath}:${finding.line} must not grant write permissions with privileged trigger (${triggerList}): ${finding.text}`,
      );
    }
    for (const finding of reachableSecretExposures) {
      push(
        'privileged-trigger-secrets',
        `${relativePath}:${finding.line} must not expose secrets with privileged trigger (${triggerList}): ${finding.text}`,
      );
    }
    const hasTrustedWorkflowRunHeadShaPolicy =
      privilegedTriggers.length === 1 &&
      privilegedTriggers[0] === 'workflow_run' &&
      hasLiteralWorkflowRunBranchRestriction(workflow) &&
      elevatedPermissions.length === 0 &&
      reachableSecretExposures.length === 0;
    for (const finding of collectLocalReusableWorkflowDelegations(
      workflow,
      content,
    )) {
      push(
        'privileged-trigger-local-reusable-workflow',
        `${relativePath}:${finding.line} must not delegate a privileged workflow to a local reusable workflow: ${finding.text}`,
      );
    }
    for (const finding of collectUntrustedCheckoutRefs(
      workflow,
      content,
      hasTrustedWorkflowRunHeadShaPolicy,
    )) {
      push(
        'privileged-trigger-checkout-ref',
        `${relativePath}:${finding.line} must not checkout untrusted event refs with privileged trigger (${triggerList}): ${finding.text}`,
      );
    }
  }
  if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(content)) {
    push(
      'npm-token',
      `${relativePath} must not reference npm token environment variables`,
    );
  }

  for (const { action, ref } of collectActionUses(workflow)) {
    if (action.startsWith('./')) {
      continue;
    }
    if (!shaPattern.test(ref)) {
      push(
        'sha-pinned-actions',
        `${relativePath} must pin ${action}@${ref} to a full commit SHA`,
      );
    }
  }

  if (!Object.hasOwn(workflow, 'permissions')) {
    push(
      'permissions-block',
      `${relativePath} must declare a top-level permissions block`,
    );
  }

  for (const finding of collectRunBlockInputInterpolations(content)) {
    push(
      'run-input-interpolation',
      `${relativePath}:${finding.line} must not interpolate workflow inputs into run blocks (route through env): ${finding.text}`,
    );
  }

  for (const finding of [
    ...collectSkipGateFindings(workflow, content),
    ...collectChangeGatedSteps(workflow, content),
  ]) {
    push(
      'skip-ci-gate',
      `${relativePath}:${finding.line} must not gate jobs on a runtime skip-CI diff; skip docs-only changes with a trigger paths-ignore instead: ${finding.text}`,
    );
  }
  if (relativePath.startsWith('.github/workflows/')) {
    for (const { event, filter } of collectSelfHidingPathFilters(
      workflow,
      relativePath,
    )) {
      push(
        'workflow-path-filter',
        `${relativePath} on.${event}.${filter} must match ${relativePath} itself; a workflow edit has to run the checks it changes`,
      );
    }
  }

  for (const message of collectReceiptRunIdentityErrors(
    workflow,
    relativePath,
  )) {
    push('receipt-run-identity', message);
  }
  if (relativePath.startsWith('.github/workflows/')) {
    for (const message of collectBareJobImportErrors(
      workflow,
      relativePath,
      options,
    )) {
      push('bare-job-import-closure', message);
    }
  }
  for (const message of collectCachePathErrors(workflow, relativePath)) {
    push('normalized-cache-path', message);
  }
  for (const message of collectAdvisoryInstallErrors(workflow, relativePath)) {
    push('advisory-installed-correction', message);
  }
  for (const message of collectEnvRunnerContextErrors(workflow, relativePath)) {
    push('env-runner-context', message);
  }
  for (const message of collectPublishOutcomeErrors(workflow, relativePath)) {
    push('publish-outcome-contract', message);
  }
  for (const message of collectIntegrationGateErrors(workflow, relativePath)) {
    push('integration-gate', message);
  }
  for (const message of collectBleedingdevPublishStructureErrors(
    workflow,
    relativePath,
  )) {
    push('bleedingdev-publish-structure', message);
  }

  if (sensitive) {
    for (const finding of collectTestFilterFindings(workflow, content)) {
      push(
        'release-test-filter',
        `${relativePath}:${finding.line} must not filter node:test cases in a release gate; fix or delete the failing test instead: ${finding.text}`,
      );
    }
    for (const check of requiredSensitiveChecks) {
      if (!check.test(workflow)) {
        push(
          'sensitive-hardening',
          `${relativePath} must include ${check.label}`,
        );
      }
    }

    if (relativePath.includes('publish')) {
      const oidcJobs = Object.values(workflow.jobs ?? {}).filter(
        job => isObject(job) && job.permissions?.['id-token'] === 'write',
      );
      if (oidcJobs.length === 0) {
        push(
          'trusted-publishing',
          `${relativePath} must grant id-token: write for trusted publishing`,
        );
      }
      if (!oidcJobs.some(job => job.environment === 'npm-publish')) {
        push(
          'trusted-publishing',
          `${relativePath} must publish through the npm-publish environment`,
        );
      }
    }
  }

  return errors;
}

/**
 * The repo-level renovate config must keep the fork's exact-pin lattice out
 * of the grouped weekly PR; each of these packages has a pinned twin
 * (pnpm patches, workspace overrides, create versions.ts, release gates)
 * that must move in lockstep.
 */
const requiredPinLatticeCarveOuts = [
  '@module-federation/**',
  '@tanstack/**',
  'react-router',
];

export function validateRenovateConfigObject(
  relativePath,
  config,
  options = {},
) {
  const errors = [];
  if (config.dependencyDashboard !== true) {
    errors.push(`${relativePath} must enable dependencyDashboard`);
  }
  if (config.minimumReleaseAge !== '1 day') {
    errors.push(`${relativePath} must set minimumReleaseAge to 1 day`);
  }
  if (!config.extends?.includes('helpers:pinGitHubActionDigests')) {
    errors.push(
      `${relativePath} must pin GitHub Action digests through Renovate`,
    );
  }
  if (
    !config.packageRules?.some(
      rule =>
        rule.dependencyDashboardApproval === true &&
        rule.matchUpdateTypes?.includes('major'),
    )
  ) {
    errors.push(
      `${relativePath} must require dashboard approval for major updates`,
    );
  }
  if (options.requirePinLatticeCarveOuts) {
    for (const packageName of requiredPinLatticeCarveOuts) {
      if (
        !config.packageRules?.some(
          rule =>
            rule.dependencyDashboardApproval === true &&
            rule.matchPackageNames?.includes(packageName),
        )
      ) {
        errors.push(
          `${relativePath} must carve ${packageName} out of grouped updates (exact-pin lattice; see pnpm-workspace.yaml patches/overrides)`,
        );
      }
    }
  }
  return errors;
}

function validateRenovateConfigFile(rootDir, relativePath, options) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return [`Missing ${relativePath}`];
  }
  const config = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  return validateRenovateConfigObject(relativePath, config, options);
}

export function validateRepository(rootDir = repoRoot) {
  const trackedFiles = listTrackedFiles(rootDir);
  const workflowErrors = collectWorkflowFiles(rootDir).flatMap(relativePath =>
    validateWorkflowContent(
      relativePath,
      fs.readFileSync(path.join(rootDir, relativePath), 'utf-8'),
      { rootDir, trackedFiles },
    ),
  );
  const renovateErrors = [
    ...validateRenovateConfigFile(rootDir, '.github/renovate.json', {
      requirePinLatticeCarveOuts: true,
    }),
    ...validateRenovateConfigFile(
      rootDir,
      'packages/toolkit/ultramodern-create/template-workspace/.github/renovate.json',
      { requirePinLatticeCarveOuts: false },
    ),
  ];
  return [
    ...workflowErrors,
    ...renovateErrors,
    ...validateTractorBaselinePin(rootDir),
  ];
}

export function validateTractorBaselinePin(rootDir = repoRoot) {
  const absolutePath = path.join(rootDir, tractorBaselinePinPath);
  const content = fs.existsSync(absolutePath)
    ? fs.readFileSync(absolutePath, 'utf-8')
    : '';
  return /^[a-f0-9]{40}\n$/u.test(content)
    ? []
    : [
        `${tractorBaselinePinPath} must hold exactly one immutable Tractor commit SHA and a trailing newline`,
      ];
}

function main() {
  const errors = validateRepository();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }
  console.log('GitHub workflow security validation passed');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
