import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { renderMiseBootstrap } from '../src/ultramodern-workspace/mise-bootstrap';

const fixture = Buffer.from('portable fixture executable');
const digest = createHash('sha256').update(fixture).digest('hex');

for (const scenario of [
  'success-x64',
  'success-arm64',
  'http',
  'short',
  'oversized',
  'hash',
  'version',
  'execution',
  'network',
  'interrupt',
  'interrupt-chmod',
  'symlink',
  'darwin',
  'unsupported-arch',
]) {
  test(`authenticated mise bootstrap: ${scenario}`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'um-mise-bootstrap-'));
    const bin = path.join(home, '.local/bin');
    const target = path.join(bin, 'mise');
    const previous = Buffer.from('existing mise must survive');
    const executions: string[] = [];
    const downloads: string[] = [];
    const errors: unknown[] = [];
    const platform = scenario === 'darwin' ? 'darwin' : 'linux';
    const arch =
      scenario === 'unsupported-arch'
        ? 'ia32'
        : scenario === 'success-arm64'
          ? 'arm64'
          : 'x64';
    const state = Object.assign(new EventEmitter(), {
      platform,
      arch,
      env: { HOME: home },
      exitCode: 0,
    });
    try {
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(target, previous);
      if (scenario === 'symlink') {
        await fs.rename(target, path.join(home, 'original'));
        await fs.symlink(path.join(home, 'original'), target);
      }
      const source = renderMiseBootstrap()
        .split('\n')
        .slice(1, -1)
        .join('\n')
        .replaceAll(/size: \d+/gu, `size: ${fixture.length}`)
        .replaceAll(/sha256: '[a-f0-9]+'/gu, `sha256: '${digest}'`);
      await vm.runInNewContext(source, {
        require(name: string) {
          if (name === 'node:fs/promises')
            return {
              ...fs,
              async chmod(file: string, mode: number) {
                await fs.chmod(file, mode);
                if (scenario === 'interrupt-chmod') state.emit('SIGTERM');
              },
            };
          if (name === 'node:path') return path;
          if (name === 'node:crypto') return { createHash };
          if (name === 'node:child_process')
            return {
              execFileSync(file: string, args: string[]) {
                // Intercept execution: never run a Linux binary on the test host.
                assert.deepEqual(Array.from(args), ['--version']);
                executions.push(file);
                if (scenario === 'execution')
                  throw new Error('fixture exec failure');
                return scenario === 'version'
                  ? '2026.11.7'
                  : '2026.11.8 linux-x64';
              },
            };
          throw new Error(`Unexpected import: ${name}`);
        },
        process: state,
        AbortSignal,
        AbortController,
        console: { error: (error: unknown) => errors.push(error) },
        async fetch(url: string) {
          downloads.push(url);
          if (scenario === 'interrupt') state.emit('SIGTERM');
          if (scenario === 'network')
            throw new Error('fixture network failure');
          const body =
            scenario === 'short'
              ? fixture.subarray(1)
              : scenario === 'oversized'
                ? Buffer.concat([fixture, fixture])
                : scenario === 'hash'
                  ? Buffer.alloc(fixture.length)
                  : fixture;
          return {
            ok: scenario !== 'http',
            status: scenario === 'http' ? 404 : 200,
            body: (async function* () {
              yield body.subarray(0, 5);
              yield body.subarray(5);
            })(),
          };
        },
      });
      const success = scenario.startsWith('success');
      assert.equal(state.exitCode, success ? 0 : 1);
      assert.equal(errors.length, success ? 0 : 1);
      assert.deepEqual(await fs.readFile(target), success ? fixture : previous);
      assert.deepEqual(await fs.readdir(bin), ['mise']);
      assert.equal(
        executions.length,
        success || scenario === 'version' || scenario === 'execution' ? 1 : 0,
      );
      assert.equal(
        downloads.length,
        ['symlink', 'darwin', 'unsupported-arch'].includes(scenario) ? 0 : 1,
      );
      if (downloads.length)
        assert.equal(
          downloads[0],
          `https://github.com/jdx/mise/releases/download/v2026.11.8/mise-v2026.11.8-linux-${arch}`,
        );
      if (success && process.platform !== 'win32')
        assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
      if (scenario === 'symlink')
        assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}

test('mise bootstrap retains exact official release authentication pins', () => {
  const script = renderMiseBootstrap();
  assert.match(
    script,
    /size: 180897216, sha256: '32b6abe844efa43d37d7ac4ed21d2ec41e9479d66feb19b0db8d2c548cd6e36d'/u,
  );
  assert.match(
    script,
    /size: 157476520, sha256: '0de1450dcc3f838e372e05e8c5231423760ad3f22d14275ef340bc0a250303ce'/u,
  );
  assert.doesNotMatch(script, /mise\.run|curl/u);
});
