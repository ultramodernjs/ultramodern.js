import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compilerBootstrapFixture } from './helpers/compiler-bootstrap';

const compilerPrepareScript = path.resolve(
  __dirname,
  '../templates/workspace-scripts/ultramodern-compiler-prepare.mjs',
);

test.each([
  { platformPackage: '@tsrs/darwin-arm64', tsrs: true, status: 0 },
  { platformPackage: '@tsrs/linux-x64-gnu', tsrs: true, status: 0 },
  { platformPackage: '@tsrs/linux-arm64-gnu', tsrs: true, status: 0 },
  { platformPackage: '@tsrs/linux-x64-musl', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/linux-arm64-musl', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/win32-x64', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/darwin-x64', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/win32-arm64', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/linux-arm-gnu', tsrs: false, status: 0 },
  { platformPackage: '@tsrs/darwin-arm64', tsrs: true, status: 37 },
])(
  'compiler bootstrap selects $platformPackage and preserves exit $status',
  ({ platformPackage, tsrs, status }) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'um-compiler-prepare-')),
    );
    try {
      const fixture = compilerBootstrapFixture(root, {
        platformPackage,
        compilerStatus: status,
      });
      assert.equal(fixture.manifest.version, '0.20.0-ts7.1.0-beta');
      assert.equal(
        Object.hasOwn(fixture.manifest.optionalDependencies, platformPackage),
        !['@tsrs/win32-arm64', '@tsrs/linux-arm-gnu'].includes(platformPackage),
      );
      const tsrsManifest = path.join(fixture.tsrsRoot, 'package.json');
      const before = fs.readFileSync(tsrsManifest);
      const result = spawnSync(process.execPath, [compilerPrepareScript], {
        // The environment's workspace root, not cwd, owns package selection.
        cwd: __dirname,
        encoding: 'utf8',
        env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: root },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(fs.readFileSync(tsrsManifest), before);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(fixture.compilerLog, 'utf8')),
        {
          args: [tsrs ? 'tsrs' : 'tsc', '--version'],
          cwd: root,
          execPath: process.execPath,
        },
      );
      assert.match(
        result.stdout,
        tsrs ? /Validating Effect-enabled tsrs/u : /using Effect-Go/u,
      );
      if (
        !tsrs &&
        Object.hasOwn(fixture.manifest.optionalDependencies, platformPackage)
      ) {
        assert.match(result.stdout, /does not provide a tsrs replacement/u);
      }
      if (status !== 0) {
        assert.match(result.stderr, /Effect compiler readiness failed/u);
        assert.doesNotMatch(result.stdout, /Effect-Go/u);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('broken tsrs platform metadata never selects Effect-Go', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-compiler-metadata-'));
  try {
    const fixture = compilerBootstrapFixture(root);
    const tsrsManifest = path.join(fixture.tsrsRoot, 'package.json');
    for (const manifest of [
      { ...fixture.manifest, optionalDependencies: {} },
      {
        ...fixture.manifest,
        optionalDependencies: { '@tsrs/darwin-arm64': '0.0.0' },
      },
    ]) {
      fs.writeFileSync(tsrsManifest, JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [compilerPrepareScript], {
        encoding: 'utf8',
        env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: root },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /Effect-Go/u);
      assert.equal(fs.existsSync(fixture.compilerLog), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unsupported Effect replacement host still rejects mismatched tsrs dependency metadata', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-compiler-invalid-host-'),
  );
  try {
    const fixture = compilerBootstrapFixture(root, {
      platformPackage: '@tsrs/win32-x64',
    });
    fixture.manifest.optionalDependencies['@tsrs/win32-x64'] = '0.0.0';
    fs.writeFileSync(
      path.join(fixture.tsrsRoot, 'package.json'),
      JSON.stringify(fixture.manifest),
    );
    const result = spawnSync(process.execPath, [compilerPrepareScript], {
      encoding: 'utf8',
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: root },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /tsrs platform dependency does not match/u);
    assert.equal(fs.existsSync(fixture.compilerLog), false);
    assert.doesNotMatch(result.stdout, /Effect-Go/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new provider version requires a reviewed bootstrap capability contract', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'um-compiler-provider-version-'),
  );
  try {
    const fixture = compilerBootstrapFixture(root, {
      platformPackage: '@tsrs/win32-x64',
    });
    const filename = path.join(root, 'node_modules/@effect/tsgo/package.json');
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    manifest.version = '0.60.0';
    fs.writeFileSync(filename, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [compilerPrepareScript], {
      encoding: 'utf8',
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: root },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unreviewed Effect tsrs capability contract/u);
    assert.equal(fs.existsSync(fixture.compilerLog), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
