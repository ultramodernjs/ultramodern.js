import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASELINE_DEPENDENCY_PINS,
  generateUltramodernWorkspace,
  OverlayBaselineRelaxationError,
} from '../src/ultramodern-workspace';
import {
  assertOverlayPreservedBaseline,
  captureOverlayBaselineSnapshot,
} from '../src/ultramodern-workspace/overlay-baseline-guard';

function writeOverlayGenerator(tempRoot: string, name: string, body: string) {
  const generatorDir = path.join(tempRoot, name);
  fs.mkdirSync(generatorDir, { recursive: true });
  fs.writeFileSync(
    path.join(generatorDir, 'package.json'),
    JSON.stringify({
      name: `test-${name}`,
      version: '0.0.0',
      main: './index.cjs',
    }),
  );
  fs.writeFileSync(path.join(generatorDir, 'index.cjs'), body);
  return generatorDir;
}

function generateWithOverlay(targetDir: string, generatorDir: string) {
  return generateUltramodernWorkspace({
    targetDir,
    packageName: path.basename(targetDir),
    modernVersion: '3.2.1',
    enableTailwind: true,
    overlays: [{ generator: generatorDir }],
    packageSource: { strategy: 'workspace' },
  });
}

async function assertRelaxationOverlay(
  tempRoot: string,
  name: string,
  mutation: string,
) {
  const generatorDir = writeOverlayGenerator(
    tempRoot,
    `${name}-overlay`,
    `
const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  const shellPkgPath = path.join(
    context.config.outputWorkspaceRoot,
    'apps/shell-super-app/package.json',
  );
  const shellPkg = JSON.parse(fs.readFileSync(shellPkgPath, 'utf-8'));
  ${mutation}
  fs.writeFileSync(shellPkgPath, JSON.stringify(shellPkg, null, 2));
};
`,
  );
  await assert.rejects(
    generateWithOverlay(path.join(tempRoot, name), generatorDir),
    (error: unknown) => {
      assert.ok(error instanceof OverlayBaselineRelaxationError, String(error));
      assert.ok(
        error.violations.some(
          violation =>
            violation.kind === 'baseline-version-relaxation' &&
            violation.detail.includes('react'),
        ),
        error.message,
      );
      return true;
    },
  );
}

test('overlay baseline guard keeps one rejection matrix and a neutral extension', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'um-overlay-guard-'));
  try {
    for (const [name, mutation] of [
      ['downgrade', "shellPkg.dependencies.react = '18.0.0';"],
      ['overrides', "shellPkg.overrides = { tooling: { react: '18.0.0' } };"],
    ] as const) {
      await assertRelaxationOverlay(tempRoot, name, mutation);
    }

    const neutralGenerator = writeOverlayGenerator(
      tempRoot,
      'neutral-overlay',
      `
const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  const outDir = path.join(context.config.outputWorkspaceRoot, 'overlay-output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ok.json'), JSON.stringify({ ok: true }));
};
`,
    );
    const targetDir = path.join(tempRoot, 'neutral');
    await generateWithOverlay(targetDir, neutralGenerator);
    assert.equal(
      fs.existsSync(path.join(targetDir, 'overlay-output/ok.json')),
      true,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace catalog baseline changes fail with a typed violation', () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-overlay-catalog-'),
  );
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const workspaceYamlPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(
      workspaceYamlPath,
      `catalog:\n  react: '${BASELINE_DEPENDENCY_PINS.react}'\n`,
    );
    const snapshot = captureOverlayBaselineSnapshot(workspaceRoot, []);
    fs.writeFileSync(workspaceYamlPath, "catalog:\n  react: '18.0.0'\n");

    assert.throws(
      () =>
        assertOverlayPreservedBaseline({
          workspaceRoot,
          generator: 'catalog-replacement-overlay',
          snapshot,
        }),
      (error: unknown) => {
        assert.ok(error instanceof OverlayBaselineRelaxationError);
        assert.ok(
          error.violations.some(
            violation => violation.path === 'pnpm-workspace.yaml#catalog.react',
          ),
          error.message,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('an overlay cannot replace admitted native Core with the registry build', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-native-core-overlay-'),
  );
  try {
    const generatorDir = writeOverlayGenerator(
      tempRoot,
      'registry-core-overlay',
      `
const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  const file = path.join(context.config.outputWorkspaceRoot, 'apps/shell-super-app/package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.dependencies['@tanstack/router-core'] = manifest.ultramodern.nativeArtifacts.packages['@tanstack/router-core'].version;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
};
`,
    );
    await assert.rejects(
      generateWithOverlay(path.join(tempRoot, 'workspace'), generatorDir),
      (error: unknown) => {
        assert.ok(
          error instanceof OverlayBaselineRelaxationError,
          String(error),
        );
        assert.ok(
          error.violations.some(
            violation =>
              violation.kind === 'baseline-version-relaxation' &&
              violation.detail.includes('@tanstack/router-core'),
          ),
          error.message,
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Octane pins TypeScript 7 while keeping its named AST tool separate', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-octane-ast-tool-'),
  );
  const workspaceRoot = path.join(tempRoot, 'workspace');
  try {
    await generateUltramodernWorkspace({
      targetDir: workspaceRoot,
      packageName: 'octane-ast-tool',
      modernVersion: '3.8.3',
      renderer: 'octane',
      enableTailwind: false,
      generateAgentFiles: false,
      packageSource: { strategy: 'workspace' },
    });
    const snapshot = captureOverlayBaselineSnapshot(workspaceRoot, [
      'apps/shell-super-app',
    ]);
    const options = {
      workspaceRoot,
      generator: 'native-ast-tool-overlay',
      snapshot,
    };
    assertOverlayPreservedBaseline(options);
    const manifestPath = path.join(workspaceRoot, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(
      manifest.devDependencies['@typescript/native'],
      'npm:typescript@7.0.2',
    );
    const appManifest = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, 'apps/shell-super-app/package.json'),
        'utf8',
      ),
    );
    assert.equal(appManifest.devDependencies.typescript, '7.0.2');
    assert.equal(
      appManifest.scripts.typecheck,
      'octane-tsc --noEmit --project tsconfig.json',
    );
    assert.equal(
      appManifest.dependencies['@modern-js/renderer-octane'],
      'workspace:*',
    );
    for (const group of ['dependencies', 'devDependencies']) {
      assert.equal(appManifest[group]?.['tsrx-tsc'], undefined);
      assert.equal(manifest[group]?.['tsrx-tsc'], undefined);
    }
    manifest.dependencies = {
      '@typescript/native': 'npm:typescript@7.0.2',
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assertOverlayPreservedBaseline(options);
    manifest.dependencies['@typescript/native'] = 'npm:typescript@7.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => assertOverlayPreservedBaseline(options),
      /alias "@typescript\/native".*typescript.*7\.0\.2/u,
    );
    delete manifest.dependencies;
    manifest.devDependencies.arbitraryCompiler = 'npm:typescript@7.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => assertOverlayPreservedBaseline(options),
      /alias "arbitraryCompiler".*typescript.*7\.0\.2/u,
    );
    delete manifest.devDependencies.arbitraryCompiler;
    manifest.devDependencies['@typescript/native'] = 'npm:typescript@7.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(
      () => assertOverlayPreservedBaseline(options),
      /@typescript\/native.*7\.0\.2/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
