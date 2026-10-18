import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from '../../packages/toolkit/utils/compiled/js-yaml/index.js';

const readWorkflow = name =>
  yaml.load(
    fs.readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );

for (const mode of ['source', 'published'])
  for (const failure of ['none', 'stage', 'proof'])
    test(`${mode} feature command preserves ${failure} result and retires only staged native archives`, t => {
      // Only the shell wiring is executed: fabricated mise commands never qualify archives or a consumer.
      assert(
        process.env.OWNED_TEMP_DIR,
        'Run filesystem controls through owned-temp-dir',
      );
      const root = fs.mkdtempSync(
        path.join(
          fs.realpathSync(process.env.OWNED_TEMP_DIR),
          'native-workflow-control-',
        ),
      );
      t.after(() => fs.rmSync(root, { recursive: true }));
      const browserExecutable = path.join(root, 'fixed-chrome');
      fs.writeFileSync(browserExecutable, '#!/bin/sh\nexit 0\n', {
        mode: 0o700,
      });
      const job =
        mode === 'source'
          ? readWorkflow('ultramodern-release-acceptance').jobs[
              'accept-release'
            ]
          : readWorkflow('publish-bleedingdev').jobs['accept-published'];
      const command = job.steps.find(step =>
        step.name.includes('installed renderer features'),
      ).run;
      const child = spawnSync(
        'bash',
        [
          '-e',
          '-o',
          'pipefail',
          '-c',
          `
        mise() {
          case "$4" in
            scripts/ultramodern-renderers/native-federation-inputs.mjs)
              mkdir "$OWNED_TEMP_DIR/native-inputs"
              printf 'staged control bytes' > "$OWNED_TEMP_DIR/native-inputs/native-inputs.json"
              if [[ "$FAILURE" == stage ]]; then return 23; fi
              ;;
            scripts/ultramodern-renderers/release.mjs)
              [[ "$*" == *"--native-inputs $OWNED_TEMP_DIR/native-inputs/native-inputs.json"* ]]
              [[ "$*" == *"--browser-executable $RENDERER_BROWSER_EXECUTABLE"* ]]
              test -f "$OWNED_TEMP_DIR/native-inputs/native-inputs.json"
              printf 'proof invoked' > "$OWNED_TEMP_DIR/proof-evidence.log"
              if [[ "$FAILURE" == proof ]]; then return 31; fi
              ;;
            *) return 90 ;;
          esac
        }
        ${command}
      `,
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            FAILURE: failure,
            BLEEDINGDEV_RELEASE_MANIFEST: '/control/manifest.json',
            BLEEDINGDEV_RELEASE_DIR: '/control',
            PRODUCER_RUN_IDENTITY: 'control-run',
            RENDERER_BROWSER_EXECUTABLE: browserExecutable,
          },
          encoding: 'utf8',
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(
        child.status,
        failure === 'stage' ? 23 : failure === 'proof' ? 31 : 0,
        child.stderr,
      );
      const featureRoot = path.join(
        root,
        fs
          .readdirSync(root)
          .find(name => name.startsWith('renderer-features-')),
      );
      assert.equal(
        fs.existsSync(path.join(featureRoot, 'native-inputs')),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(featureRoot, 'proof-evidence.log')),
        failure !== 'stage',
      );
    });

for (const mode of ['source', 'published'])
  test(`${mode} installed feature command consumes the fixed browser provisioner's exact output`, () => {
    const job =
      mode === 'source'
        ? readWorkflow('ultramodern-release-acceptance').jobs['accept-release']
        : readWorkflow('publish-bleedingdev').jobs['accept-published'];
    const install = job.steps.findIndex(
      step => step.id === 'renderer-fixed-browser',
    );
    const proof = job.steps.findIndex(step =>
      step.name.includes('installed renderer features'),
    );
    assert(
      install >= 0 && install < proof,
      'Fixed Chrome must be installed before renderer acceptance',
    );
    assert.match(
      job.steps[install].run,
      /node scripts\/ultramodern-renderers\/provision-browser\.mjs/u,
    );
    assert.equal(
      job.steps[proof].env.RENDERER_BROWSER_EXECUTABLE,
      '${{ steps.renderer-fixed-browser.outputs.executable_path }}',
    );
    assert.match(
      job.steps[proof].run,
      /--browser-executable "\$RENDERER_BROWSER_EXECUTABLE"/u,
    );
    if (mode === 'source')
      assert.equal(job.steps[install].if, job.steps[proof].if);
    const missing = spawnSync(
      'bash',
      [
        '-e',
        '-o',
        'pipefail',
        '-c',
        `
      mktemp() { return 96; }
      mise() { return 97; }
      ${job.steps[proof].run}
    `,
      ],
      {
        env: { ...process.env, RENDERER_BROWSER_EXECUTABLE: '' },
        encoding: 'utf8',
      },
    );
    assert.equal(missing.error, undefined);
    assert.equal(
      missing.status,
      1,
      'Empty browser output must fail before work or fallback',
    );
  });
