import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePnpmLockfile } from '../../scripts/lib/parse-pnpm-lockfile.mjs';
import { inspectNpmTarball } from '../../scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import { startSidecarRegistry } from '../../scripts/ultramodern-publish/qualify-sidecar-bundle.mjs';
import {
  assertPackedRegistrySidecars,
  bleedingdevOverrides,
  reboundRegistryOverrides,
} from './generatedWorkspaceDependencies';
import {
  bleedingdevEdges,
  packTestSidecars,
  runPnpmAsync,
} from './runWithPrerequisites.mjs';

const recipes: Array<{ fork: { name: string; version: string } }> = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../scripts/ultramodern-supply/sidecars.json'),
    'utf8',
  ),
);

test('the harness packs exactly the sidecars the release publishes', async () => {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modern-test-sidecars-'),
  );
  try {
    const packed: Record<
      string,
      { tarball: string; version: string; integrity: string }
    > = await packTestSidecars(outputDir);
    expect(
      Object.fromEntries(
        Object.entries(packed).map(([name, { version }]) => [name, version]),
      ),
    ).toEqual(
      Object.fromEntries(recipes.map(({ fork }) => [fork.name, fork.version])),
    );
    for (const { tarball } of Object.values(packed)) {
      expect(fs.statSync(tarball).isFile()).toBe(true);
    }
    const braces = packed['@bleedingdev/braces'];
    const bytes = fs.readFileSync(braces.tarball);
    const registry = await startSidecarRegistry([
      {
        name: '@bleedingdev/braces',
        version: braces.version,
        packageJson: JSON.parse(
          inspectNpmTarball(bytes).packageJsonBytes.toString('utf8'),
        ),
        bytes,
        integrity:
          'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        shasum: createHash('sha1').update(bytes).digest('hex'),
      },
    ]);
    try {
      const consumer = path.join(outputDir, 'consumer');
      fs.mkdirSync(consumer);
      fs.writeFileSync(
        path.join(consumer, 'package.json'),
        JSON.stringify({
          name: 'native-override-consumer',
          private: true,
          dependencies: { braces: '3.0.3' },
        }),
      );
      fs.writeFileSync(
        path.join(consumer, '.npmrc'),
        '@bleedingdev:registry=' + registry.registryUrl + '\n',
      );
      const policy =
        "packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\ntrustPolicy: no-downgrade\ntrustPolicyIgnoreAfter: 1440\nminimumReleaseAgeExclude:\n  - '@bleedingdev/braces@" +
        braces.version +
        "'\nverifyDepsBeforeRun: error\npackageImportMethod: clone-or-copy\noverrides:\n  'braces@>=3.0.0 <3.0.4': 'npm:@bleedingdev/braces@" +
        braces.version +
        "'\n  'sharp@>=0.35.0 <0.35.5': '0.35.5'\n";
      fs.writeFileSync(path.join(consumer, 'pnpm-workspace.yaml'), policy);
      await runPnpmAsync(['install', '--ignore-scripts'], {
        cwd: consumer,
        stdio: 'pipe',
        env: { ...process.env, CI: 'true' },
      });
      const lock = parsePnpmLockfile(
        fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8'),
      );
      assertPackedRegistrySidecars(lock.packages, packed, registry.registryUrl);
      expect(
        fs.readFileSync(path.join(consumer, 'pnpm-workspace.yaml'), 'utf8'),
      ).toBe(policy);
      const installedRoot = fs.realpathSync(
        path.join(consumer, 'node_modules/braces'),
      );
      expect(
        installedRoot.startsWith(fs.realpathSync(consumer) + path.sep),
      ).toBe(true);
      for (const [file, expected] of inspectNpmTarball(bytes).fileContents) {
        const installed = path.join(installedRoot, file);
        expect(fs.lstatSync(installed).isFile()).toBe(true);
        expect(fs.readFileSync(installed).equals(expected)).toBe(true);
      }
      await runPnpmAsync(
        ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
        { cwd: consumer, stdio: 'pipe', env: { ...process.env, CI: 'true' } },
      );
      for (const version of ['0.0.0', '99.0.0']) {
        fs.writeFileSync(
          path.join(consumer, 'pnpm-workspace.yaml'),
          policy.replace('braces@' + braces.version, 'braces@' + version),
        );
        await expect(
          runPnpmAsync(['install', '--lockfile-only', '--ignore-scripts'], {
            cwd: consumer,
            stdio: 'pipe',
            env: { ...process.env, CI: 'true' },
          }),
        ).rejects.toThrow();
      }
      fs.writeFileSync(path.join(consumer, 'pnpm-workspace.yaml'), policy);
      fs.rmSync(path.join(consumer, '.npmrc'));
      await registry.stop();
      expect(registry.isClosed()).toBe(true);
      await runPnpmAsync(
        [
          '--offline',
          'exec',
          process.execPath,
          '-e',
          `require('node:assert/strict').deepEqual(
            [require('braces/package.json').name, require('braces/package.json').version],
            ['@bleedingdev/braces', ${JSON.stringify(braces.version)}]
          );`,
        ],
        { cwd: consumer, stdio: 'pipe', env: { ...process.env, CI: 'true' } },
      );
      await runPnpmAsync(
        ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'],
        { cwd: consumer, stdio: 'pipe', env: { ...process.env, CI: 'true' } },
      );
    } finally {
      await registry.stop();
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}, 300_000);

test('npm aliases onto @bleedingdev resolve to packed tarballs by alias key', () => {
  const edges = bleedingdevEdges({
    dependencies: {
      '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.1',
      react: '19.2.0',
    },
    devDependencies: { '@bleedingdev/ipx': '3.2.2' },
  });
  expect(
    bleedingdevOverrides(edges, {
      '@bleedingdev/mf-runtime': {
        tarball: '/packed/mf-runtime.tgz',
        version: '2.9.1',
        integrity: '',
      },
      '@bleedingdev/ipx': {
        tarball: '/packed/ipx.tgz',
        version: '3.2.2',
        integrity: '',
      },
    }),
  ).toEqual({
    '@module-federation/runtime@npm:@bleedingdev/mf-runtime@2.9.1':
      'file:/packed/mf-runtime.tgz',
    '@bleedingdev/ipx@3.2.2': 'file:/packed/ipx.tgz',
  });
});

test('a listed previous Redact fork installs the packed recipe fork under its own alias key', () => {
  const sidecars = {
    '@bleedingdev/tanstack-redact': {
      tarball: '/packed/tanstack-redact.tgz',
      version: '0.2.2',
      integrity: '',
    },
  };
  const previous = bleedingdevEdges({
    dependencies: {
      '@tanstack/redact': 'npm:@bleedingdev/tanstack-redact@0.2.1',
    },
  });
  expect(previous).toEqual([
    {
      name: '@tanstack/redact',
      spec: 'npm:@bleedingdev/tanstack-redact@0.2.1',
      target: '@bleedingdev/tanstack-redact',
      version: '0.2.2',
    },
  ]);
  expect(bleedingdevOverrides(previous, sidecars)).toEqual({
    '@tanstack/redact@npm:@bleedingdev/tanstack-redact@0.2.1':
      'file:/packed/tanstack-redact.tgz',
  });
  expect(reboundRegistryOverrides(previous)).toEqual({
    '@tanstack/redact@npm:@bleedingdev/tanstack-redact@0.2.1':
      'npm:@bleedingdev/tanstack-redact@0.2.2',
  });
  expect(
    reboundRegistryOverrides(
      bleedingdevEdges({
        dependencies: {
          '@module-federation/runtime': 'npm:@bleedingdev/mf-runtime@2.9.3',
        },
        devDependencies: { '@bleedingdev/ipx': '3.2.2' },
      }),
    ),
  ).toEqual({});
  const unlisted = bleedingdevEdges({
    dependencies: {
      '@tanstack/redact': 'npm:@bleedingdev/tanstack-redact@0.2.0',
    },
  });
  expect(() => bleedingdevOverrides(unlisted, sidecars)).toThrow(
    'packed @bleedingdev/tanstack-redact: 0.2.2',
  );
});

test('an unpacked @bleedingdev dependency names the supply manifest to fix', () => {
  const edges = bleedingdevEdges({
    dependencies: {
      '@module-federation/node': 'npm:@bleedingdev/mf-node@2.7.51',
    },
  });
  expect(() => bleedingdevOverrides(edges, {})).toThrow(
    'Add it to scripts/ultramodern-supply/sidecars.json / staged cohort',
  );
  expect(() =>
    bleedingdevOverrides(edges, {
      '@bleedingdev/mf-node': {
        tarball: '/packed/mf-node.tgz',
        version: '2.7.50',
        integrity: '',
      },
    }),
  ).toThrow('packed @bleedingdev/mf-node: 2.7.50');
});

test('registry lock evidence rejects changed bytes, foreign registries and unaccepted versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-registry-lock-'));
  try {
    const tarball = path.join(root, 'braces.tgz');
    const bytes = Buffer.from('authenticated packed sidecar');
    fs.writeFileSync(tarball, bytes);
    const sidecars = {
      '@bleedingdev/braces': {
        tarball,
        version: '3.0.4',
        integrity: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const registry = 'http://127.0.0.1:12345/';
    const entry = {
      resolution: {
        tarball: registry + 'tarballs/%40bleedingdev%2Fbraces.tgz',
        integrity:
          'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      },
    };
    const key = '@bleedingdev/braces@3.0.4';
    expect(() =>
      assertPackedRegistrySidecars({ [key]: entry }, sidecars, registry),
    ).not.toThrow();
    expect(() =>
      assertPackedRegistrySidecars(
        { '@bleedingdev/braces@3.0.3': entry },
        sidecars,
        registry,
      ),
    ).toThrow('unaccepted sidecar');
    expect(() =>
      assertPackedRegistrySidecars({ [key]: entry }, {}, registry),
    ).toThrow('unaccepted sidecar');
    expect(() =>
      assertPackedRegistrySidecars(
        {
          [key]: {
            resolution: {
              ...entry.resolution,
              tarball: 'https://registry.npmjs.org/braces.tgz',
            },
          },
        },
        sidecars,
        registry,
      ),
    ).toThrow('escaped its packed registry');
    expect(() =>
      assertPackedRegistrySidecars(
        {
          [key]: {
            resolution: { ...entry.resolution, integrity: 'sha512-wrong' },
          },
        },
        sidecars,
        registry,
      ),
    ).toThrow('integrity drift');
    fs.writeFileSync(tarball, 'changed after preparation');
    expect(() =>
      assertPackedRegistrySidecars({ [key]: entry }, sidecars, registry),
    ).toThrow('Packed prerequisite changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
