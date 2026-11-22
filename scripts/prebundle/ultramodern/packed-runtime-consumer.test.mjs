import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import tsgoInvocation from '../../lib/tsgo-invocation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function discoverModernPackages() {
  const packages = new Map();
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        ['node_modules', 'dist', 'compiled', '.git'].includes(entry.name)
      )
        continue;
      const child = join(directory, entry.name);
      const packageJson = join(child, 'package.json');
      if (existsSync(packageJson)) {
        const manifest = readManifest(packageJson);
        if (manifest.name?.startsWith('@modern-js/'))
          packages.set(manifest.name, { directory: child, manifest });
      } else visit(child);
    }
  };
  visit(join(root, 'packages'));
  return packages;
}

function firstPartyClosure(packages) {
  const queue = ['@modern-js/runtime', '@modern-js/plugin-tanstack'];
  const result = new Map();
  while (queue.length > 0) {
    const name = queue.shift();
    if (result.has(name)) continue;
    const packageInfo = packages.get(name);
    assert.ok(packageInfo, `missing workspace package ${name}`);
    result.set(name, packageInfo);
    for (const dependencyBlock of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const dependency of Object.keys(
        packageInfo.manifest[dependencyBlock] ?? {},
      )) {
        if (dependency.startsWith('@modern-js/') && packages.has(dependency))
          queue.push(dependency);
      }
    }
  }
  return result;
}

function packPackage(packageInfo, tarballsDirectory) {
  const declaredEntries = [
    packageInfo.manifest.main,
    packageInfo.manifest.module,
    packageInfo.manifest.types,
  ].filter(entry => typeof entry === 'string');
  assert.ok(
    existsSync(join(packageInfo.directory, 'dist')) ||
      declaredEntries.some(entry =>
        existsSync(join(packageInfo.directory, entry)),
      ),
    `${packageInfo.manifest.name} has no built dist or declared package entry`,
  );
  const before = new Set(
    readdirSync(tarballsDirectory).filter(entry => entry.endsWith('.tgz')),
  );
  const result = spawnSync(
    pnpm,
    ['pack', '--pack-destination', tarballsDirectory],
    {
      cwd: packageInfo.directory,
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${packageInfo.manifest.name} pnpm pack failed\n${result.stdout}\n${result.stderr}`,
  );
  const created = readdirSync(tarballsDirectory).filter(
    entry => entry.endsWith('.tgz') && !before.has(entry),
  );
  assert.equal(
    created.length,
    1,
    `${packageInfo.manifest.name} pnpm pack did not create exactly one tarball`,
  );
  return join(tarballsDirectory, created[0]);
}

function installedVersion(name, fromDirectory) {
  const require = createRequire(join(fromDirectory, 'package.json'));
  const manifestPath = require.resolve(`${name}/package.json`);
  return readManifest(manifestPath).version;
}

function compile(consumerDirectory, configName) {
  const invocation = tsgoInvocation.createTsgoInvocation({
    requireFrom: createRequire(import.meta.url),
    args: ['--project', join(consumerDirectory, configName)],
  });
  const result = spawnSync(invocation.command, invocation.argv, {
    cwd: consumerDirectory,
    encoding: 'utf8',
    timeout: 120_000,
    shell: invocation.shell,
  });
  return {
    ...result,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function writeCompilerConfig(consumerDirectory, fileName, sourceFileName) {
  writeFileSync(
    join(consumerDirectory, fileName),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['DOM', 'ESNext'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noUncheckedSideEffectImports: true,
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2024',
          jsx: 'react-jsx',
          types: ['node', 'react', 'react-dom'],
        },
        include: [sourceFileName],
      },
      null,
      2,
    )}\n`,
  );
}

test('packed runtime registry and TanStack runtime declarations resolve for a TypeScript consumer', {
  skip:
    !process.env.ULTRAMODERN_RELEASE_LANE &&
    'release-lane only: performs a real pnpm pack + registry install',
}, () => {
  const fixture = realpathSync(
    mkdtempSync(join(tmpdir(), 'packed-runtime-consumer-')),
  );
  const tarballsDirectory = join(fixture, 'tarballs');
  const consumerDirectory = join(fixture, 'consumer');
  const packages = discoverModernPackages();
  const closure = firstPartyClosure(packages);

  try {
    mkdirSync(tarballsDirectory, { recursive: true });
    mkdirSync(consumerDirectory, { recursive: true });

    const tarballs = new Map();
    for (const [name, packageInfo] of closure)
      tarballs.set(name, packPackage(packageInfo, tarballsDirectory));

    const dependencies = Object.fromEntries(
      [...tarballs].map(([name, tarball]) => [
        name,
        `file:${relative(consumerDirectory, tarball)}`,
      ]),
    );
    const overrides = Object.fromEntries(
      [...tarballs].map(([name, tarball]) => [
        name,
        `file:${relative(consumerDirectory, tarball)}`,
      ]),
    );
    dependencies.react = installedVersion(
      'react',
      packages.get('@modern-js/plugin-tanstack').directory,
    );
    dependencies['react-dom'] = installedVersion(
      'react-dom',
      packages.get('@modern-js/plugin-tanstack').directory,
    );
    const devDependencies = {
      '@types/node': installedVersion(
        '@types/node',
        packages.get('@modern-js/plugin-tanstack').directory,
      ),
      '@types/react': installedVersion(
        '@types/react',
        packages.get('@modern-js/plugin-tanstack').directory,
      ),
      '@types/react-dom': installedVersion(
        '@types/react-dom',
        packages.get('@modern-js/plugin-tanstack').directory,
      ),
    };

    writeFileSync(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'packed-runtime-consumer',
          private: true,
          type: 'module',
          dependencies,
          devDependencies,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(consumerDirectory, 'pnpm-workspace.yaml'),
      stringify({
        packages: ['.'],
        overrides,
        minimumReleaseAge: 0,
      }),
    );

    const install = spawnSync(
      pnpm,
      [
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--prefer-offline',
        '--config.auto-install-peers=false',
      ],
      {
        cwd: consumerDirectory,
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
    assert.equal(
      install.status,
      0,
      `packed consumer install failed\n${install.stdout}\n${install.stderr}`,
    );
    const lockfile = parse(
      readFileSync(join(consumerDirectory, 'pnpm-lock.yaml'), 'utf8'),
    );
    assert.deepEqual(
      lockfile.overrides,
      overrides,
      'pnpm must apply every packed workspace package override',
    );
    assert.equal(lockfile.settings.autoInstallPeers, false);

    writeFileSync(
      join(consumerDirectory, 'positive.ts'),
      `import '@modern-js/runtime/registry';
import '@modern-js/runtime/registry/shell';
import {
  getModernTanstackRouterFastDefaults,
  Link,
  NavLink,
  Outlet,
  tanstackRouterPlugin,
  type RouterConfig,
} from '@modern-js/plugin-tanstack/runtime';

const config: RouterConfig = { routesConfig: { routes: [] } };
const defaults = getModernTanstackRouterFastDefaults(config);
const plugin = tanstackRouterPlugin(config);
const components: [typeof Link, typeof NavLink, typeof Outlet] = [
  Link,
  NavLink,
  Outlet,
];

void defaults;
void plugin;
void components;
`,
    );
    writeCompilerConfig(
      consumerDirectory,
      'tsconfig-positive.json',
      'positive.ts',
    );
    const positive = compile(consumerDirectory, 'tsconfig-positive.json');
    assert.equal(positive.status, 0, positive.output);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
