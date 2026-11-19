import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { qualifyOtel } from '../ultramodern-dependencies/otel-corrections/portable.mjs';
import { qualifyPeerCorrections } from '../ultramodern-dependencies/test-peer-corrections/qualify.mjs';
import { qualifyDtsPlugin } from './dts-plugin.mjs';

const sentinels = {
  GH_TOKEN: 'boundary-test-only',
  GITHUB_TOKEN: 'boundary-test-only',
  NPM_TOKEN: 'boundary-test-only',
  npm_config_ignore_scripts: 'true',
  npm_config_strict_peer_dependencies: 'false',
  NODE_OPTIONS: '--no-warnings',
  NODE_PATH: '/untrusted-modules',
  SUPPORT_SKIP_GATES: 'true',
};

for (const name of ['metadata3', 'OTel', 'DTS']) {
  test(`${name} actual qualification child rejects ambient credentials and policy`, async t => {
    const parent = fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'support-env-'),
    );
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const workDirectory = path.join(parent, 'work');
    const storeDirectory = path.join(parent, 'store');
    const saved = Object.fromEntries(
      Object.keys(sentinels).map(key => [key, process.env[key]]),
    );
    const stop = new Error('stopped after real child environment observation');
    let observed;
    const inspect = options => {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(sentinels))}.map(key => [key, process.env[key] ?? null]))))`,
        ],
        { cwd: options.cwd, env: options.env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      observed = JSON.parse(result.stdout);
      throw stop;
    };
    try {
      Object.assign(process.env, sentinels);
      let qualification;
      if (name === 'metadata3') {
        fs.mkdirSync(workDirectory);
        qualification = qualifyPeerCorrections({
          workDirectory,
          toolchain: { storeDirectory, run: inspect },
          log() {},
        });
      } else if (name === 'OTel') {
        qualification = qualifyOtel({
          workDirectory,
          toolchain: { storeDirectory },
          run: (_command, _args, options) => inspect(options),
          log() {},
        });
      } else {
        qualification = qualifyDtsPlugin({
          workDirectory,
          toolchain: { storeDirectory },
          run: (_command, _args, options) => inspect(options),
          log() {},
        });
      }
      await assert.rejects(qualification, error => error === stop);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    assert.deepEqual(
      observed,
      Object.fromEntries(Object.keys(sentinels).map(key => [key, null])),
    );
  });
}
