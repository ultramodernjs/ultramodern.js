import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { readUltramodernWorkspaceInputs } from '../src/ultramodern-tooling/config';
import {
  addUltramodernVertical,
  generateUltramodernWorkspace,
} from '../src/ultramodern-workspace';
import { createWorkspaceRootPackageScripts } from '../src/ultramodern-workspace/workspace-script-plan';
import { linkBuiltCodeTools } from './helpers/built-code-tools';
import { linkInstalledEffectCompiler } from './helpers/workspace-kit';

const packageRoot = path.resolve(__dirname, '..');
const createBinPath = path.join(packageRoot, 'bin/run.js');

const hermeticEnv = {
  ...process.env,
  MODERN_CREATE_ULTRAMODERN_FRAMEWORK_VERSION: '3.2.0-ultramodern.108',
  ULTRAMODERN_CREATE_BIN: createBinPath,
};

function read(workspaceDir: string, relativePath: string) {
  return fs.readFileSync(path.join(workspaceDir, relativePath), 'utf-8');
}

function readJson(workspaceDir: string, relativePath: string): any {
  return JSON.parse(read(workspaceDir, relativePath));
}

function writeJson(workspaceDir: string, relativePath: string, value: unknown) {
  fs.writeFileSync(
    path.join(workspaceDir, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf-8',
  );
}

function runGeneratedWorkspaceCheck(workspaceDir: string) {
  return spawnSync(
    process.execPath,
    [createBinPath, 'ultramodern', 'validate'],
    {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: { ...hermeticEnv, ULTRAMODERN_WORKSPACE_ROOT: workspaceDir },
    },
  );
}

function runGeneratedApiCheck(workspaceDir: string) {
  // These fixtures deliberately skip install. Supply the real parser/tooling,
  // never mock the validator or write through a shared node_modules symlink.
  const sharedContracts = path.join(workspaceDir, 'packages/shared-contracts');
  const sharedName = readJson(
    workspaceDir,
    'packages/shared-contracts/package.json',
  ).name;
  const workspaceModules = path.join(workspaceDir, 'node_modules');
  if (fs.existsSync(workspaceModules)) {
    assert.equal(fs.lstatSync(workspaceModules).isSymbolicLink(), false);
  }
  const sharedLink = path.join(workspaceModules, sharedName);
  if (!fs.existsSync(sharedLink)) {
    fs.mkdirSync(path.dirname(sharedLink), { recursive: true });
    fs.symlinkSync(sharedContracts, sharedLink, 'dir');
  }
  const modules = path.join(workspaceDir, 'node_modules');
  linkBuiltCodeTools(modules);
  for (const [name, target] of Object.entries({
    '@modern-js/bff-effect': path.resolve(
      __dirname,
      '../../../server/bff-effect',
    ),
    '@typescript/native': path.dirname(
      createRequire(import.meta.url).resolve('typescript/package.json'),
    ),
  })) {
    const link = path.join(modules, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'dir');
  }
  return spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../code-tools/bin/modern-api-check.mjs')],
    {
      cwd: workspaceDir,
      encoding: 'utf8',
      env: hermeticEnv,
    },
  );
}

function commandOutput(result: ReturnType<typeof runGeneratedWorkspaceCheck>) {
  return `${result.stdout}\n${result.stderr}`;
}

function appById(apps: any[], id: string): any {
  const app = apps.find(candidate => candidate.id === id);
  assert.ok(app, `Expected app ${id}`);
  return app;
}

test('referenced remote declaration prebuild emits declarations from a clean cache before the dependent shell build', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-declaration-'));
  const workspaceDir = path.join(tempRoot, 'integration-workspace');

  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'integration-workspace',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledEffectCompiler(workspaceDir);
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'catalog',
      modernVersion: '3.2.1',
    });
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'checkout',
      modernVersion: '3.2.1',
    });

    // A cross-remote reference is the only topology the generator prebuilds
    // with `--emit --project`, so take the executed command from the generator
    // instead of restating it here.
    const topology = readJson(workspaceDir, 'topology/reference-topology.json');
    appById(topology.verticals, 'checkout').moduleFederation.verticalRefs = [
      'catalog',
    ];
    writeJson(workspaceDir, 'topology/reference-topology.json', topology);
    const declarationPrebuild = createWorkspaceRootPackageScripts(
      readUltramodernWorkspaceInputs(workspaceDir).verticals,
    )
      .build.split(' && ')
      .find(segment => segment.includes('--emit --project verticals/catalog/'));
    assert.ok(
      declarationPrebuild,
      'the generated root build must prebuild referenced remote declarations',
    );

    // The generated remote's real sources import the whole framework, which a
    // hermetic fixture cannot install. Reduce the referenced remote to one
    // dependency-free module so the installed TypeScript 7 compiler runs
    // offline. The two things this proof is about, the generated tsconfig and
    // the generated prebuild command, stay untouched.
    for (const sourceDirectory of ['api', 'server', 'shared', 'src']) {
      fs.rmSync(path.join(workspaceDir, 'verticals/catalog', sourceDirectory), {
        force: true,
        recursive: true,
      });
    }
    fs.mkdirSync(path.join(workspaceDir, 'verticals/catalog/src'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, 'verticals/catalog/src/index.ts'),
      "export const catalogRemoteContract = 'catalog' as const;\n",
      'utf-8',
    );

    const catalogTsConfig = readJson(
      workspaceDir,
      'verticals/catalog/tsconfig.json',
    );
    const nodeTypesLink = path.join(workspaceDir, 'node_modules/@types/node');
    fs.mkdirSync(path.dirname(nodeTypesLink), { recursive: true });
    fs.symlinkSync(
      path.dirname(
        createRequire(import.meta.url).resolve('@types/node/package.json'),
      ),
      nodeTypesLink,
      'dir',
    );
    const installedCli = path.join(
      workspaceDir,
      'node_modules/.bin/ultramodern-create',
    );
    fs.mkdirSync(path.dirname(installedCli), { recursive: true });
    fs.symlinkSync(createBinPath, installedCli);
    const declarationFile = path.resolve(
      workspaceDir,
      'verticals/catalog',
      catalogTsConfig.compilerOptions.outDir,
      'src/index.d.ts',
    );
    const tsgoCache = path.join(workspaceDir, 'node_modules/.cache/tsgo');
    const runDeclarationPrebuild = (command: string) => {
      const environment: NodeJS.ProcessEnv = {
        ...hermeticEnv,
        PATH: `${path.join(workspaceDir, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      };
      // Let the generated entry resolve the verified compiler from this workspace.
      delete environment.EFFECT_TSGO_BIN;
      return spawnSync(command, {
        cwd: workspaceDir,
        encoding: 'utf8',
        env: environment,
        shell: true,
      });
    };
    // Stand-in for `pnpm --filter "./apps/shell-super-app" run build`: the only
    // thing the dependent shell build needs from the prebuild is the referenced
    // remote's declaration output, so the mock gates on exactly that.
    const shellBuildGate = path.join(tempRoot, 'shell-build-gate.mjs');
    fs.writeFileSync(
      shellBuildGate,
      `import { existsSync } from 'node:fs';
if (!existsSync(process.argv[2])) {
  console.error('missing referenced remote declarations: ' + process.argv[2]);
  process.exit(1);
}
`,
      'utf-8',
    );
    const runDependentShellBuild = () =>
      spawnSync(process.execPath, [shellBuildGate, declarationFile], {
        cwd: workspaceDir,
        encoding: 'utf8',
      });

    // Clean cache: a freshly generated workspace carries no TS-Go declaration
    // cache, so every artifact below is produced by this run.
    assert.equal(fs.existsSync(tsgoCache), false);

    const prebuild = runDeclarationPrebuild(declarationPrebuild);
    assert.equal(prebuild.status, 0, commandOutput(prebuild));
    assert.equal(
      fs.existsSync(declarationFile),
      true,
      'the referenced remote prebuild must emit declarations from a clean cache',
    );
    assert.match(
      fs.readFileSync(declarationFile, 'utf-8'),
      /catalogRemoteContract/u,
    );
    const readyShellBuild = runDependentShellBuild();
    assert.equal(readyShellBuild.status, 0, commandOutput(readyShellBuild));

    // Predecessor form: dropping `--emit` still exits zero, so the exit status
    // proves nothing on its own; only the emitted declarations do.
    fs.rmSync(tsgoCache, { force: true, recursive: true });
    const nonEmittingPrebuild = runDeclarationPrebuild(
      declarationPrebuild.replace(' --emit --project ', ' --project '),
    );
    assert.equal(
      nonEmittingPrebuild.status,
      0,
      commandOutput(nonEmittingPrebuild),
    );
    assert.equal(fs.existsSync(declarationFile), false);
    const starvedShellBuild = runDependentShellBuild();
    assert.notEqual(
      starvedShellBuild.status,
      0,
      'the dependent shell build must fail when the prebuild emitted nothing',
    );
    assert.match(
      starvedShellBuild.stderr,
      /missing referenced remote declarations/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

const validationDriftScenarios = [
  {
    workspaceName: 'vertical-file-missing',
    mutate: (workspaceDir: string) => {
      fs.rmSync(path.join(workspaceDir, 'verticals/catalog/shared/api.ts'));
    },
    expectedContract:
      /catalog shared API contract \.\/shared\/api\.ts is missing/,
  },
  {
    workspaceName: 'delivery-unit-drift',
    mutate: (workspaceDir: string) => {
      const topology = readJson(
        workspaceDir,
        'topology/reference-topology.json',
      );
      appById(topology.verticals, 'catalog').deliveryUnit.buildMarker =
        'deadbeefdeadbeef';
      writeJson(workspaceDir, 'topology/reference-topology.json', topology);
    },
    expectedContract:
      /catalog renderer identity disagrees with its delivery build/,
  },
  {
    workspaceName: 'missing-build-stamp',
    mutate: (workspaceDir: string) => {
      fs.rmSync(
        path.join(
          workspaceDir,
          'verticals/catalog/shared/ultramodern-build.json',
        ),
      );
    },
    expectedContract: /catalog build stamp is missing/,
  },
  {
    workspaceName: 'missing-backend-config',
    mutate: (workspaceDir: string) => {
      fs.rmSync(
        path.join(
          workspaceDir,
          'verticals/catalog/backend-federation.config.ts',
        ),
      );
    },
    expectedContract:
      /catalog API surface is missing: verticals\/catalog\/backend-federation\.config\.ts/,
  },
] as const;

for (const scenario of validationDriftScenarios) {
  test(`generated MicroVertical validation rejects missing API and identity drift for ${scenario.workspaceName}`, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-self-check-'));
    try {
      const workspaceDir = path.join(tempRoot, scenario.workspaceName);
      await generateUltramodernWorkspace({
        targetDir: workspaceDir,
        packageName: scenario.workspaceName,
        modernVersion: '3.2.1',
        enableTailwind: true,
        packageSource: { strategy: 'workspace' },
      });
      linkInstalledEffectCompiler(workspaceDir);
      await addUltramodernVertical({
        workspaceRoot: workspaceDir,
        name: 'catalog',
        modernVersion: '3.2.1',
      });

      const passingResult = runGeneratedWorkspaceCheck(workspaceDir);
      assert.equal(passingResult.status, 0, commandOutput(passingResult));

      scenario.mutate(workspaceDir);
      const failingResult = runGeneratedWorkspaceCheck(workspaceDir);
      const output = commandOutput(failingResult);
      assert.notEqual(failingResult.status, 0, output);
      assert.match(output, scenario.expectedContract);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('generated validator accepts authored remote development URLs', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-custom-endpoints-'),
  );
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'custom-endpoints',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledEffectCompiler(workspaceDir);
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'catalog',
      modernVersion: '3.2.1',
    });
    const overlay = readJson(
      workspaceDir,
      'topology/local-overlays/development.json',
    );
    overlay.manifests.catalog =
      'https://preview.example.test/federation/catalog.json';
    overlay.apis.catalog = 'https://api.example.test/catalog';
    overlay.serverExecution.catalog.apiBaseUrl = overlay.apis.catalog;
    overlay.serverExecution.catalog.node.manifestUrl =
      'https://backend.example.test/manifest.json';
    overlay.serverExecution.catalog.node.containerEntry =
      'https://backend.example.test/entry.cjs';
    writeJson(
      workspaceDir,
      'topology/local-overlays/development.json',
      overlay,
    );
    const topology = readJson(workspaceDir, 'topology/reference-topology.json');
    const catalog = appById(topology.verticals, 'catalog');
    catalog.moduleFederation.manifestUrl = overlay.manifests.catalog;
    catalog.backendFederation.executionSurfaces.node.manifestUrl =
      overlay.serverExecution.catalog.node.manifestUrl;
    catalog.backendFederation.executionSurfaces.node.containerEntry =
      overlay.serverExecution.catalog.node.containerEntry;
    writeJson(workspaceDir, 'topology/reference-topology.json', topology);
    const result = runGeneratedWorkspaceCheck(workspaceDir);
    assert.equal(result.status, 0, commandOutput(result));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('UI-only vertical rejects a planted backend federation surface', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-ui-only-boundary-'),
  );
  const workspaceDir = path.join(tempRoot, 'workspace');
  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'ui-only-boundary',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledEffectCompiler(workspaceDir);
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'catalog',
      preset: 'ui-only',
      modernVersion: '3.2.1',
    });
    const passing = runGeneratedWorkspaceCheck(workspaceDir);
    assert.equal(passing.status, 0, commandOutput(passing));
    fs.writeFileSync(
      path.join(workspaceDir, 'verticals/catalog/backend-federation.config.ts'),
      'export default {}',
    );
    const failing = runGeneratedWorkspaceCheck(workspaceDir);
    assert.notEqual(failing.status, 0, commandOutput(failing));
    assert.match(
      commandOutput(failing),
      /Unexpected verticals\/catalog\/backend-federation\.config\.ts for a ui-only unit/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('generated API boundary check structurally rejects raw handler drift', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-api-check-'));
  const workspaceDir = path.join(tempRoot, 'api-check-workspace');

  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: 'api-check-workspace',
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledEffectCompiler(workspaceDir);
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      name: 'catalog',
      modernVersion: '3.2.1',
    });

    const passingResult = runGeneratedApiCheck(workspaceDir);
    assert.equal(passingResult.status, 0, commandOutput(passingResult));

    fs.writeFileSync(
      path.join(workspaceDir, 'verticals/catalog/api/index.ts'),
      `
import { createHandler } from '@modern-js/plugin-bff/server';

export const handler = async (request: Request) => {
  const body = await request.json();
  return Response.json(body);
};

export default async function fallback() {
  return new Response('legacy');
}

const runtimeFramework = 'hono';
const strictEffectApproach = false;
`,
      'utf-8',
    );

    fs.writeFileSync(
      path.join(workspaceDir, 'verticals/catalog/api/effect-api.ts'),
      `
export const backendFederationContract = {
 role: 'backend-remote',
 strictEffectApproach: false,
};

export const handler = async (request: Request) => Response.json(await request.json());
`,
      'utf-8',
    );

    const failingResult = runGeneratedApiCheck(workspaceDir);
    const output = commandOutput(failingResult);
    assert.notEqual(failingResult.status, 0, output);
    assert.match(output, /use Effect HttpApi instead of Hono helpers/);
    assert.match(output, /must not hand-build Response objects/);
    assert.match(
      output,
      /must use endpoint payload\/query\/params schemas instead of parsing request bodies/,
    );
    assert.match(output, /must not export raw request handlers/);
    assert.match(output, /must keep strictEffectApproach enabled/);
    assert.match(output, /must describe the MicroVertical server role/);
    assert.match(output, /must preserve strict Effect backend execution/);
    assert.match(output, /must preserve the server contract version/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('generated validator accepts an api-only (headless) workspace and rejects planted UI/MF artifacts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-profile-api-'));
  const workspaceDir = path.join(tempRoot, 'api-only-workspace');
  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceDir,
      packageName: path.basename(workspaceDir),
      modernVersion: '3.2.1',
      enableTailwind: true,
      packageSource: { strategy: 'workspace' },
    });
    linkInstalledEffectCompiler(workspaceDir);
    await addUltramodernVertical({
      workspaceRoot: workspaceDir,
      modernVersion: '3.2.1',
      name: 'headless',
      preset: 'api-only',
    });

    const topology = readJson(workspaceDir, 'topology/reference-topology.json');
    const backendFederation = appById(
      topology.verticals,
      'headless',
    ).backendFederation;

    const passing = runGeneratedWorkspaceCheck(workspaceDir);
    assert.equal(passing.status, 0, commandOutput(passing));

    const apiPassing = runGeneratedApiCheck(workspaceDir);
    assert.equal(apiPassing.status, 0, commandOutput(apiPassing));

    // An empty UI boundary is still a UI boundary. A headless API-only unit
    // must omit the branch itself, not merely its manifest URL.
    backendFederation.versionBoundary.ui = {};
    writeJson(workspaceDir, 'topology/reference-topology.json', topology);
    const failingUiBoundary = runGeneratedWorkspaceCheck(workspaceDir);
    const uiBoundaryOutput = commandOutput(failingUiBoundary);
    assert.notEqual(failingUiBoundary.status, 0, uiBoundaryOutput);
    assert.match(
      uiBoundaryOutput,
      /headless headless unit must omit UI federation declarations/,
    );
    delete backendFederation.versionBoundary.ui;
    writeJson(workspaceDir, 'topology/reference-topology.json', topology);

    // Planting a UI/MF artifact into a headless unit must be rejected.
    fs.writeFileSync(
      path.join(workspaceDir, 'verticals/headless/module-federation.config.ts'),
      'export default {};\n',
      'utf-8',
    );
    const failing = runGeneratedWorkspaceCheck(workspaceDir);
    const output = commandOutput(failing);
    assert.notEqual(failing.status, 0, output);
    assert.match(
      output,
      /Unexpected .*module-federation\.config\.ts for a api-only unit/,
    );
    fs.rmSync(
      path.join(workspaceDir, 'verticals/headless/module-federation.config.ts'),
    );

    // Widening the headless unit's Module Federation DTS boundary to a browser
    // federation entry it does not ship must be rejected (the api-only mf-types
    // boundary only covers the app ambient types).
    const mfTypes = readJson(
      workspaceDir,
      'verticals/headless/tsconfig.mf-types.json',
    );
    mfTypes.include = ['src/federation-entry.tsx', 'src/modern-app-env.d.ts'];
    writeJson(
      workspaceDir,
      'verticals/headless/tsconfig.mf-types.json',
      mfTypes,
    );
    const failingDts = runGeneratedWorkspaceCheck(workspaceDir);
    const dtsOutput = commandOutput(failingDts);
    assert.notEqual(failingDts.status, 0, dtsOutput);
    assert.match(
      dtsOutput,
      /restore the generated MicroVertical Module Federation DTS boundary/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
