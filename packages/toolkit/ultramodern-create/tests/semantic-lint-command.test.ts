import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  lintSemanticWorkspace,
  semanticLintOxlintRules,
} from '../src/ultramodern-tooling/semantic-lint';
import {
  createWorkspace,
  linkInstalledCompilerPolicy,
} from './helpers/workspace-kit';

function fixture(
  run: (root: string, write: (name: string, text: string) => string) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-semantic-command-'));
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  try {
    run(root, write);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('semantic runner uses each configured project and keeps exact semantics', () => {
  fixture((root, write) => {
    for (const [directory, exact] of [
      ['exact', true],
      ['loose', false],
    ] as const) {
      write(
        `${directory}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noImplicitReturns: true,
            exactOptionalPropertyTypes: exact,
            types: [],
          },
          files: ['input.ts'],
        }),
      );
      write(
        `${directory}/input.ts`,
        'export interface Input { readonly value?: string | undefined }',
      );
    }
    const result = lintSemanticWorkspace(root, ['loose', 'exact']);
    assert.equal(result.files, 2);
    assert.equal(result.projects.length, 2);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].rule, 'redundant-optional-undefined');
    assert.match(result.diagnostics[0].file, /loose[/\\]input\.ts$/u);
    assert.equal(result.diagnostics[0].line, 1);
  });
});

test('semantic runner rejects orphan files instead of inventing compiler options', () => {
  fixture((root, write) => {
    write('input.ts', 'export interface Input { value?: string | undefined }');
    assert.throws(
      () => lintSemanticWorkspace(root, ['input.ts']),
      /no configured project.*input\.ts/u,
    );
  });
});

test('semantic runner rejects a broken project configuration', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"extends":"./missing-base.json","files":["input.ts"]}',
    );
    write('input.ts', 'export const value = 1;');
    assert.throws(
      () => lintSemanticWorkspace(root, ['input.ts']),
      /Invalid semantic lint project/u,
    );
  });
});

test('semantic runner rejects noCheck instead of silently skipping return checking', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"noCheck":true,"types":[]},"files":["input.ts"]}',
    );
    write(
      'input.ts',
      'export function missing(flag: boolean) { if (flag) return 1; }',
    );
    assert.throws(
      () => lintSemanticWorkspace(root, ['input.ts']),
      /Semantic lint requires noCheck to be disabled/u,
    );
  });
});

test('semantic runner rejects invalid compiler-option combinations', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"moduleResolution":"NodeNext","module":"Preserve","types":[]},"files":["input.ts"]}',
    );
    write('input.ts', 'export const value = 1;');
    assert.throws(
      () => lintSemanticWorkspace(root, ['input.ts']),
      /Invalid semantic lint project.*module.*NodeNext/u,
    );
  });
});

test('semantic runner leaves unrelated source type errors to the typecheck', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"files":["input.ts"]}',
    );
    write('input.ts', 'export const value: string = 1;');
    assert.deepEqual(lintSemanticWorkspace(root, ['input.ts']).diagnostics, []);
  });
});

test('semantic runner fails for empty, missing and malformed source selection', () => {
  fixture((root, write) => {
    assert.throws(() => lintSemanticWorkspace(root, []), /at least one/u);
    write('empty/.keep', '');
    assert.throws(
      () => lintSemanticWorkspace(root, ['empty']),
      /no source files/u,
    );
    assert.throws(() => lintSemanticWorkspace(root, ['absent.ts']), /ENOENT/u);
    write(
      'tsconfig.json',
      '{"files":["bad.ts"],"compilerOptions":{"types":[]}}',
    );
    write('bad.ts', 'export interface { missing name');
    assert.throws(
      () => lintSemanticWorkspace(root, ['bad.ts']),
      /Invalid semantic lint input/u,
    );
  });
});

test('workspace globs cover existing packages without requiring optional remote directories', () => {
  fixture((root, write) => {
    write(
      'apps/shell/tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"files":["input.ts"]}',
    );
    write('apps/shell/input.ts', 'export const value = 1;');
    const result = lintSemanticWorkspace(root, [
      'apps/*',
      'verticals/*',
      'packages/*',
    ]);
    assert.equal(result.files, 1);
    assert.equal(result.projects.length, 1);
    assert.deepEqual(result.diagnostics, []);
    assert.throws(
      () => lintSemanticWorkspace(root, ['verticals/*']),
      /no source files/u,
    );
  });
});

test('semantic runner checks authored output-named folders, not package artifacts', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"include":["src/**/*.ts"]}',
    );
    write(
      'src/dist/input.ts',
      'export interface Input { value?: string | undefined }',
    );
    write('dist/bundle.ts', 'not valid TypeScript');
    write('node_modules/vendor/index.ts', 'not valid TypeScript');
    const result = lintSemanticWorkspace(root, ['.']);
    assert.equal(result.files, 1);
    assert.equal(result.diagnostics.length, 1);
  });
});

test('semantic ownership transfer names only the three replaced checks', () => {
  assert.deepEqual(Object.keys(semanticLintOxlintRules).sort(), [
    'react-doctor/js-set-map-lookups',
    'sonarjs/no-inconsistent-returns',
    'sonarjs/no-redundant-optional',
  ]);
});

test('semantic array proof rejects authored declarations with library-looking filenames', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"target":"ESNext","types":[]},"files":["input.ts","lib.authored.d.ts"]}',
    );
    write(
      'lib.authored.d.ts',
      'interface Array<T> { includes(value: T): boolean; }',
    );
    write(
      'input.ts',
      'export function check(allowed: string[], candidates: string[]) { return candidates.some(value => allowed.includes(value)); }',
    );
    assert.deepEqual(lintSemanticWorkspace(root, ['input.ts']).diagnostics, []);
  });
});

test('semantic runner retains symlinked source ownership and deduplicates cycles', () => {
  fixture((root, write) => {
    write(
      'owned/tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"files":["input.ts"]}',
    );
    write(
      'owned/input.ts',
      'export interface Input { readonly value?: string | undefined }',
    );
    const target = path.join(root, 'owned');
    for (const link of [
      path.join(root, 'linked'),
      path.join(target, 'cycle'),
    ]) {
      fs.symlinkSync(
        target,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const result = lintSemanticWorkspace(root, ['linked', 'owned']);
    assert.equal(result.files, 1);
    assert.equal(result.diagnostics.length, 1);
  });
});

test('semantic runner checks authored declaration contracts without editing files', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"files":["input.d.ts"]}',
    );
    const source =
      'export interface Input { readonly value?: string | undefined }';
    const file = write('input.d.ts', source);
    const first = lintSemanticWorkspace(root, ['input.d.ts']);
    const second = lintSemanticWorkspace(root, ['input.d.ts']);
    assert.equal(first.files, 1);
    assert.equal(first.diagnostics.length, 1);
    assert.deepEqual(first, second);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  });
});

test('semantic command emits machine-readable findings and exits nonzero', () => {
  fixture((root, write) => {
    write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"noImplicitReturns":true,"types":[]},"files":["input.ts"]}',
    );
    write(
      'input.ts',
      'export interface Input { readonly value?: string | undefined }',
    );
    const require = createRequire(import.meta.url);
    const command = new URL(
      '../src/ultramodern-tooling/commands/semantic-lint.ts',
      import.meta.url,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        '--input-type=module',
        '-e',
        `import { runSemanticLint } from ${JSON.stringify(command.href)};
process.exitCode = runSemanticLint(['--json', 'input.ts'], {
  workspaceRoot: process.cwd(), invocationCwd: process.cwd(),
});`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.files, 1);
    assert.equal(report.projects.length, 1);
    assert.equal(report.diagnostics.length, 1);
    assert.equal(report.diagnostics[0].rule, 'redundant-optional-undefined');
  });
});

test('a generated shell-only workspace has real project coverage for every lint input', async () => {
  const { tempRoot, workspaceDir } = await createWorkspace('semantic-coverage');
  try {
    linkInstalledCompilerPolicy(workspaceDir);
    const require = createRequire(import.meta.url);
    const nodeTypes = path.join(workspaceDir, 'node_modules/@types/node');
    fs.mkdirSync(path.dirname(nodeTypes), { recursive: true });
    fs.symlinkSync(
      path.dirname(require.resolve('@types/node/package.json')),
      nodeTypes,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = lintSemanticWorkspace(workspaceDir, [
      'apps/*',
      'verticals/*',
      'packages/*',
    ]);
    // This proves generated project ownership, not installed dependency types.
    // Exact installed-package validation runs in release acceptance.
    assert.ok(result.files > 0);
    assert.ok(result.projects.length > 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
