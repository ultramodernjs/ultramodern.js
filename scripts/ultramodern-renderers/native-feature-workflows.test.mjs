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

test('failed Tractor acceptance preserves bounded compiler inputs without claiming acceptance', () => {
  const steps = readWorkflow('ultramodern-tractor-downstream').jobs[
    'tractor-downstream'
  ].steps;
  const run = steps.findIndex(step => step.id === 'tractor-acceptance');
  const preserve = steps.findIndex(
    step => step.name === 'Preserve failed Tractor compiler inputs',
  );
  assert.ok(run >= 0 && preserve > run);
  assert.equal(steps[run]['continue-on-error'], undefined);
  assert.equal(
    steps[preserve].if,
    "failure() && steps.tractor-acceptance.outcome == 'failure'",
  );
  assert.match(steps[preserve].with.name, /^tractor-compiler-failure-run-/u);
  assert.equal(steps[preserve].with['include-hidden-files'], true);
  assert.equal(steps[preserve].with['retention-days'], 3);
  assert.match(
    steps[preserve].with.path,
    /shared-contracts\/src\/\*\*\/\*\.ts/u,
  );
  assert.match(steps[preserve].with.path, /\.cache\/tsgo\/\*\*\/\*\.d\.ts/u);
  assert.match(steps[preserve].with.path, /verticals\/\*\/\.modern-js\/tsgo/u);
  assert.doesNotMatch(steps[preserve].with.path, /\.env|tractor\/\*\*/u);
  assert.ok(!steps[preserve].with.name.includes('acceptance-'));
});

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
      const browserCli = path.join(root, 'agent-browser');
      fs.writeFileSync(browserCli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
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
            RENDERER_AGENT_BROWSER_EXECUTABLE: browserCli,
            PATH: `${root}${path.delimiter}${process.env.PATH}`,
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

for (const mode of ['source', 'published'])
  test(`${mode} installed features require their pinned job-owned native browser CLI`, () => {
    const job =
      mode === 'source'
        ? readWorkflow('ultramodern-release-acceptance').jobs['accept-release']
        : readWorkflow('publish-bleedingdev').jobs['accept-published'];
    const install = job.steps.findIndex(
      step => step.id === 'renderer-browser-cli',
    );
    const proof = job.steps.findIndex(step =>
      step.name.includes('installed renderer features'),
    );
    assert(install >= 0 && install < proof);
    assert.equal(
      job.steps[install].run,
      'mise exec -- node scripts/ultramodern-renderers/provision-agent-browser.mjs',
    );
    assert.equal(
      job.steps[proof].env.RENDERER_AGENT_BROWSER_EXECUTABLE,
      '${{ steps.renderer-browser-cli.outputs.executable_path }}',
    );
    assert.match(
      job.steps[proof].run,
      /test -x "\$RENDERER_AGENT_BROWSER_EXECUTABLE"/u,
    );
    assert.match(
      job.steps[proof].run,
      /test "\$\(command -v agent-browser\)" = "\$RENDERER_AGENT_BROWSER_EXECUTABLE"/u,
    );
    if (mode === 'source')
      assert.equal(job.steps[install].if, job.steps[proof].if);
  });

test('renderer CLI provisioning verifies the qualified native release before execution', () => {
  const script = fs.readFileSync(
    new URL('./provision-agent-browser.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /const version = '0\.39\.1'/u);
  assert.match(
    script,
    /6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc/u,
  );
  assert.match(
    script,
    /https:\/\/github\.com\/vercel-labs\/agent-browser\/releases\/download\/v\$\{version\}\/agent-browser-linux-x64/u,
  );
  const verify = script.indexOf("createHash('sha256')");
  const execute = script.indexOf('execFileSync(executable');
  const expose = script.indexOf('fs.appendFileSync(process.env.GITHUB_PATH');
  assert(verify > 0 && verify < execute && execute < expose);
  assert.match(
    script,
    /fs\.rmSync\(directory, \{ recursive: true, force: true \}\)/u,
  );
});

const expression = value => '$' + '{{ ' + value + ' }}';
const depotLinux = expression(
  "vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8'",
);
const isolatedDepotLinux = expression(
  "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || vars.DEPOT_LINUX_RUNNER || 'depot-ubuntu-24.04-8'",
);

test('acceptance uses Depot by default while external pull requests stay GitHub-hosted', () => {
  for (const [workflow, job] of [
    ['ultramodern-release-acceptance', 'accept-release'],
    ['ultramodern-tractor-downstream', 'tractor-downstream'],
    ['native-compatibility', 'native-compatibility'],
  ])
    assert.equal(
      readWorkflow(workflow).jobs[job]['runs-on'],
      isolatedDepotLinux,
    );
  assert.equal(
    readWorkflow('publish-bleedingdev').jobs['accept-published']['runs-on'],
    depotLinux,
  );
});

test('npm trusted-publisher jobs retain GitHub-hosted OIDC publication', () => {
  const jobs = readWorkflow('publish-bleedingdev').jobs;
  for (const name of ['publish-sidecars', 'publish']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-24.04');
    assert.equal(jobs[name].permissions['id-token'], 'write');
  }
});
