import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeFile } from '../src/ultramodern-workspace/fs-io';

const require = createRequire(import.meta.url);

type FormatterAudit = {
  kind: 'formatter' | 'worker';
  pid: number;
  args?: string[];
  configSource?: string;
};

for (const mode of ['workspace', 'stdin'] as const) {
  test(`${mode} formatting bounds native external workers and preserves formatted bytes`, () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'um-formatter workers-'),
    );
    const auditPath = path.join(root, 'audit.jsonl');
    const preloadPath = path.join(root, 'audit.cjs');
    const runnerPath = path.join(root, 'run.mjs');
    const markdownPath = path.join(root, 'nested', 'README.md');
    // Each source sorts Tailwind classes through Oxfmt's external worker
    // pool; Markdown, including stdin Markdown, is formatted natively.
    const sourcePaths = ['view.tsx', 'panel.tsx'].map(name =>
      path.join(root, name),
    );
    const markdown =
      '# Title\n\nThis is a paragraph with enough words to exercise the nested native Markdown formatting override.\n\n-   one\n-   two\n';
    const source =
      'export const View=()=> <div className="p-2 flex">Hello</div>\n';
    const readAudit = () =>
      fs
        .readFileSync(auditPath, 'utf-8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as FormatterAudit);
    // Oxfmt runs its external formatter pool as Tinypool worker threads
    // inside the formatter process. The pool starts one worker on the first
    // external request and grows on concurrent demand up to --threads, so
    // only the configured cap and the presence of demand are deterministic.
    const assertWorkers = (
      audit: FormatterAudit[],
      threads: number,
      externalDemand: boolean,
    ) => {
      const formatters = audit.filter(record => record.kind === 'formatter');
      assert.equal(formatters.length, 1);
      const [formatter] = formatters;
      assert.equal(
        formatter
          .args!.filter(argument => argument.startsWith('--threads='))
          .join(' '),
        `--threads=${threads}`,
      );
      const workers = audit.filter(record => record.kind === 'worker');
      assert.ok(workers.every(record => record.pid === formatter.pid));
      if (externalDemand) {
        assert.ok(
          workers.length >= 1 && workers.length <= threads,
          `expected 1..${threads} external workers, saw ${workers.length}`,
        );
      } else {
        assert.equal(workers.length, 0);
      }
      return formatter;
    };

    try {
      fs.mkdirSync(path.dirname(markdownPath));
      fs.writeFileSync(markdownPath, markdown);
      for (const sourcePath of sourcePaths)
        fs.writeFileSync(sourcePath, source);
      fs.writeFileSync(
        path.join(root, 'nested', '.oxfmtrc.json'),
        JSON.stringify({ proseWrap: 'always', printWidth: 30 }),
      );
      fs.writeFileSync(
        preloadPath,
        `const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, workerData } = require('node:worker_threads');
const script = path.basename(process.argv[1] || '');
const tinypoolWorker = !isMainThread && Array.isArray(workerData) && Number.isInteger(workerData[0]?.workerId);
if ((isMainThread && script === 'oxfmt') || tinypoolWorker) {
  const args = process.argv.slice(1);
  const configIndex = args.indexOf('--config');
  fs.appendFileSync(process.env.UM_FORMATTER_AUDIT, JSON.stringify({
    kind: tinypoolWorker ? 'worker' : 'formatter',
    pid: process.pid,
    args,
    configSource: tinypoolWorker || configIndex < 0 ? undefined : fs.readFileSync(args[configIndex + 1], 'utf-8'),
  }) + '\\n');
}
`,
      );
      const helperUrl = pathToFileURL(
        path.resolve(__dirname, '../src/ultramodern-workspace/fs-io.ts'),
      ).href;
      fs.writeFileSync(
        runnerPath,
        `import fs from 'node:fs';
import { formatGeneratedSourceCandidates, formatGeneratedWorkspaceFiles } from ${JSON.stringify(helperUrl)};
const root = ${JSON.stringify(root)};
if (${JSON.stringify(mode)} === 'stdin') {
  const [formatted] = formatGeneratedSourceCandidates([['nested/README.md', ${JSON.stringify(markdown)}]], root);
  fs.writeFileSync(${JSON.stringify(markdownPath)}, formatted);
} else {
  formatGeneratedWorkspaceFiles(root, ['nested/README.md', 'view.tsx', 'panel.tsx']);
}
`,
      );
      const env = {
        ...process.env,
        UM_FORMATTER_AUDIT: auditPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preloadPath).href}`,
      };
      const generated = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(require.resolve('tsx/esm')).href,
          runnerPath,
        ],
        { cwd: root, encoding: 'utf-8', env },
      );
      assert.equal(generated.status, 0, generated.stderr);
      const formatter = assertWorkers(readAudit(), 1, mode === 'workspace');
      const formattedMarkdown = fs.readFileSync(markdownPath, 'utf-8');
      const formattedSources = sourcePaths.map(sourcePath =>
        fs.readFileSync(sourcePath, 'utf-8'),
      );
      assert.notEqual(formattedMarkdown, markdown);

      fs.writeFileSync(auditPath, '');
      fs.writeFileSync(markdownPath, markdown);
      for (const sourcePath of sourcePaths)
        fs.writeFileSync(sourcePath, source);
      const controlArgs = formatter.args!.filter(
        argument => !argument.startsWith('--threads='),
      );
      controlArgs.push('--threads=2');
      const configIndex = controlArgs.indexOf('--config');
      if (configIndex >= 0) {
        const configPath = controlArgs[configIndex + 1]!;
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, formatter.configSource!);
      }
      const control = spawnSync(process.execPath, controlArgs, {
        cwd: root,
        encoding: 'utf-8',
        env,
        ...(mode === 'stdin' ? { input: markdown } : {}),
      });
      assert.equal(control.status, 0, control.stderr);
      assertWorkers(readAudit(), 2, mode === 'workspace');
      assert.equal(
        mode === 'stdin'
          ? control.stdout
          : fs.readFileSync(markdownPath, 'utf-8'),
        formattedMarkdown,
      );
      assert.deepEqual(
        sourcePaths.map(sourcePath => fs.readFileSync(sourcePath, 'utf-8')),
        formattedSources,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('writeFile refuses symlinked directories that escape the workspace root', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-fs-io-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const outsideRoot = path.join(tempRoot, 'outside');
  const escapedFile = path.join(outsideRoot, 'escaped.txt');

  try {
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(outsideRoot);
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'apps'), 'dir');

    assert.throws(
      () => writeFile(workspaceRoot, 'apps/escaped.txt', 'escaped\n'),
      /outside workspace root|symlink/i,
    );
    assert.equal(fs.existsSync(escapedFile), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
