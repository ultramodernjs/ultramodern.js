import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import provider from '../tsrs-dts/compiler.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const projects = [
  {
    directory: 'scripts/prebundle',
    scripts: ['build', 'dev'],
    checkScript: 'build',
  },
  {
    directory: 'scripts/check-doc-bundle',
    scripts: ['build', 'dev'],
    checkScript: 'build',
  },
  {
    directory: 'packages/toolkit/ultramodern-create',
    scripts: ['type-check'],
    checkScript: 'type-check',
  },
  {
    directory: 'packages/toolkit/mcp-apps',
    scripts: ['typecheck'],
    checkScript: 'typecheck',
  },
];

for (const { directory, scripts, checkScript } of projects) {
  const cwd = join(root, directory);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

  function runScript(script, extraArgs, timeout) {
    const [command, ...args] = manifest.scripts[script].split(/\s+/u);
    const result = spawnSync(
      command === 'node' ? process.execPath : command,
      [...args, ...extraArgs],
      {
        cwd,
        encoding: 'utf8',
        timeout,
        env: {
          ...process.env,
          PATH: [
            join(cwd, 'node_modules', '.bin'),
            join(root, 'node_modules', '.bin'),
            process.env.PATH,
          ].join(delimiter),
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }

  for (const script of scripts) {
    test(`${directory} ${script} executes the Effect compiler`, () => {
      const args = manifest.scripts[script].split(/\s+/u);
      assert.equal(args[2], '--project');
      assert.equal(args.includes('--watch'), script === 'dev');
      if (directory.startsWith('packages/')) {
        assert.ok(args.includes('--noEmit'));
      }
      const output = runScript(script, ['--version'], 5000);
      assert.ok(output.includes(`+effect-tsgo.${provider.effectVersion}`));
      if (provider.getCompilerPolicy().backend === 'tsrs') {
        assert.ok(output.includes(`tsrs ${provider.tsrsVersion}`));
      }
    });
  }

  test(`${directory} ${checkScript} checks its real project without emitting`, () => {
    runScript(checkScript, ['--noEmit'], 120000);
  });
}
