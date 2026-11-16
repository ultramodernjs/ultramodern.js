import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseSync } from '@babel/core';

const execute = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageNames = ['@modern-js/renderer-core', '@modern-js/renderer-solid'];

export const admissionTuple = Object.freeze({
  'solid-js': '2.0.0-rc.22',
  '@solidjs/web': '2.0.0-rc.22',
  '@solidjs/signals': '2.0.0-rc.22',
  '@solidjs/compiler': '2.0.0-rc.22',
  '@rsbuild/core': '2.3.2',
  '@rspack/core': '2.3.2',
  '@babel/core': '8.1.2',
  playwright: '1.65.1',
  typescript: '7.0.2',
  seroval: '1.8.1',
  'seroval-plugins': '1.8.0',
  isbot: '5.2.3',
});

// The authored owner's authenticated native descriptor is the only accepted
// router-core artifact; packed owners must carry it unchanged.
const ownerNativeArtifacts = JSON.parse(
  readFileSync(
    path.join(workspaceRoot, 'packages/runtime/renderer-solid/package.json'),
    'utf8',
  ),
).ultramodern.nativeArtifacts;
export const acceptedRouter = Object.freeze(
  ownerNativeArtifacts.packages['@tanstack/router-core'],
);

/** Read only the generator's two literal, bounded serializer corrections. */
export function admissionSerializerOverrides(source) {
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['typescript'] },
  });
  const declaration = ast.program.body
    .flatMap(node =>
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'VariableDeclaration'
        ? node.declaration.declarations
        : [],
    )
    .find(node => node.id.name === 'ULTRAMODERN_WORKSPACE_POLICY');
  const property = (object, key) => {
    const matches =
      object?.properties?.filter(
        node =>
          node.type === 'ObjectProperty' &&
          !node.computed &&
          (node.key.name ?? node.key.value) === key,
      ) ?? [];
    assert.equal(
      matches.length,
      1,
      `Ambiguous or missing generator serializer policy: ${key}`,
    );
    return matches[0].value;
  };
  const policy = declaration?.init;
  const overrides = property(
    property(
      policy?.type === 'TSAsExpression' ? policy.expression : policy,
      'pnpm',
    ),
    'overrides',
  );
  return Object.fromEntries(
    ['seroval@>=1.0.0 <1.8.1', 'seroval-plugins@>=1.0.0 <1.8.0'].map(
      selector => {
        const value = property(overrides, selector);
        assert.equal(
          value?.type,
          'StringLiteral',
          `Missing literal generator serializer policy: ${selector}`,
        );
        assert.equal(
          value.value,
          admissionTuple[selector.split('@')[0]],
          `Generator serializer policy drift: ${selector}`,
        );
        return [selector, value.value];
      },
    ),
  );
}

export function assertNativeRendererManifest(manifest) {
  assert.equal(manifest.name, '@modern-js/renderer-solid');
  assert.equal(manifest.version, '3.8.3');
  assert.equal(manifest.dependencies['@tanstack/router-core'], undefined);
  assert.equal(
    manifest.peerDependencies['@tanstack/router-core'],
    acceptedRouter.version,
  );
  assert.deepEqual(manifest.ultramodern.nativeArtifacts, ownerNativeArtifacts);
  assert.equal(manifest.dependencies['@tanstack/history'], '1.162.5');
  assert.equal(manifest.dependencies.isbot, admissionTuple.isbot);
  for (const name of [
    'solid-js',
    '@solidjs/web',
    '@solidjs/signals',
    '@solidjs/compiler',
  ])
    assert.equal(
      manifest.dependencies[name] ?? manifest.peerDependencies[name],
      admissionTuple[name],
      name,
    );
  for (const name of ['seroval', 'seroval-plugins', '@tanstack/solid-router'])
    assert.equal(manifest.dependencies[name], undefined);
}

/** Local tarballs are transport for unpublished owning packages. Native package
 * versions and peer constraints remain exactly those authored by their producer. */
export async function prepareRendererPackages(
  consumerDirectory,
  pnpm,
  runCommand = execute,
) {
  const packageManifest = process.env.MODERN_TEST_PACKAGE_MANIFEST;
  const tarballs = {};
  if (packageManifest) {
    const { packages } = JSON.parse(await readFile(packageManifest, 'utf8'));
    for (const name of packageNames) {
      const packed = packages?.[name];
      assert.ok(
        packed?.tarball && packed.integrity,
        `Packed prerequisite missing ${name}`,
      );
      const digest = createHash('sha256')
        .update(await readFile(packed.tarball))
        .digest('hex');
      assert.equal(
        digest,
        packed.integrity,
        `Packed prerequisite changed: ${name}`,
      );
      tarballs[name] = path.resolve(packed.tarball);
    }
  } else {
    const destination = path.join(consumerDirectory, 'packed');
    await mkdir(destination);
    for (const name of packageNames) {
      const packageDirectory = path.join(
        workspaceRoot,
        'packages/runtime',
        name.slice('@modern-js/'.length),
      );
      const manifest = JSON.parse(
        await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
      );
      const required = new Set([manifest.main, manifest.types]);
      const targets =
        manifest.exports[
          name === '@modern-js/renderer-solid' ? './router' : '.'
        ];
      const collect = target => {
        if (typeof target === 'string') {
          required.add(target);
          return;
        }
        for (const [condition, value] of Object.entries(target ?? {})) {
          if (condition !== 'modern:source') collect(value);
        }
      };
      collect(targets);
      for (const filename of required) {
        assert.ok(
          typeof filename === 'string' && filename.startsWith('./dist/'),
          `Invalid ${name} public build export: ${filename}`,
        );
        await access(path.join(packageDirectory, filename)).catch(() => {
          throw new Error(
            `Build ${name} before admission; missing ${filename}`,
          );
        });
      }
      await runCommand(pnpm, ['pack', '--pack-destination', destination], {
        cwd: packageDirectory,
        maxBuffer: 4 * 1024 * 1024,
      });
      const filename = `${name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
      tarballs[name] = path.join(destination, filename);
      await access(tarballs[name]);
    }
  }
  // Transport unpublished owners and inherit only the generator's bounded
  // serializer corrections. Native Solid/router requests remain unchanged.
  const serializerOverrides = admissionSerializerOverrides(
    await readFile(
      path.join(
        workspaceRoot,
        'packages/toolkit/ultramodern-create/src/ultramodern-workspace/policy.ts',
      ),
      'utf8',
    ),
  );
  await writeFile(
    path.join(consumerDirectory, 'pnpm-workspace.yaml'),
    JSON.stringify({
      packages: [],
      overrides: {
        ...Object.fromEntries(
          Object.entries(tarballs).map(([name, tarball]) => [
            name,
            `file:${tarball}`,
          ]),
        ),
        ...serializerOverrides,
      },
    }),
  );
  return Object.fromEntries(
    await Promise.all(
      Object.entries(tarballs).map(async ([name, tarball]) => [
        name,
        createHash('sha256')
          .update(await readFile(tarball))
          .digest('hex'),
      ]),
    ),
  );
}

export async function assertNativePackageGraph(consumerDirectory) {
  const resolve = createRequire(path.join(consumerDirectory, 'package.json'));
  const root = `${await realpath(consumerDirectory)}${path.sep}`;
  const router = await realpath(
    resolve.resolve('@modern-js/renderer-solid/router'),
  );
  assert.ok(
    router.startsWith(root),
    'Native router escaped the clean-room consumer',
  );
  assert.ok(
    !router.split(path.sep).includes('src'),
    'Native router selected authored source instead of built exports',
  );
  const manifest = JSON.parse(
    await readFile(
      resolve.resolve('@modern-js/renderer-solid/package.json'),
      'utf8',
    ),
  );
  assertNativeRendererManifest(manifest);
  const nativeResolve = createRequire(router);
  const versions = {};
  async function installedManifest(name, resolver) {
    let current = path.dirname(await realpath(resolver.resolve(name)));
    while (current.startsWith(root)) {
      try {
        const candidate = JSON.parse(
          await readFile(path.join(current, 'package.json'), 'utf8'),
        );
        if (candidate.name === name)
          return { manifest: candidate, directory: current };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      current = path.dirname(current);
    }
    throw new Error(`Installed native package escaped the consumer: ${name}`);
  }
  for (const [name, expected] of Object.entries({
    'solid-js': admissionTuple['solid-js'],
    '@solidjs/web': admissionTuple['@solidjs/web'],
    '@solidjs/signals': admissionTuple['@solidjs/signals'],
    '@tanstack/router-core': acceptedRouter.version,
    '@tanstack/history': '1.162.5',
    isbot: admissionTuple.isbot,
  })) {
    const installed = await installedManifest(name, nativeResolve);
    assert.equal(
      installed.manifest.version,
      expected,
      `Native version drift: ${name}`,
    );
    versions[name] = installed.manifest.version;
  }
  for (const [name, expected] of Object.entries({
    '@solidjs/compiler': admissionTuple['@solidjs/compiler'],
    '@rsbuild/core': admissionTuple['@rsbuild/core'],
    '@babel/core': admissionTuple['@babel/core'],
    playwright: admissionTuple.playwright,
    typescript: admissionTuple.typescript,
  })) {
    const installed = await installedManifest(name, resolve);
    assert.equal(
      installed.manifest.version,
      expected,
      `Compiler host version drift: ${name}`,
    );
    versions[name] = installed.manifest.version;
  }
  const rsbuild = await installedManifest('@rsbuild/core', resolve);
  const rsbuildResolve = createRequire(
    path.join(rsbuild.directory, 'package.json'),
  );
  const rspack = await installedManifest('@rspack/core', rsbuildResolve);
  assert.equal(
    rspack.manifest.version,
    admissionTuple['@rspack/core'],
    'Rspack version drift',
  );
  versions['@rspack/core'] = rspack.manifest.version;
  const core = await installedManifest('@tanstack/router-core', nativeResolve);
  // Solid's hydration writer and its plugins must use one native serializer.
  // The router's separate HTTP/SSR codec is checked below, not shared with it.
  const web = await installedManifest('@solidjs/web', nativeResolve);
  const webResolve = createRequire(path.join(web.directory, 'package.json'));
  for (const name of ['seroval', 'seroval-plugins']) {
    const installed = await installedManifest(name, webResolve);
    assert.equal(
      installed.manifest.version,
      admissionTuple[name],
      `${name} version drift`,
    );
    versions[name] = installed.manifest.version;
  }
  const serializer = await realpath(webResolve.resolve('seroval'));
  const serializerPlugins = await realpath(
    webResolve.resolve('seroval-plugins/web'),
  );
  const signals = await realpath(nativeResolve.resolve('@solidjs/signals'));
  for (const name of ['solid-js', '@solidjs/web']) {
    const installed = await installedManifest(name, nativeResolve);
    const nativePackageResolve = createRequire(
      path.join(installed.directory, 'package.json'),
    );
    assert.equal(
      await realpath(nativePackageResolve.resolve('seroval')),
      serializer,
      `${name} resolved a different native Seroval instance`,
    );
    assert.equal(
      await realpath(nativePackageResolve.resolve('seroval-plugins/web')),
      serializerPlugins,
      `${name} resolved different native serializer plugins`,
    );
  }
  const solid = await installedManifest('solid-js', nativeResolve);
  assert.equal(
    await realpath(
      createRequire(path.join(solid.directory, 'package.json')).resolve(
        '@solidjs/signals',
      ),
    ),
    signals,
    'Solid resolved a different signals instance',
  );
  assert.equal(
    await realpath(createRequire(serializerPlugins).resolve('seroval')),
    serializer,
    'Native serializer plugins resolved a different Seroval instance',
  );
  const coreResolve = createRequire(path.join(core.directory, 'package.json'));
  const plugin = await installedManifest('seroval-plugins', coreResolve);
  assert.equal(
    plugin.manifest.version,
    admissionTuple['seroval-plugins'],
    'Router HTTP serializer plugins version drift',
  );
  const pluginResolve = createRequire(
    path.join(plugin.directory, 'package.json'),
  );
  assert.equal(
    (await installedManifest('seroval', pluginResolve)).manifest.version,
    admissionTuple.seroval,
    'Router HTTP serializer plugin version drift',
  );
  assert.equal(
    (await installedManifest('seroval', coreResolve)).manifest.version,
    admissionTuple.seroval,
    'Router HTTP serializer version drift',
  );
  const installed = await readdir(
    path.join(consumerDirectory, 'node_modules/.pnpm'),
  );
  for (const name of installed) {
    assert.doesNotMatch(
      name,
      /^(?:solid-js@1\.|@tanstack\+solid-router@|@solid-devtools\+|@solid-primitives\+|react@|react-dom@)/u,
      `Native dependency graph contains an unrelated or obsolete runtime: ${name}`,
    );
  }
  return {
    owningPackage: `${manifest.name}@${manifest.version}`,
    routerEntry: path.relative(root, router),
    versions,
  };
}
