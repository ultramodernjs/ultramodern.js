import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportCloudflareOutputChecks } from '../src/ultramodern-tooling/commands/cloudflare-output-checks';

// A stand-in verifier. Each check records itself, waits until a second check
// has started (at most 10 s), sleeps its own delay, prints one line and then
// passes, fails, throws or passes and throws afterwards as its output
// directory's fixture.json says.
const fakeVerifierSource = `const fs = require('node:fs');
const path = require('node:path');
const started = path.join(__dirname, 'started');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.verifyCloudflareOutput = async ({ outputDirectory, importWorker }) => {
  const { app, delayMs, verdict } = JSON.parse(
    fs.readFileSync(path.join(outputDirectory, 'fixture.json'), 'utf8'),
  );
  fs.mkdirSync(started, { recursive: true });
  fs.writeFileSync(path.join(started, app), String(importWorker));
  const deadline = Date.now() + 10_000;
  while (fs.readdirSync(started).length < 2 && Date.now() < deadline) {
    await sleep(10);
  }
  const company = fs.readdirSync(started).length >= 2 ? 'beside another check' : 'alone';
  await sleep(delayMs);
  console.log('checked ' + app + ' ' + company);
  if (verdict === 'throw') {
    throw new Error(app + ' manifest is not JSON');
  }
  if (verdict === 'late-throw') {
    setTimeout(() => {
      throw new Error(app + ' late failure');
    }, 0);
  }
  return verdict === 'pass' || verdict === 'late-throw'
    ? { ok: true, issues: [] }
    : {
        ok: false,
        issues: [{ code: 'missing-file', message: 'Cloudflare output is missing wrangler.json.', path: 'wrangler.json' }],
      };
};
`;

const withTargets = async (
  fixtures: Array<{ app: string; delayMs: number; verdict: string }>,
  run: (
    verifierPath: string,
    targets: Array<{ label: string; outputDirectory: string }>,
    started: () => Record<string, string>,
  ) => Promise<void>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-cloudflare-checks-'));
  try {
    const verifierPath = path.join(root, 'verifier/index.cjs');
    fs.mkdirSync(path.dirname(verifierPath));
    fs.writeFileSync(verifierPath, fakeVerifierSource);
    const targets = fixtures.map(fixture => {
      const outputDirectory = path.join(root, fixture.app, '.output');
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(outputDirectory, 'fixture.json'),
        JSON.stringify(fixture),
      );
      return { label: fixture.app, outputDirectory };
    });
    const startedDir = path.join(root, 'verifier/started');
    const started = () =>
      Object.fromEntries(
        fs
          .readdirSync(startedDir)
          .map(app => [
            app,
            fs.readFileSync(path.join(startedDir, app), 'utf8'),
          ]),
      );
    await run(verifierPath, targets, started);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

// stdout, stderr and both console channels in the order they were written.
const captureOutput = () => {
  const lines: string[] = [];
  const capture = (chunk: unknown) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  rstest.spyOn(process.stdout, 'write').mockImplementation(capture);
  rstest.spyOn(process.stderr, 'write').mockImplementation(capture);
  rstest.spyOn(console, 'log').mockImplementation(capture);
  rstest.spyOn(console, 'error').mockImplementation(capture);
  return lines;
};

afterEach(() => {
  rstest.restoreAllMocks();
});

test('checks every target side by side and reports each in target order', () =>
  withTargets(
    [
      // The first target finishes last; the middle one fails.
      { app: 'shell-super-app', delayMs: 300, verdict: 'pass' },
      { app: 'inventory', delayMs: 0, verdict: 'fail' },
      { app: 'finance', delayMs: 0, verdict: 'pass' },
    ],
    async (verifierPath, targets, started) => {
      const lines = captureOutput();
      const failed = await reportCloudflareOutputChecks(verifierPath, targets);
      rstest.restoreAllMocks();

      expect(failed).toBe(true);
      expect(lines).toEqual([
        'checked shell-super-app beside another check',
        '[ultramodern] Cloudflare output verified: shell-super-app',
        'checked inventory beside another check',
        '[ultramodern] Cloudflare output failed: inventory',
        '- missing-file: Cloudflare output is missing wrangler.json. (wrangler.json)',
        'checked finance beside another check',
        '[ultramodern] Cloudflare output verified: finance',
      ]);
      // Every target was checked, each with its worker import.
      expect(started()).toEqual({
        'shell-super-app': 'true',
        inventory: 'true',
        finance: 'true',
      });
    },
  ));

test('a check that throws fails after the targets before it are reported', () =>
  withTargets(
    [
      { app: 'shell-super-app', delayMs: 300, verdict: 'pass' },
      { app: 'inventory', delayMs: 0, verdict: 'throw' },
      { app: 'finance', delayMs: 0, verdict: 'pass' },
    ],
    async (verifierPath, targets, started) => {
      const lines = captureOutput();
      const outcome = await reportCloudflareOutputChecks(
        verifierPath,
        targets,
      ).then(String, (error: Error) => error.message);
      rstest.restoreAllMocks();

      expect(outcome).toBe('inventory manifest is not JSON');
      expect(lines).toEqual([
        'checked shell-super-app beside another check',
        '[ultramodern] Cloudflare output verified: shell-super-app',
        'checked inventory beside another check',
      ]);
      expect(Object.keys(started()).sort()).toEqual([
        'finance',
        'inventory',
        'shell-super-app',
      ]);
    },
  ));

test('a check that fails after it passed still fails the command', () =>
  withTargets(
    [
      { app: 'shell-super-app', delayMs: 300, verdict: 'pass' },
      { app: 'inventory', delayMs: 0, verdict: 'late-throw' },
      { app: 'finance', delayMs: 0, verdict: 'pass' },
    ],
    async (verifierPath, targets, started) => {
      const lines = captureOutput();
      const outcome = await reportCloudflareOutputChecks(
        verifierPath,
        targets,
      ).then(String, (error: Error) => error.message);
      rstest.restoreAllMocks();

      expect(outcome).toBe('inventory late failure');
      expect(lines).toEqual([
        'checked shell-super-app beside another check',
        '[ultramodern] Cloudflare output verified: shell-super-app',
        'checked inventory beside another check',
      ]);
      expect(Object.keys(started()).sort()).toEqual([
        'finance',
        'inventory',
        'shell-super-app',
      ]);
    },
  ));
