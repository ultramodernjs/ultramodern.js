// Every CI step that reaches a package driving a real browser must run after
// scripts/lib/browser-provisioning.js installed browsers for that package's
// playwright. The nightly ran test:build-consumers for 27 days without it and
// failed at browser launch; this pins the edge for every workflow. Puppeteer
// suites launch the same playwright Chromium: puppeteer's postinstall download
// was skipped whenever a restored pnpm store replayed its side-effects cache,
// which left Windows integration without a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowsDir = path.join(repoRoot, '.github/workflows');
const provisioner = 'scripts/lib/browser-provisioning.js';

// Command -> the workspace package whose playwright it launches.
const browserCommands = [
  [/\btest:framework(?::prepared)?(?![\w:-])/u, 'tests'],
  [
    /\btest:rstest-adapter(?![\w:-])/u,
    'tests/integration/rstest/basic-app-rstest-browser',
  ],
  [
    /\btest:build-consumers(?![\w:-])/u,
    'tests/integration/ultramodern-sandpack-profile-smoke',
  ],
  // Runs tests/integration suites that launch puppeteer (tests/utils/launchOptions.js).
  [/\bvalidate:superapp-certification(?![\w-])/u, 'tests'],
];

function workflowJobs() {
  return fs
    .readdirSync(workflowsDir)
    .filter(file => /\.ya?ml$/u.test(file))
    .flatMap(file => {
      const workflow = yaml.load(
        fs.readFileSync(path.join(workflowsDir, file), 'utf8'),
      );
      return Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({
        file,
        id,
        steps: job.steps ?? [],
      }));
    });
}

function provisionedRuntimes(step) {
  const run = typeof step.run === 'string' ? step.run : '';
  if (!run.includes(`node ${provisioner} --install`)) {
    return [];
  }
  return [...run.matchAll(/--runtime\s+(\S+)/gu)].map(match => match[1]);
}

test('each browser-driving package declares the playwright it is provisioned for', () => {
  for (const [, runtime] of browserCommands) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, runtime, 'package.json'), 'utf8'),
    );
    assert.ok(
      manifest.dependencies?.playwright ?? manifest.devDependencies?.playwright,
      `${runtime} must depend on playwright directly`,
    );
  }
});

test('browser-driving steps run after the shared provisioner installed their runtime', () => {
  const checked = [];
  for (const job of workflowJobs()) {
    const provisioned = new Set();
    for (const step of job.steps) {
      const run = typeof step.run === 'string' ? step.run : '';
      for (const [command, runtime] of browserCommands) {
        if (!command.test(run)) {
          continue;
        }
        checked.push(`${job.file}:${job.id}:${command.source}`);
        assert.ok(
          provisioned.has(runtime),
          `${job.file} job ${job.id} step "${step.name}" runs ${command.source} before \`node ${provisioner} --install --runtime ${runtime}\``,
        );
      }
      for (const runtime of provisionedRuntimes(step)) {
        provisioned.add(runtime);
      }
    }
  }
  for (const expected of [
    'ultramodern-nightly.yml:build-consumers:\\btest:build-consumers(?![\\w:-])',
    'ut-Linux.yml:ut-linux:\\btest:build-consumers(?![\\w:-])',
    'integration-test.yml:integration:\\btest:framework(?::prepared)?(?![\\w:-])',
    'integration-test.yml:integration:\\btest:rstest-adapter(?![\\w:-])',
    'ultramodern-nightly.yml:superapp:\\bvalidate:superapp-certification(?![\\w-])',
  ]) {
    assert.ok(checked.includes(expected), `expected to check ${expected}`);
  }
});

test('no workflow installs playwright browsers outside the shared provisioner', () => {
  for (const job of workflowJobs()) {
    for (const step of job.steps) {
      const run = typeof step.run === 'string' ? step.run : '';
      assert.doesNotMatch(
        run,
        /playwright install|puppeteer.*postinstall/u,
        `${job.file} job ${job.id} step "${step.name}" provisions browsers itself; use node ${provisioner}`,
      );
    }
  }
});

test('no dependency downloads a browser as an install side effect', () => {
  const workspace = yaml.load(
    fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  for (const name of ['cypress', 'puppeteer']) {
    assert.equal(
      workspace.allowBuilds?.[name],
      false,
      `pnpm-workspace.yaml allowBuilds.${name} must be false: its postinstall downloads a browser outside node_modules, which a restored pnpm side-effects cache silently skips. Provision browsers with node ${provisioner}.`,
    );
  }
  const launchOptions = fs.readFileSync(
    path.join(repoRoot, 'tests/utils/launchOptions.js'),
    'utf8',
  );
  assert.match(
    launchOptions,
    /chromium\.executablePath\(\)/u,
    'tests/utils/launchOptions.js must launch the playwright Chromium the shared provisioner installs',
  );
});
