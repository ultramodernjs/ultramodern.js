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

// The source lane emits rows for the `seal` job instead of a receipt, so only
// the published lane retains receipt-referenced copies before its upload.
for (const [mode, failures] of [
  ['source', ['none', 'stage', 'proof', 'token-leak']],
  ['published', ['none', 'stage', 'proof', 'retain', 'token-leak']],
])
  for (const failure of failures)
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
      const rows = path.join(root, 'rows', 'rows.json');
      const job =
        mode === 'source'
          ? readWorkflow('ultramodern-release-acceptance').jobs[
              'renderer-features'
            ]
          : readWorkflow('accept-bleedingdev-release').jobs['accept-published'];
      const command = job.steps.find(step =>
        step.name.includes('installed renderer features'),
      ).run;
      const exercisedCommand =
        failure === 'token-leak'
          ? command.replace('unset NATIVE_ARTIFACT_GITHUB_TOKEN', ':')
          : command;
      if (failure === 'token-leak') assert.notEqual(exercisedCommand, command);
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
              [[ "$GH_TOKEN" == native-control-token ]] || return 88
              mkdir "$OWNED_TEMP_DIR/native-inputs"
              printf 'staged control bytes' > "$OWNED_TEMP_DIR/native-inputs/native-inputs.json"
              if [[ "$FAILURE" == stage ]]; then return 23; fi
              ;;
            scripts/ultramodern-renderers/release.mjs)
              # A proof log that captured its environment is uploaded verbatim.
              mkdir -p "$OWNED_TEMP_DIR/logs"
              env > "$OWNED_TEMP_DIR/logs/feature-environment.log"
              [[ -z "\${GH_TOKEN+x}" && -z "\${NATIVE_ARTIFACT_GITHUB_TOKEN+x}" ]] || return 89
              [[ "$*" == *"--native-inputs $OWNED_TEMP_DIR/native-inputs/native-inputs.json"* ]]
              [[ "$*" == *"--browser-executable $RENDERER_BROWSER_EXECUTABLE"* ]]
              test -f "$OWNED_TEMP_DIR/native-inputs/native-inputs.json"
              printf 'proof invoked' > "$OWNED_TEMP_DIR/proof-evidence.log"
              printf 'non-log proof' > "$OWNED_TEMP_DIR/logs/feature-dev-refresh.receipt.json.observations.json"
              if [[ "$FAILURE" == proof ]]; then return 31; fi
              if [[ "$*" == *"--emit-rows $RENDERER_FEATURE_ROWS"* ]]; then
                mkdir -p "$(dirname "$RENDERER_FEATURE_ROWS")"
                printf 'executed rows' > "$RENDERER_FEATURE_ROWS"
              fi
              ;;
            scripts/ultramodern-renderers/retain-feature-evidence.mjs)
              [[ -z "\${GH_TOKEN+x}" && -z "\${NATIVE_ARTIFACT_GITHUB_TOKEN+x}" ]] || return 89
              test -f "$OWNED_TEMP_DIR/proof-evidence.log"
              if [[ "$FAILURE" == retain ]]; then return 37; fi
              mkdir -p "$OWNED_TEMP_DIR/logs/retained-evidence"
              printf 'retained proof' > "$OWNED_TEMP_DIR/logs/retained-evidence/proof.json"
              ;;
            *) return 90 ;;
          esac
        }
        ${exercisedCommand}
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
            NATIVE_ARTIFACT_GITHUB_TOKEN: 'native-control-token',
            RENDERER_FEATURE_ROWS: rows,
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
        failure === 'stage'
          ? 23
          : failure === 'proof'
            ? 31
            : failure === 'retain'
              ? 37
              : failure === 'token-leak'
                ? 89
                : 0,
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
        !['stage', 'token-leak'].includes(failure),
      );
      assert.equal(
        fs.existsSync(
          path.join(featureRoot, 'logs/retained-evidence/proof.json'),
        ),
        mode === 'published' && failure === 'none',
      );
      assert.equal(
        fs.existsSync(rows),
        mode === 'source' && failure === 'none',
      );
      // The source upload is the whole logs root, so non-log evidence survives
      // to `seal` in place and nothing outside that root is carried.
      if (mode === 'source')
        assert.equal(
          fs.existsSync(
            path.join(
              featureRoot,
              'logs/feature-dev-refresh.receipt.json.observations.json',
            ),
          ),
          !['stage', 'token-leak'].includes(failure),
        );
      const leaked = fs
        .readdirSync(featureRoot, { recursive: true })
        .map(name => path.join(featureRoot, name))
        .filter(
          file =>
            fs.statSync(file).isFile() &&
            fs.readFileSync(file, 'utf8').includes('native-control-token'),
        );
      assert.equal(
        leaked.length > 0,
        failure === 'token-leak',
        'The artifact token must never reach proof processes or evidence',
      );
    });

test('published uploads the selected non-log evidence as well as failure logs', () => {
  const upload = readWorkflow('accept-bleedingdev-release').jobs[
    'accept-published'
  ].steps.find(
    step => step.name === 'Preserve renderer feature runtime evidence',
  );
  assert.match(upload.with.path, /retained-evidence\/\*\*/u);
  assert.match(upload.with.path, /\*\*\/\*\.log/u);
  assert.doesNotMatch(upload.with.path, /renderer-features-\*\/\*\*$/mu);
});

for (const mode of ['source', 'published'])
  test(`${mode} installed feature command consumes the fixed browser provisioner's exact output`, () => {
    const job =
      mode === 'source'
        ? readWorkflow('ultramodern-release-acceptance').jobs[
            'renderer-features'
          ]
        : readWorkflow('accept-bleedingdev-release').jobs['accept-published'];
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
        : readWorkflow('accept-bleedingdev-release').jobs['accept-published'];
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

test('renderer CLI provisioning verifies the pinned native release before execution', () => {
  const script = fs.readFileSync(
    new URL('./provision-agent-browser.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /const version = '0\.43\.0'/u);
  assert.match(
    script,
    /8e69c9fb662514c9cf36e4911e94e913742ba066e55102486350e049dd847612/u,
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
test('every acceptance leg selects a fixed Depot Linux runner', () => {
  // The renderer and seal legs select the same runner class, byte for byte:
  // the sealed receipt verifies evidence digests against absolute RUNNER_TEMP
  // paths, which only agree when both legs run the same image. The ERP leg
  // hands seal only its receipt files, never a path, and needs more cores for
  // its build passes, so it pins the 16-vCPU size of the same Depot Ubuntu
  // 24.04 image as a literal no variable can move. The former
  // `&& 'ubuntu-latest' ||` fork-isolation prefix is gone, so an external pull
  // request can no longer move any leg to other hardware.
  assert.equal(
    readWorkflow('ultramodern-release-acceptance').jobs['accept-release'][
      'runs-on'
    ],
    'depot-ubuntu-24.04-16',
  );
  for (const [workflow, job] of [
    ['ultramodern-release-acceptance', 'renderer-features'],
    ['ultramodern-release-acceptance', 'seal'],
    ['ultramodern-tractor-downstream', 'tractor-downstream'],
    ['native-compatibility', 'native-compatibility'],
    ['accept-bleedingdev-release', 'accept-published'],
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
  // Only `seal` writes the feature receipt; nothing here may read it.
  assert.doesNotMatch(executed.run, /renderer-features\.json/u);
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
