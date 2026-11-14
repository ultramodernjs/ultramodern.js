import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import provider from '../tsrs-dts/compiler.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packages = [
  'check-changeset',
  'lint-package-json',
  'release-note',
  'release-version',
];

for (const name of packages) {
  const cwd = join(root, 'scripts', name);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

  test(`${name} compiles its real source without emitting`, () => {
    const [command, ...args] = manifest.scripts.build.split(/\s+/u);
    const result = spawnSync(
      command === 'node' ? process.execPath : command,
      [...args, '--noEmit'],
      { cwd, encoding: 'utf8', timeout: 30000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  for (const script of ['build', 'dev']) {
    test(`${name} ${script} executes the Effect compiler without emitting`, () => {
      const [command, ...args] = manifest.scripts[script].split(/\s+/u);
      const result = spawnSync(
        command === 'node' ? process.execPath : command,
        [...args, '--version'],
        {
          cwd,
          encoding: 'utf8',
          timeout: 5000,
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
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.includes(`+effect-tsgo.${provider.effectVersion}`),
      );
      if (provider.getCompilerPolicy().backend === 'tsrs') {
        assert.ok(result.stdout.includes(`tsrs ${provider.tsrsVersion}`));
      }
    });
  }
}
