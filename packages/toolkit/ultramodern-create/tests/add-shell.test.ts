import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkerDeliveryUnitStamp } from '@modern-js/app-tools-extensions/cloudflare/delivery-unit';
import { emitFrameworkMicroVerticalReleaseEnvelope } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { emitRendererBuildArtifact } from '@modern-js/app-tools-extensions/release-envelope/renderer-output-stamp';
import {
  assertUltramodernBuildArtifact,
  stampUltramodernBuildArtifactIdentity,
} from '@modern-js/backend-federation-contracts';
import {
  addUltramodernShell,
  addUltramodernVertical,
  planUltramodernShell,
  planUltramodernVertical,
} from '../src/ultramodern-workspace';
import { UnknownUltramodernShellError } from '../src/ultramodern-workspace/add-vertical/preflight';
import { sharedPackages } from '../src/ultramodern-workspace/descriptors';
import {
  prependCommandFixturePath,
  writeNodeCommandFixture,
} from './helpers/node-command-fixture';
import {
  createWorkspace,
  linkInstalledEffectCompiler,
  runValidation,
} from './helpers/workspace-kit';

const createBinPath = path.resolve(__dirname, '../bin/run.js');

function readJson(workspaceDir: string, relativePath: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(workspaceDir, relativePath), 'utf-8'),
  );
}

async function createBaseWorkspace(workspaceDir: string) {
  await createWorkspace(workspaceDir);
  linkInstalledEffectCompiler(workspaceDir);
  await addUltramodernVertical({
    workspaceRoot: workspaceDir,
    name: 'catalog',
    modernVersion: '3.2.1',
  });
}

function readAppConfigs(workspaceDir: string): Map<string, Buffer> {
  const configs = new Map<string, Buffer>();
  for (const root of ['apps', 'verticals']) {
    for (const app of fs.readdirSync(path.join(workspaceDir, root), {
      withFileTypes: true,
    })) {
      if (!app.isDirectory()) continue;
      const relativePath = `${root}/${app.name}/modern.config.ts`;
      configs.set(
        relativePath,
        fs.readFileSync(path.join(workspaceDir, relativePath)),
      );
    }
  }
  return configs;
}

function assertAppConfigsPreserved(
  workspaceDir: string,
  configs: ReadonlyMap<string, Buffer>,
  result: { createdPaths: string[]; rewrittenPaths: string[] },
) {
  for (const [relativePath, bytes] of configs) {
    assert.deepEqual(
      fs.readFileSync(path.join(workspaceDir, relativePath)),
      bytes,
      `${relativePath} must retain its exact bytes`,
    );
    assert.equal(
      result.rewrittenPaths.includes(relativePath),
      false,
      `${relativePath} must not be reported as a planned or applied rewrite`,
    );
    assert.equal(
      result.createdPaths.includes(relativePath),
      false,
      `${relativePath} already exists`,
    );
  }
}

test('shell and vertical additions preserve every existing native config through previews and target changes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const topologyRelative = 'topology/reference-topology.json';
  const overlayRelative = 'topology/local-overlays/development.json';
  try {
    await createBaseWorkspace(workspaceDir);
    assert.equal(readAppConfigs(workspaceDir).size, 2);

    for (const name of ['admin', 'partner']) {
      const configs = readAppConfigs(workspaceDir);
      const topologyBefore = fs.readFileSync(
        path.join(workspaceDir, topologyRelative),
      );
      const overlayBefore = fs.readFileSync(
        path.join(workspaceDir, overlayRelative),
      );
      const options = {
        workspaceRoot: workspaceDir,
        name,
        modernVersion: '3.2.1',
      };
      const plan = await planUltramodernShell(options);
      const configPath = `apps/shell-${name}/modern.config.ts`;
      assertAppConfigsPreserved(workspaceDir, configs, plan);
      assert.ok(plan.createdPaths.includes(configPath));
      assert.equal(fs.existsSync(path.join(workspaceDir, configPath)), false);
      assert.deepEqual(
        fs.readFileSync(path.join(workspaceDir, topologyRelative)),
        topologyBefore,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(workspaceDir, overlayRelative)),
        overlayBefore,
      );

      const result = await addUltramodernShell(options);
      assertAppConfigsPreserved(workspaceDir, configs, result);
      assert.ok(result.createdPaths.includes(configPath));
      assert.ok(fs.readFileSync(path.join(workspaceDir, configPath)).length);
      assert.equal(readAppConfigs(workspaceDir).size, configs.size + 1);
      const topology = readJson(workspaceDir, topologyRelative);
      const additional = topology.shells.find(
        (shell: { id: string }) => shell.id === `shell-${name}`,
      );
      assert.deepEqual(additional.verticalRefs, ['catalog']);
      const overlay = readJson(workspaceDir, overlayRelative);
      assert.equal(
        overlay.ports[`shell-${name}`],
        result.assignedPorts[`shell-${name}`],
      );
      const previousPorts = JSON.parse(overlayBefore.toString()).ports;
      for (const [appId, previousPort] of Object.entries(previousPorts)) {
        assert.equal(overlay.ports[appId], previousPort);
      }
      assert.equal(
        Object.values(previousPorts).includes(overlay.ports[`shell-${name}`]),
        false,
        'the new shell receives an unoccupied development port',
      );

      if (name === 'admin') {
        // Keep the new shell pristine while replacing both original apps with
        // native authored configuration, including intentional CRLF bytes.
        for (const relativePath of configs.keys()) {
          const authored = [
            "import { defineConfig } from '@modern-js/app-tools';",
            "import { ultramodernAppTools } from '@modern-js/ultramodern-app-tools';",
            '',
            `// Consumer config for ${relativePath}`,
            'export default defineConfig({',
            '  plugins: [ultramodernAppTools()],',
            "  source: { alias: { '@consumer': './src' } },",
            '});',
            '',
          ].join('\r\n');
          fs.writeFileSync(path.join(workspaceDir, relativePath), authored);
        }
      }
    }

    const overlay = readJson(workspaceDir, overlayRelative);
    overlay.ports['shell-admin'] = 4102;
    fs.writeFileSync(
      path.join(workspaceDir, overlayRelative),
      `${JSON.stringify(overlay, null, 2)}\n`,
    );
    for (const { name, shell, port } of [
      { name: 'orders', shell: 'shell-admin', port: 4103 },
      { name: 'payments', shell: 'shell-super-app', port: 4104 },
    ]) {
      const configs = readAppConfigs(workspaceDir);
      const topologyBefore = fs.readFileSync(
        path.join(workspaceDir, topologyRelative),
      );
      const overlayBefore = fs.readFileSync(
        path.join(workspaceDir, overlayRelative),
      );
      const options = {
        workspaceRoot: workspaceDir,
        name,
        shell,
        modernVersion: '3.2.1',
      };
      const plan = await planUltramodernVertical(options);
      const configPath = `verticals/${name}/modern.config.ts`;
      assertAppConfigsPreserved(workspaceDir, configs, plan);
      assert.ok(plan.createdPaths.includes(configPath));
      assert.equal(plan.selectedPort, port);
      assert.equal(fs.existsSync(path.join(workspaceDir, configPath)), false);
      assert.deepEqual(
        fs.readFileSync(path.join(workspaceDir, topologyRelative)),
        topologyBefore,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(workspaceDir, overlayRelative)),
        overlayBefore,
      );

      const result = await addUltramodernVertical(options);
      assertAppConfigsPreserved(workspaceDir, configs, result);
      assert.ok(result.createdPaths.includes(configPath));
      assert.ok(fs.readFileSync(path.join(workspaceDir, configPath)).length);
      assert.equal(readAppConfigs(workspaceDir).size, configs.size + 1);
      const topology = readJson(workspaceDir, topologyRelative);
      const shells = [topology.shell, ...topology.shells];
      for (const current of shells) {
        const expectedRefs =
          current.id === 'shell-admin'
            ? ['catalog', 'orders']
            : current.id === 'shell-super-app' && name === 'payments'
              ? ['catalog', 'payments']
              : ['catalog'];
        assert.deepEqual(current.verticalRefs, expectedRefs);
        assert.deepEqual(
          current.moduleFederation.remotes.map(
            (remote: { id: string }) => remote.id,
          ),
          expectedRefs,
        );
      }
      const nextOverlay = readJson(workspaceDir, overlayRelative);
      assert.equal(nextOverlay.ports[name], port);
      for (const [appId, previousPort] of Object.entries(
        JSON.parse(overlayBefore.toString()).ports,
      )) {
        assert.equal(nextOverlay.ports[appId], previousPort);
      }
      assert.equal(result.assignedPorts[name], port);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}, 300_000);

type RecordedBuildInvocation = {
  argv: string[];
  cwd: string;
};

function runRecordedRootBuild(
  workspaceDir: string,
  options: { failFilter?: string } = {},
) {
  const recorderRoot = fs.mkdtempSync(
    path.join(path.dirname(workspaceDir), 'build-recorder-'),
  );
  const binDir = path.join(recorderRoot, 'bin');
  const invocationLog = path.join(recorderRoot, 'invocations.jsonl');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(createBinPath, path.join(binDir, 'ultramodern-create'));
  writeNodeCommandFixture(
    binDir,
    'pnpm',
    `
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(
  process.env.ULTRAMODERN_TEST_BUILD_LOG,
  JSON.stringify({ argv, cwd: process.cwd() }) + '\\n',
);
if (argv.includes(process.env.ULTRAMODERN_TEST_FAIL_FILTER)) {
  process.exit(23);
}
`,
  );
  // Exercise the generated prebuild with a real compiler and a dependency-free fixture.
  for (const { directory } of sharedPackages) {
    const fixtureRoot = path.join(workspaceDir, directory);
    fs.writeFileSync(
      path.join(fixtureRoot, 'root-build-fixture.ts'),
      'export const buildContract: string = "checked";\n',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: './dist',
          types: [],
        },
        files: ['root-build-fixture.ts'],
      }),
    );
  }

  const rootPackage = readJson(workspaceDir, 'package.json');
  const environment: NodeJS.ProcessEnv = {
    ...prependCommandFixturePath(binDir),
    ULTRAMODERN_CREATE_BIN: createBinPath,
    ULTRAMODERN_TEST_BUILD_LOG: invocationLog,
    ULTRAMODERN_TEST_FAIL_FILTER: options.failFilter ?? '',
  };
  // Let the generated entry resolve the verified compiler from this workspace.
  delete environment.EFFECT_TSGO_BIN;
  const result = spawnSync(rootPackage.scripts.build, {
    cwd: workspaceDir,
    encoding: 'utf-8',
    env: environment,
    shell: true,
  });
  const invocations = fs.existsSync(invocationLog)
    ? fs
        .readFileSync(invocationLog, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as RecordedBuildInvocation)
    : [];
  return { invocations, result };
}

test('generated primary and additional shells declare UI-only finalized Node and Cloudflare surfaces', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-shell-surfaces-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await createBaseWorkspace(workspaceDir);
    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });
    const topology = readJson(workspaceDir, 'topology/reference-topology.json');
    const shells = [topology.shell, ...topology.shells];
    assert.equal(shells.length, 2);
    assert.equal(topology.verticals[0].surfaceProfile, undefined);
    assert.ok(topology.verticals[0].api);

    for (const shell of shells) {
      assert.equal(shell.surfaceProfile, 'ui-only');
      assert.equal(shell.api, undefined);
      assert.equal(shell.backendFederation, undefined);
      const appDirectory = path.join(workspaceDir, shell.path);
      assert.equal(fs.existsSync(path.join(appDirectory, 'api')), false);
      const artifact: unknown = readJson(
        workspaceDir,
        `${shell.path}/shared/ultramodern-build.json`,
      );
      assertUltramodernBuildArtifact(artifact);
      const ui = artifact.surfaces.ui;
      assert.ok(ui);
      // The shared carrier reserves API identity metadata; topology owns the
      // declaration of executable surfaces.
      assert.ok(artifact.surfaces.api);
      for (const [distName, target, marker] of [
        ['dist', 'node', 'f'],
        ['dist-cloudflare', 'cloudflare', 'e'],
      ] as const) {
        const distDirectory = path.join(appDirectory, distName);
        const buildMarker = marker.repeat(64);
        const sourceRevision = 'a'.repeat(40);
        const compiledUi = stampUltramodernBuildArtifactIdentity(artifact, {
          buildMarker,
          sourceRevision,
        }).surfaces.ui;
        assert.ok(compiledUi);
        const finalized = await emitRendererBuildArtifact(
          {
            appDirectory,
            distDirectory,
            entrypoints: [
              { entryName: ui.rendererIdentity.entryName, isMainEntry: true },
            ],
          },
          {
            rendererBuildPlugin: '@modern-js/renderer-react-build-metadata',
            resolveRendererBuild: async () => ({
              buildMarker,
              sourceRevision,
              ui: compiledUi,
            }),
          },
        );
        assert.ok(finalized);
        const stamp = await resolveWorkerDeliveryUnitStamp(
          appDirectory,
          distDirectory,
        );
        assert.equal(stamp?.buildMarker, buildMarker);
        assert.deepEqual(stamp?.surfaces.ui, finalized.surfaces.ui);
        assert.equal(Object.hasOwn(stamp?.surfaces ?? {}, 'api'), false);

        shell.surfaceProfile = 'full-stack';
        fs.writeFileSync(
          path.join(workspaceDir, 'topology/reference-topology.json'),
          JSON.stringify(topology),
        );
        const fullStack = await resolveWorkerDeliveryUnitStamp(
          appDirectory,
          distDirectory,
        );
        assert.deepEqual(fullStack?.surfaces.api, finalized.surfaces.api);
        // A Shell consumes remotes rather than publishing a backend container.
        // Renderer identity alone still cannot replace executable build output.
        await assert.rejects(
          () =>
            emitFrameworkMicroVerticalReleaseEnvelope({
              apiOnly: false,
              appDirectory,
              distDirectory,
              target,
            }),
          /full-stack MicroVertical has no UI\/client artifacts/u,
        );
        shell.surfaceProfile = 'ui-only';
        fs.writeFileSync(
          path.join(workspaceDir, 'topology/reference-topology.json'),
          JSON.stringify(topology),
        );
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('root build executes every shell before and after adding a vertical and propagates failures', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const expectedInvocations = [
    ['-r', '--filter', './verticals/*', 'run', 'build'],
    ['--filter', './apps/shell-super-app', 'run', 'build'],
    ['--filter', './apps/shell-admin', 'run', 'build'],
    ['mf:types'],
    ['performance:readiness'],
  ];
  try {
    await createBaseWorkspace(workspaceDir);
    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });

    const buildBeforeVertical = runRecordedRootBuild(workspaceDir);
    assert.equal(
      buildBeforeVertical.result.status,
      0,
      `${buildBeforeVertical.result.stdout}\n${buildBeforeVertical.result.stderr}`,
    );
    assert.deepEqual(
      buildBeforeVertical.invocations.map(invocation => invocation.argv),
      expectedInvocations,
    );
    for (const { directory } of sharedPackages) {
      assert.equal(
        fs.existsSync(
          path.join(workspaceDir, directory, 'dist/root-build-fixture.d.ts'),
        ),
        true,
        'shared declaration prebuilds must run before shell commands',
      );
    }
    assert.ok(
      buildBeforeVertical.invocations.every(
        invocation => invocation.cwd === fs.realpathSync(workspaceDir),
      ),
    );

    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'orders',
      modernVersion: '3.2.1',
    });
    const buildAfterVertical = runRecordedRootBuild(workspaceDir);
    assert.equal(
      buildAfterVertical.result.status,
      0,
      `${buildAfterVertical.result.stdout}\n${buildAfterVertical.result.stderr}`,
    );
    assert.deepEqual(
      buildAfterVertical.invocations.map(invocation => invocation.argv),
      expectedInvocations,
    );

    // A shell build failure is returned by the root build and stops later
    // shells and post-build gates from running.
    const failedBuild = runRecordedRootBuild(workspaceDir, {
      failFilter: './apps/shell-super-app',
    });
    assert.equal(failedBuild.result.status, 23);
    assert.deepEqual(
      failedBuild.invocations.map(invocation => invocation.argv),
      [
        ['-r', '--filter', './verticals/*', 'run', 'build'],
        ['--filter', './apps/shell-super-app', 'run', 'build'],
      ],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('add-vertical targets an additional shell and rejects unknown shell ids during preflight', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await createBaseWorkspace(workspaceDir);
    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });

    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'orders',
      modernVersion: '3.2.1',
      shell: 'shell-admin',
    });

    const topology = readJson(workspaceDir, 'topology/reference-topology.json');
    const primary = topology.shell;
    const additional = topology.shells.find(
      (shell: { id?: string }) => shell.id === 'shell-admin',
    );
    assert.deepEqual(primary.verticalRefs, ['catalog']);
    assert.deepEqual(additional.verticalRefs, ['catalog', 'orders']);
    assert.ok(
      additional.moduleFederation.remotes.some(
        (remote: { id?: string }) => remote.id === 'orders',
      ),
    );

    const primaryPackage = readJson(
      workspaceDir,
      'apps/shell-super-app/package.json',
    );
    const additionalPackage = readJson(
      workspaceDir,
      'apps/shell-admin/package.json',
    );
    // API surface is full mesh: every shell re-exports each API unit's client
    // (plain workspace dep), even when the unit composes into another shell.
    assert.equal(
      primaryPackage.dependencies['@workspace/orders'],
      'workspace:*',
    );
    // Composition stays target-scoped: no Zephyr/MF wiring on the primary.
    assert.equal(primaryPackage['zephyr:dependencies']?.orders, undefined);
    assert.equal(
      additionalPackage.dependencies['@workspace/orders'],
      'workspace:*',
    );
    assert.equal(
      additionalPackage['zephyr:dependencies'].orders,
      '@workspace/orders@workspace:*',
    );

    assert.deepEqual(topology.shell.verticalRefs, ['catalog']);
    assert.deepEqual(
      topology.shell.moduleFederation.remotes.map(
        (remote: { id: string }) => remote.id,
      ),
      ['catalog'],
    );
    const validation = runValidation(workspaceDir);
    assert.equal(
      validation.status,
      0,
      `${validation.stdout}\n${validation.stderr}`,
    );

    await assert.rejects(
      async () =>
        await addUltramodernVertical({
          workspaceRoot: workspaceDir,
          name: 'payments',
          modernVersion: '3.2.1',
          shell: 'shell-missing',
        }),
      error => {
        assert.ok(error instanceof UnknownUltramodernShellError);
        assert.equal(error.code, 'ULTRAMODERN_UNKNOWN_TARGET_SHELL');
        assert.deepEqual(error.issue, {
          field: 'shell',
          value: 'shell-missing',
          reason: 'unknown',
          available: ['shell-super-app', 'shell-admin'],
        });
        return true;
      },
    );
    assert.equal(
      fs.existsSync(path.join(workspaceDir, 'verticals/payments')),
      false,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('workspace-wide port allocation', () => {
  let tempRoot: string;
  let workspaceDir: string;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    await createBaseWorkspace(workspaceDir);

    const overlayPath = path.join(
      workspaceDir,
      'topology/local-overlays/development.json',
    );
    const overlay = readJson(
      workspaceDir,
      'topology/local-overlays/development.json',
    );
    overlay.ports.catalog = 3120;
    fs.writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
  });

  beforeAll(async () => {
    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });
    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'partner',
      modernVersion: '3.2.1',
    });
  });

  afterAll(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('additional shells avoid customized overlay ports and keep distinct ports', () => {
    const topologyAfterShell = readJson(
      workspaceDir,
      'topology/reference-topology.json',
    );
    const overlayAfterShell = readJson(
      workspaceDir,
      'topology/local-overlays/development.json',
    );
    assert.deepEqual(
      topologyAfterShell.shells.map((shell: { id: string }) => shell.id),
      ['shell-admin', 'shell-partner'],
    );
    assert.deepEqual(
      topologyAfterShell.shells.map(
        (shell: { id: string }) => overlayAfterShell.ports[shell.id],
      ),
      [3121, 3122],
    );
    assert.equal(
      new Set(
        topologyAfterShell.shells.map(
          (shell: { id: string }) => overlayAfterShell.ports[shell.id],
        ),
      ).size,
      2,
      'additional shell ports are distinct',
    );

    const rootTsConfig = readJson(workspaceDir, 'tsconfig.json');
    const referencePaths = (rootTsConfig.references ?? []).map(
      (reference: { path?: string }) => reference.path,
    );
    assert.ok(referencePaths.includes('apps/shell-admin'));
    assert.ok(referencePaths.includes('apps/shell-partner'));
  });

  test('a new vertical avoids customized shell ports and preserves existing allocations', async () => {
    const verticalWorkspace = path.join(tempRoot, 'vertical-workspace');
    fs.cpSync(workspaceDir, verticalWorkspace, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const overlayAfterShell = readJson(
      verticalWorkspace,
      'topology/local-overlays/development.json',
    );
    overlayAfterShell.ports['shell-admin'] = 4101;
    fs.writeFileSync(
      path.join(verticalWorkspace, 'topology/local-overlays/development.json'),
      `${JSON.stringify(overlayAfterShell, null, 2)}\n`,
    );
    await addUltramodernVertical({
      workspaceRoot: verticalWorkspace,
      name: 'orders',
      modernVersion: '3.2.1',
    });
    const topologyAfterVertical = readJson(
      verticalWorkspace,
      'topology/reference-topology.json',
    );
    const overlayAfterVertical = readJson(
      verticalWorkspace,
      'topology/local-overlays/development.json',
    );
    assert.equal(overlayAfterVertical.ports.orders, 4102);
    assert.deepEqual(
      topologyAfterVertical.shells.map((shell: { id: string }) => shell.id),
      ['shell-admin', 'shell-partner'],
    );
    assert.equal(overlayAfterVertical.ports['shell-admin'], 4101);
    assert.equal(overlayAfterVertical.ports['shell-partner'], 3122);
  });
});

test('planUltramodernShell reports the planned shell without mutating the workspace', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await createBaseWorkspace(workspaceDir);

    const plan = await planUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.operation, 'shell');
    assert.ok(
      plan.createdPaths.some(created =>
        created.startsWith('apps/shell-admin/'),
      ),
      'plan reports the scaffolded shell paths',
    );
    // Dry-run must not touch the real workspace.
    assert.equal(
      fs.existsSync(path.join(workspaceDir, 'apps/shell-admin')),
      false,
    );
    assert.equal(
      (readJson(workspaceDir, 'topology/reference-topology.json').shells ?? [])
        .length,
      0,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('add-shell keeps consumer-authored root scripts and tsconfig bytes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-add-shell-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await createBaseWorkspace(workspaceDir);
    const packagePath = path.join(workspaceDir, 'package.json');
    const manifest = readJson(workspaceDir, 'package.json');
    manifest.scripts['consumer:check'] = 'echo authored';
    manifest.scripts.build = 'echo authored-build';
    fs.writeFileSync(packagePath, JSON.stringify(manifest, null, 2));
    const originalVerticalRefs = readJson(
      workspaceDir,
      'topology/reference-topology.json',
    ).shell.verticalRefs;
    const tsconfigPath = path.join(workspaceDir, 'tsconfig.json');
    const authoredTsconfig =
      '{"references":[],"compilerOptions":{"strict":true},"extra":"authored"}\n';
    fs.writeFileSync(tsconfigPath, authoredTsconfig);

    await addUltramodernShell({
      workspaceRoot: workspaceDir,
      name: 'admin',
      modernVersion: '3.2.1',
    });

    const next = readJson(workspaceDir, 'package.json');
    assert.equal(next.scripts['consumer:check'], 'echo authored');
    assert.equal(next.scripts.build, 'echo authored-build');
    assert.equal(fs.readFileSync(tsconfigPath, 'utf-8'), authoredTsconfig);
    assert.deepEqual(
      readJson(workspaceDir, 'topology/reference-topology.json').shell
        .verticalRefs,
      originalVerticalRefs,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
