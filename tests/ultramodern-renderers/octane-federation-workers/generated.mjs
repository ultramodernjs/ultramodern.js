#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createOctaneWorkerFederationFixtures } from './fixtures.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** These are ordinary authored import/service coordinates, never renderer identities. */
export const generatedWorkerCoordinates = Object.freeze({
  host: {
    id: 'shell-super-app',
    directory: 'apps/shell-super-app',
    moduleFederationName: 'shellSuperApp',
  },
  remotes: ['remote-a', 'remote-b'].map((id, index) => ({
    id,
    directory: `verticals/${id}`,
    moduleFederationName: `verticalRemote${index ? 'B' : 'A'}`,
    exposes: {
      './Route': './src/federation-entry.tsx',
      './Widget': `./src/components/${id}-widget.tsx`,
    },
  })),
});

/** Let the public workspace topology own host bindings; author only the extra remote hop. */
export function generatedWorkerDeploymentInput(app, services) {
  return {
    worker: {
      name: `proof-${app.id}`,
      ssr: true,
      ...(app.id === generatedWorkerCoordinates.host.id
        ? {}
        : {
            services:
              app.id === generatedWorkerCoordinates.remotes[0].id
                ? services.remoteA
                : [],
          }),
    },
  };
}

/** Explicitly opt authored host routes into the topology-owned Worker bindings. */
export function authorGeneratedWorkerRoutes(config, remotes) {
  if (remotes.length === 0) return config;
  const services = config.deploy?.worker?.services ?? [];
  for (const remote of remotes) {
    if (
      services.filter(service => service.service === `proof-${remote.id}`)
        .length !== 1
    )
      throw new Error(
        `Expected one topology-owned Worker binding for ${remote.id}.`,
      );
  }
  return {
    ...config,
    deploy: {
      ...config.deploy,
      worker: {
        ...config.deploy?.worker,
        services: services.map(service => {
          const remote = remotes.find(
            value => service.service === `proof-${value.id}`,
          );
          if (!remote) return service;
          return {
            ...service,
            fragments: [
              ...(service.fragments ?? []),
              {
                remote: remote.id,
                boundaryId: remote.moduleFederationName,
                expose: './Route',
                path: '/{locale}/_mf/fragment/route',
              },
            ],
          };
        }),
      },
    },
  };
}

/** CodeSmith calls this while authoring, before the generator captures native identities. */
export function authorGeneratedWorkerApplication(config) {
  const { outputWorkspaceRoot, generatedApp, origins, services, dependencies } =
    config;
  assert.equal(generatedApp.renderer, 'octane');
  const coordinates = [
    generatedWorkerCoordinates.host,
    ...generatedWorkerCoordinates.remotes,
  ];
  const selected = coordinates.find(app => app.id === generatedApp.id);
  assert(
    selected,
    'The public generator returned an undeclared proof application.',
  );
  for (const key of ['directory', 'moduleFederationName'])
    assert.equal(
      generatedApp[key],
      selected[key],
      `The generated ${key} differs from the authored topology.`,
    );
  const manifest = readJson(
    path.join(outputWorkspaceRoot, generatedApp.directory, 'package.json'),
  );
  const descriptor = coordinate => ({
    ...coordinate,
    renderer: 'octane',
    packageName:
      coordinate.id === generatedApp.id
        ? generatedApp.packageName
        : `@authored-coordinate/${coordinate.id}`,
    manifest:
      coordinate.id === generatedApp.id
        ? manifest
        : {
            name: `@authored-coordinate/${coordinate.id}`,
            modernjs: { appId: coordinate.id },
          },
  });
  const fixtures = createOctaneWorkerFederationFixtures({
    host: descriptor(generatedWorkerCoordinates.host),
    remotes: generatedWorkerCoordinates.remotes.map(descriptor),
    remoteOrigins: origins.slice(1),
    services: services.host,
    remoteServices: { 'remote-a': services.remoteA },
    dependencies: { ...manifest.dependencies, ...dependencies },
  });
  const application = fixtures.applications.find(
    item => item.app.id === generatedApp.id,
  );
  assert(application);
  // Keep the public generator's dependency, strict TypeScript and identity projections.
  // Only authored app input enters its normal overlay/finalization pipeline.
  for (const [relative, contents] of Object.entries(application.files)) {
    if (relative === 'package.json' || relative === 'tsconfig.json') continue;
    const destination = path.join(
      outputWorkspaceRoot,
      generatedApp.directory,
      relative,
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const authoredConfig =
      relative === 'modern.config.ts'
        ? `import { defineConfig, i18nPlugin, presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';\n${authorGeneratedWorkerRoutes.toString().replace('(config, remotes)', '(config: ReturnType<typeof presetUltramodernWorkspace>, remotes: Array<{ id: string; moduleFederationName: string }>)')}\nconst config = presetUltramodernWorkspace({ renderer: 'octane', server: { ssr: true }, source: { mainEntryName: 'main' }, deploy: ${JSON.stringify(generatedWorkerDeploymentInput(selected, services))}, plugins: [i18nPlugin({ localeDetection: { languages: ['en', 'cs'], fallbackLanguage: 'en' } })] }, { appId: ${JSON.stringify(selected.id)}, from: import.meta.url, deployTarget: 'cloudflare' });\nexport default defineConfig(authorGeneratedWorkerRoutes(config, ${JSON.stringify(selected.id === generatedWorkerCoordinates.host.id ? generatedWorkerCoordinates.remotes : [])}));\n`
        : contents;
    fs.writeFileSync(destination, authoredConfig);
  }
  const shared = path.join(outputWorkspaceRoot, 'shared/Counter.tsx');
  if (config.operation === 'workspace') {
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, fixtures.shared['Counter.tsx']);
  } else {
    assert.equal(config.operation, 'vertical');
    assert(
      fs.statSync(shared).isFile(),
      'The workspace must already own its Counter source.',
    );
  }
  const addedDependencies = { ...manifest.dependencies };
  for (const name of [
    '@modern-js/renderer-core',
    '@modern-js/i18n-runtime-extensions',
    'i18next',
  ]) {
    assert(dependencies[name], `The installed candidate is missing ${name}.`);
    if (addedDependencies[name]) {
      const declared = addedDependencies[name];
      let resolved = declared;
      if (declared.startsWith('catalog:')) {
        const workspace = parseYaml(
          fs.readFileSync(
            path.join(outputWorkspaceRoot, 'pnpm-workspace.yaml'),
            'utf8',
          ),
        );
        const catalog = declared.slice('catalog:'.length);
        resolved = catalog
          ? workspace.catalogs?.[catalog]?.[name]
          : workspace.catalog?.[name];
      }
      assert.equal(
        resolved,
        dependencies[name],
        `Generated ${name} must resolve to the authenticated candidate request.`,
      );
    } else addedDependencies[name] = dependencies[name];
  }
  fs.writeFileSync(
    path.join(outputWorkspaceRoot, generatedApp.directory, 'package.json'),
    `${JSON.stringify({ ...manifest, dependencies: addedDependencies }, null, 2)}\n`,
  );
}

/** Run only the installed generator's public API. No generated path is rewritten afterward. */
export async function generateWorkerWorkspace(input) {
  assert(
    !fs.existsSync(input.workspaceRoot),
    'Generate into a fresh owned workspace.',
  );
  const request = createRequire(
    path.join(input.generatorConsumerRoot, 'package.json'),
  );
  const apiEntry = request.resolve(
    `${input.generatorName}/ultramodern-workspace`,
  );
  const imported = await import(pathToFileURL(apiEntry).href);
  const api = imported.default ?? imported;
  const overlay = [
    {
      generator: input.overlayRoot,
      config: {
        origins: input.origins,
        services: input.services,
        dependencies: input.dependencies,
      },
    },
  ];
  const options = {
    modernVersion: input.version,
    overlays: overlay,
    packageSource: {
      strategy: 'install',
      modernPackageVersion: input.version,
      aliasScope: input.targetScope,
      aliasPackageNamePrefix: 'modern-js-',
    },
  };
  const host = await api.generateUltramodernWorkspace({
    ...options,
    targetDir: input.workspaceRoot,
    packageName: 'generated-worker-federation',
    renderer: 'octane',
    generateAgentFiles: false,
    enableTailwind: false,
  });
  const remoteA = await api.addUltramodernVertical({
    ...options,
    workspaceRoot: input.workspaceRoot,
    name: 'remote-a',
    horizontalRemote: true,
    enableTailwind: false,
  });
  const remoteB = await api.addUltramodernVertical({
    ...options,
    workspaceRoot: input.workspaceRoot,
    name: 'remote-b',
    horizontalRemote: true,
    enableTailwind: false,
  });
  const applications = [host, remoteA, remoteB].map((result, index) => {
    assert.equal(result.operation, index ? 'vertical' : 'workspace');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.createdApps.length, 1);
    const app = result.createdApps[0];
    assert.equal(app.renderer, 'octane');
    const coordinate = [
      generatedWorkerCoordinates.host,
      ...generatedWorkerCoordinates.remotes,
    ][index];
    for (const key of ['id', 'directory', 'moduleFederationName'])
      assert.equal(app[key], coordinate[key], `Unexpected generated ${key}.`);
    const artifact = readJson(
      path.join(
        input.workspaceRoot,
        app.directory,
        'shared/ultramodern-build.json',
      ),
    );
    assert.equal(artifact.surfaces.ui.rendererIdentity.renderer, 'octane');
    return {
      ...app,
      buildIdentity: artifact.surfaces.ui.rendererIdentity,
      manifest: readJson(
        path.join(input.workspaceRoot, app.directory, 'package.json'),
      ),
    };
  });
  return {
    origins: input.origins,
    applications,
    operations: [host, remoteA, remoteB].map(result => ({
      operation: result.operation,
      createdApps: result.createdApps,
      warnings: result.warnings,
    })),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    3,
    'Usage: node generated.mjs <owned-generation-input.json>',
  );
  const input = readJson(process.argv[2]);
  const result = await generateWorkerWorkspace(input);
  fs.writeFileSync(input.resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
  });
}
