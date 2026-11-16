import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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
              'renderer-features'
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
            RENDERER_FEATURE_ROWS: path.join(root, 'rows', 'rows.json'),
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
      // The source lane owns a fixed root so a second job can reconstruct it;
      // the published lane still mktemps one.
      const featureRoot = path.join(
        root,
        mode === 'source'
          ? 'renderer-features'
          : fs
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
        ? readWorkflow('ultramodern-release-acceptance').jobs[
            'renderer-features'
          ]
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
      mkdir() { return 96; }
      realpath() { return 96; }
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
        ? readWorkflow('ultramodern-release-acceptance').jobs[
            'renderer-features'
          ]
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
test('every acceptance leg selects the one Depot Linux runner', () => {
  // All three acceptance legs select the same runner class, byte for byte: the
  // sealed receipt verifies evidence digests against absolute RUNNER_TEMP
  // paths, which only agree when both legs run the same image. The former
  // `&& 'ubuntu-latest' ||` fork-isolation prefix is gone with it, so an
  // external pull request can no longer move one leg to other hardware.
  for (const [workflow, job] of [
    ['ultramodern-release-acceptance', 'accept-release'],
    ['ultramodern-release-acceptance', 'renderer-features'],
    ['ultramodern-release-acceptance', 'seal'],
    ['ultramodern-tractor-downstream', 'tractor-downstream'],
    ['native-compatibility', 'native-compatibility'],
    ['publish-bleedingdev', 'accept-published'],
  ])
    assert.equal(
      readWorkflow(workflow).jobs[job]['runs-on'],
      depotLinux,
      `${workflow}:${job}`,
    );
});

test('npm trusted-publisher jobs retain GitHub-hosted OIDC publication', () => {
  const jobs = readWorkflow('publish-bleedingdev').jobs;
  for (const name of ['publish-sidecars', 'publish']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-24.04');
    assert.equal(jobs[name].permissions['id-token'], 'write');
  }
});

test('the renderer leg executes rows without the ERP receipt only the seal leg binds', () => {
  const jobs = readWorkflow('ultramodern-release-acceptance').jobs;
  assert.deepEqual(Object.keys(jobs), [
    'accept-release',
    'renderer-features',
    'seal',
  ]);
  // release.mjs reads --acceptance-receipt only in its last step, so the
  // rows must not wait for the ERP leg that produces it.
  assert.equal(jobs['renderer-features'].needs, undefined);
  assert.equal(
    jobs['renderer-features'].if,
    'inputs.required_renderer_features',
  );
  assert.deepEqual(jobs.seal.needs, ['accept-release', 'renderer-features']);
  const executed = jobs['renderer-features'].steps.find(
    step => step.id === 'renderer-features',
  );
  const sealed = jobs.seal.steps.find(
    step => step.name === 'Seal the renderer feature acceptance receipt',
  );
  assert.match(executed.run, /--emit-rows "\$RENDERER_FEATURE_ROWS"/u);
  assert.doesNotMatch(executed.run, /--acceptance-receipt|--feature-receipt/u);
  assert.match(sealed.run, /--rows "\$RENDERER_FEATURE_ROWS"/u);
  assert.match(
    sealed.run,
    /--acceptance-receipt \.modern\/bleedingdev-publish\/acceptance-receipt\.json/u,
  );
  assert.match(
    sealed.run,
    /--feature-receipt \.modern\/bleedingdev-publish\/acceptance-receipt\.renderer-features\.json/u,
  );
  assert.doesNotMatch(sealed.run, /--required-features|--emit-rows/u);
  assert.equal(
    executed.env.RENDERER_FEATURE_ROWS,
    sealed.env.RENDERER_FEATURE_ROWS,
  );
  // One reproducible evidence root, uploaded and restored at the same path.
  const upload = jobs['renderer-features'].steps.find(
    step => step.name === 'Preserve renderer feature runtime evidence',
  );
  const download = jobs.seal.steps.find(
    step => step.name === 'Download renderer feature runtime evidence',
  );
  assert.equal(upload.with.name, download.with.name);
  assert.equal(
    upload.with.path,
    `${expression('runner.temp')}/renderer-features/logs`,
  );
  assert.equal(download.with.path, upload.with.path);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['include-hidden-files'], true);
  for (const step of [executed, sealed])
    assert.match(step.run, /realpath "\$RUNNER_TEMP\/renderer-features"/u);
  assert.doesNotMatch(executed.run, /mktemp/u);
  // The one public acceptance artifact still carries the same three receipts.
  const receipt = jobs.seal.steps.find(
    step => step.name === 'Upload release acceptance receipt',
  );
  assert.equal(
    receipt.with.name,
    `${expression('env.BLEEDINGDEV_RELEASE_ACCEPTANCE_ARTIFACT')}-${expression('inputs.producer_artifact_identity')}`,
  );
  assert.deepEqual(receipt.with.path.trim().split('\n'), [
    '.modern/bleedingdev-publish/acceptance-receipt.json',
    '.modern/bleedingdev-publish/acceptance-receipt.operational-independence.json',
    '.modern/bleedingdev-publish/acceptance-receipt.renderer-features.json',
  ]);
  assert.equal(receipt.with['if-no-files-found'], 'error');
  // No renderer work is left behind on the ERP leg.
  for (const step of jobs['accept-release'].steps)
    assert.doesNotMatch(`${step.name} ${step.run ?? ''}`, /renderer/iu);
});

test('the seal leg demands exactly the renderer result its inputs asked for', () => {
  const seal = readWorkflow('ultramodern-release-acceptance').jobs.seal;
  // GitHub treats hyphenated job ids as property names, not subtraction.
  const condition = seal.if
    .replaceAll('needs.accept-release', 'needs["accept-release"]')
    .replaceAll('needs.renderer-features', 'needs["renderer-features"]');
  function evaluate(required, erp, renderer) {
    return runInNewContext(condition, {
      always: () => true,
      cancelled: () => false,
      inputs: { required_renderer_features: required },
      needs: {
        'accept-release': { result: erp },
        'renderer-features': { result: renderer },
      },
    });
  }
  assert.equal(evaluate(true, 'success', 'success'), true);
  assert.equal(evaluate(false, 'success', 'skipped'), true);
  for (const [required, erp, renderer] of [
    [true, 'success', 'skipped'],
    [true, 'success', 'failure'],
    [true, 'success', 'cancelled'],
    [true, 'failure', 'success'],
    [true, 'skipped', 'success'],
    [false, 'success', 'success'],
    [false, 'success', 'failure'],
    [false, 'failure', 'skipped'],
  ])
    assert.equal(
      evaluate(required, erp, renderer),
      false,
      `${required} ${erp} ${renderer}`,
    );
});
