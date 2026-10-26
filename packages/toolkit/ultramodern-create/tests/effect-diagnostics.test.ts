import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';
import { createTsConfigBase } from '../src/ultramodern-workspace/tsconfigs';
import { linkInstalledEffectCompiler } from './helpers/workspace-kit';

const require = createRequire(import.meta.url);
const effectRequire = createRequire(
  path.resolve(__dirname, '../../../server/bff-effect/package.json'),
);

const fixtures = [
  {
    name: 'supports HTTP/RPC with visible stability notices',
    source: `import { HttpServerResponse } from "effect/http";
import { Rpc } from "effect/rpc";
export const response = HttpServerResponse.text("ready");
export const ping = Rpc.make("Ping");
`,
    status: 0,
    code: 'TS377136',
  },
  {
    name: 'rejects ordinary type errors',
    source: 'export const value: string = 123;\n',
    status: 1,
    code: 'TS2322',
  },
  {
    name: 'rejects floating Effects',
    source: `import * as Effect from "effect/Effect";
Effect.log("forgotten");
`,
    status: 1,
    code: 'TS377001',
  },
  {
    name: 'rejects experimental API usage',
    // Effect 4 has no experimental export. This authored annotation exercises
    // the native rule's public contract, as its own compiler fixtures do.
    source: `import * as Effect from "effect/Effect";
/** @stability experimental */
export const previewApi = () => 1;
export const preview = previewApi();
export const effect = Effect.succeed(1);
`,
    status: 1,
    code: 'TS377135',
  },
] as const;

test.each(
  fixtures.flatMap(fixture =>
    ['project', 'build'].map(mode => ({
      ...fixture,
      mode,
      status: fixture.status,
    })),
  ),
)(
  'installed native Effect policy $name in $mode mode',
  ({ source, status, code, mode }) => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'um-effect-diagnostics-')),
    );
    try {
      linkInstalledEffectCompiler(root);
      for (const [name, provider] of [
        ['effect', effectRequire],
        ['@types/node', require],
      ] as const) {
        const destination = path.join(root, 'node_modules', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(
          path.dirname(provider.resolve(`${name}/package.json`)),
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      expect(
        JSON.parse(
          fs.readFileSync(effectRequire.resolve('effect/package.json'), 'utf8'),
        ).version,
      ).toBe('4.0.5');
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify(createTsConfigBase()),
      );
      const input = path.join(root, 'fixture.ts');
      fs.writeFileSync(input, source);
      const consumer = createRequire(path.join(root, 'package.json'));
      const installedPolicy = consumer.resolve(
        '@modern-js/ultramodern-create/tsconfig',
      );
      expect(
        JSON.parse(fs.readFileSync(installedPolicy, 'utf8')).compilerOptions
          .plugins[0].diagnosticSeverity.unstableApiUsage,
      ).toBe('message');

      const checked = spawnSync(
        resolveEffectTsgoCompiler({ from: input }),
        [
          mode === 'build' ? '--build' : '--project',
          'tsconfig.json',
          '--pretty',
          'false',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            TSRS_CHECKER_ASSIGNMENT:
              process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
          },
        },
      );
      const output = checked.stdout + checked.stderr;
      expect(checked.error).toBeUndefined();
      expect(checked.status).toBe(status);
      expect([...new Set(output.match(/\bTS\d+\b/g))]).toEqual([code]);
      if (status === 0) {
        expect(output).toContain('message TS377136');
      } else {
        expect(output).toContain(`error ${code}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

const installedPackage = (owner: string, name: string) =>
  fs.realpathSync(path.join(owner, 'node_modules', name));

// The browser guard architecture validation requires around Module Federation
// instance loads in shell routes must also pass the generated strict policy.
test.each([
  {
    guard: 'import.meta.env.MODERN_TARGET',
    status: 0,
    codes: [] as string[],
  },
  {
    guard: 'process.env.MODERN_TARGET',
    status: 1,
    codes: ['TS377076'],
  },
])(
  'generated React shell type checking for the $guard browser guard',
  ({ guard, status, codes }) => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'um-shell-build-target-')),
    );
    const createDir = path.resolve(__dirname, '..');
    const repoRoot = path.resolve(createDir, '../../..');
    try {
      linkInstalledEffectCompiler(root);
      for (const [owner, name] of [
        [createDir, '@types/node'],
        [createDir, '@modern-js/ultramodern-app-tools'],
        [createDir, '@modern-js/app-tools'],
        [createDir, '@module-federation/modern-js-v3'],
        [repoRoot, '@types/react'],
        [repoRoot, '@types/react-dom'],
      ] as const) {
        const destination = path.join(root, 'node_modules', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(
          installedPackage(owner, name),
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify(createTsConfigBase()),
      );
      // The React app environment declaration the generator writes.
      fs.writeFileSync(
        path.join(root, 'modern-app-env.d.ts'),
        '/// <reference types="@modern-js/ultramodern-app-tools/react-types" />\n',
      );
      fs.writeFileSync(
        path.join(root, 'page.tsx'),
        `import { getInstance } from '@module-federation/modern-js-v3/runtime';
export const load = () => {
  if (${guard} === 'browser') {
    const host = getInstance();
    if (host !== null) return host.loadRemote('inventory/Widget');
  }
  return undefined;
};
`,
      );
      const checked = spawnSync(
        resolveEffectTsgoCompiler({ from: path.join(root, 'page.tsx') }),
        ['--project', 'tsconfig.json', '--pretty', 'false'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            TSRS_CHECKER_ASSIGNMENT:
              process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
          },
        },
      );
      const output = checked.stdout + checked.stderr;
      expect(checked.error).toBeUndefined();
      expect([...new Set(output.match(/\bTS\d+\b/g))]).toEqual(codes);
      expect(checked.status).toBe(status);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
