import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloudflareWorkerServiceBindingConfig } from '@modern-js/app-tools-extensions/config';
import {
  distributedSsrFragmentRoute,
  REFERENCE_TOPOLOGY_PATH,
} from '@modern-js/app-tools-extensions/workspace-topology';
import {
  loadUltramodernConfigFile,
  resolveUltramodernEntryIdentities,
} from '@modern-js/ultramodern-app-tools';
import { afterEach, describe, expect, it, rstest } from '@rstest/core';
import { loadUltramodernConfigMetadata } from '../../src/native-composition/config-metadata';
import { concreteNativeWorkerFederationPaths } from '../../src/native-composition/native-worker-federation-config';
import { loadNativeWorkerFederationPolicies } from '../../src/native-composition/native-worker-federation-policy';

const sdkDirectory = path.resolve(__dirname, '../..');
const repositoryDirectory = path.resolve(__dirname, '../../../../..');
const directories: string[] = [];

function workspaceFixture() {
  const ownedRoot = fs.realpathSync(
    fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'worker-policy-'),
    ),
  );
  directories.push(ownedRoot);
  const workspace = path.join(ownedRoot, 'workspace');
  fs.mkdirSync(workspace);
  for (const [name, owner] of [
    ['@modern-js/ultramodern-app-tools', sdkDirectory],
    [
      '@modern-js/runtime',
      path.join(sdkDirectory, 'node_modules/@modern-js/runtime'),
    ],
    [
      '@modern-js/renderer-octane',
      path.join(sdkDirectory, 'node_modules/@modern-js/renderer-octane'),
    ],
    [
      'i18next',
      path.join(
        repositoryDirectory,
        'packages/runtime/i18n-integration/node_modules/i18next',
      ),
    ],
  ]) {
    const target = path.join(workspace, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(owner), target, 'dir');
  }
  const host = path.join(workspace, 'apps/host');
  const remote = path.join(workspace, 'apps/remote');
  fs.mkdirSync(host, { recursive: true });
  const setTopology = (verticals: unknown[]) => {
    const topologyFile = path.join(workspace, REFERENCE_TOPOLOGY_PATH);
    fs.mkdirSync(path.dirname(topologyFile), { recursive: true });
    fs.writeFileSync(
      topologyFile,
      JSON.stringify({
        schemaVersion: 1,
        shell: { id: 'host', path: 'apps/host' },
        verticals,
      }),
    );
  };
  setTopology([{ id: 'remote', path: 'apps/remote' }]);
  return { ownedRoot, workspace, host, remote, setTopology };
}

function writeNativeApp(
  appDirectory: string,
  options: {
    renderer?: 'octane' | 'react';
    baseUrl?: string | string[];
    hookPrefix?: string;
    languages?: readonly string[];
    fallbackLanguage?: string;
    localizedWidget?: Readonly<Record<string, string>>;
  } = {},
) {
  fs.mkdirSync(path.join(appDirectory, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(appDirectory, 'src/App.tsx'),
    'export default function App() { return "metadata-only"; }\n',
  );
  fs.writeFileSync(
    path.join(appDirectory, 'package.json'),
    JSON.stringify({
      name: `policy-${path.basename(appDirectory)}`,
      private: true,
      dependencies: {
        '@modern-js/ultramodern-app-tools': 'workspace:*',
        '@modern-js/renderer-octane': 'workspace:*',
        '@modern-js/runtime': 'workspace:*',
        i18next: '*',
      },
    }),
  );
  const marker = path.join(appDirectory, 'config-evaluations.jsonl');
  const moduleMarker = path.join(
    appDirectory,
    'config-module-evaluations.jsonl',
  );
  const routeTrace = path.join(appDirectory, 'analyzed-routes.json');
  const localeDetection = options.languages
    ? {
        languages: options.languages,
        fallbackLanguage: options.fallbackLanguage ?? options.languages[0],
        ...(options.localizedWidget
          ? {
              localisedUrls: {
                '/_mf/fragment/widget': options.localizedWidget,
              },
            }
          : {}),
      }
    : undefined;
  const source = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { defineConfig, i18nPlugin } from '@modern-js/ultramodern-app-tools';
appendFileSync(${JSON.stringify(moduleMarker)}, 'module\\n');
export default defineConfig(context => {
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify(context) + '\\n');
  return {
    renderer: ${JSON.stringify(options.renderer ?? 'octane')},
    source: { mainEntryName: 'main' },
    server: { ssr: true, baseUrl: ${JSON.stringify(options.baseUrl ?? '/')} },
    plugins: [
      ${localeDetection ? `i18nPlugin({localeDetection:${JSON.stringify(localeDetection)},backend:{enabled:false}}),` : ''}
      {
        name: 'fixture:own-public-route-prefix',
        setup(api) {
          api.modifyServerRoutes(({routes}) => {
            writeFileSync(${JSON.stringify(routeTrace)}, JSON.stringify({
              appDirectory: api.getAppContext().appDirectory,
              command: api.getAppContext().command,
              input: routes.filter(route => route.entryName && !route.isApi).map(route => route.urlPath),
            }));
            return {routes:routes.map(route => route.entryName && !route.isApi
              ? {...route,urlPath:${JSON.stringify(options.hookPrefix ?? '')} + (route.urlPath === '/' ? '' : route.urlPath) || '/'}
              : route)};
          });
        },
      },
    ],
  };
});
`;
  fs.writeFileSync(path.join(appDirectory, 'modern.config.ts'), source);
  return { marker, moduleMarker, routeTrace };
}

function service(remote = 'remote'): CloudflareWorkerServiceBindingConfig {
  return {
    binding: `${remote.toUpperCase()}_WORKER`,
    service: `${remote}-native-worker`,
    fragments: [
      {
        remote,
        expose: './Widget',
        boundaryId: `${remote}Container`,
        path: distributedSsrFragmentRoute('./Widget'),
      },
    ],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('native Worker remote URL policy through public configuration', () => {
  it('keeps React metadata discovery independent of native route-prefix analysis', async () => {
    const fixture = workspaceFixture();
    const host = writeNativeApp(fixture.host, {
      renderer: 'react',
      baseUrl: ['/first-react-prefix', '/second-react-prefix'],
      hookPrefix: '/react-consumer',
    });
    const loaded = await loadUltramodernConfigFile({
      appDirectory: fixture.host,
      command: 'metadata',
      env: 'test',
    });
    const entries = await resolveUltramodernEntryIdentities({
      appDirectory: fixture.host,
      config: loaded.config,
      configFile: loaded.configFile,
    });
    expect(loaded.config.renderer).toBe('react');
    expect(loaded.config.server?.baseUrl).toEqual([
      '/first-react-prefix',
      '/second-react-prefix',
    ]);
    expect(entries.entries).toEqual([{ entryName: 'main', isMainEntry: true }]);
    expect(entries).not.toHaveProperty('entryBasePaths');
    expect(fs.readFileSync(host.moduleMarker, 'utf8')).toBe('module\n');
    expect(fs.existsSync(host.routeTrace)).toBe(false);
  });

  it('uses the remote locales, URL mapping, and analyzed consumer prefix independently of the host', async () => {
    const fixture = workspaceFixture();
    writeNativeApp(fixture.host, {
      languages: ['fr', 'de'],
      fallbackLanguage: 'de',
      baseUrl: '/host-config',
      hookPrefix: '/host-hook',
      localizedWidget: { fr: '/widget-hote', de: '/host-widget' },
    });
    const remote = writeNativeApp(fixture.remote, {
      languages: ['en', 'cs'],
      fallbackLanguage: 'cs',
      baseUrl: '/remote-config',
      hookPrefix: '/remote-hook',
      localizedWidget: {
        en: '/_mf/fragment/widget',
        cs: '/_mf/fragment/komponenta',
      },
    });
    const hostEntries = await loadUltramodernConfigMetadata({
      appDirectory: fixture.host,
      command: 'metadata',
      env: 'test',
      analyzeServerRoutes: true,
    });
    expect(hostEntries.entryBasePaths).toEqual({
      main: '/host-hook/host-config',
    });
    const policies = await loadNativeWorkerFederationPolicies({
      appDirectory: fixture.host,
      services: [service()],
      env: 'test',
    });
    expect(policies.remote).toMatchObject({
      basePath: '/remote-hook/remote-config',
      i18n: {
        languages: ['en', 'cs'],
        fallbackLanguage: 'cs',
        localisedUrls: {
          '/_mf/fragment/widget': {
            en: '/_mf/fragment/widget',
            cs: '/_mf/fragment/komponenta',
          },
        },
      },
    });
    expect(
      concreteNativeWorkerFederationPaths(
        distributedSsrFragmentRoute('./Widget'),
        policies.remote.i18n,
        policies.remote.basePath,
      ),
    ).toEqual({
      cs: '/remote-hook/remote-config/cs/_mf/fragment/komponenta',
      en: '/remote-hook/remote-config/en/_mf/fragment/widget',
    });
    expect(JSON.parse(fs.readFileSync(remote.routeTrace, 'utf8'))).toEqual({
      appDirectory: fixture.remote,
      command: 'metadata',
      input: ['/remote-config'],
    });
    expect(fs.readFileSync(remote.marker, 'utf8').trim().split('\n')).toEqual([
      JSON.stringify({ env: 'test', command: 'metadata' }),
    ]);
    expect(fs.readFileSync(remote.moduleMarker, 'utf8')).toBe('module\n');
    expect(fs.existsSync(path.join(fixture.remote, '.modern-js'))).toBe(false);
  });

  it('publishes an explicit unlocalized policy and evaluates a repeated remote once', async () => {
    const fixture = workspaceFixture();
    const remote = writeNativeApp(fixture.remote, {
      baseUrl: '/plain-config',
      hookPrefix: '/plain-hook',
    });
    const first = service();
    const policies = await loadNativeWorkerFederationPolicies({
      appDirectory: fixture.host,
      services: [first, { ...first, binding: 'SECOND_BINDING' }],
      env: 'production',
    });
    expect(policies).toEqual({
      remote: { i18n: undefined, basePath: '/plain-hook/plain-config' },
    });
    expect(
      concreteNativeWorkerFederationPaths(
        distributedSsrFragmentRoute('./Widget'),
        policies.remote.i18n,
        policies.remote.basePath,
      ),
    ).toEqual({ default: '/plain-hook/plain-config/_mf/fragment/widget' });
    expect(fs.readFileSync(remote.marker, 'utf8').trim().split('\n')).toEqual([
      JSON.stringify({ env: 'production', command: 'metadata' }),
    ]);
    expect(fs.readFileSync(remote.moduleMarker, 'utf8')).toBe('module\n');
  });

  it('rejects multiple analyzed public prefixes instead of choosing an authored base URL', async () => {
    const fixture = workspaceFixture();
    writeNativeApp(fixture.remote, { baseUrl: ['/first', '/second'] });
    await expect(
      loadNativeWorkerFederationPolicies({
        appDirectory: fixture.host,
        services: [service()],
        env: 'test',
      }),
    ).rejects.toThrow('exactly one analyzed public route prefix');
  });

  it('does no filesystem or configuration work for services without fragments', async () => {
    const exists = rstest.spyOn(fs, 'existsSync');
    const read = rstest.spyOn(fsPromises, 'readFile');
    const policies = await loadNativeWorkerFederationPolicies({
      appDirectory: '/missing/no-worker-policy-workspace',
      services: [
        { binding: 'API_ONLY', service: 'api-only' },
        { binding: 'EMPTY_UI', service: 'empty-ui', fragments: [] },
      ],
      env: 'test',
    });
    expect(policies).toEqual({});
    expect(exists).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['unmapped', 'duplicate', 'absolute', 'traversal', 'root'] as const)(
    'rejects a %s topology owner before evaluating its config',
    async failure => {
      const fixture = workspaceFixture();
      const remote = writeNativeApp(fixture.remote);
      const owners = {
        unmapped: [],
        duplicate: [
          { id: 'remote', path: 'apps/remote' },
          { id: 'remote', path: 'apps/remote' },
        ],
        absolute: [{ id: 'remote', path: fixture.remote }],
        traversal: [{ id: 'remote', path: '../outside' }],
        root: [{ id: 'remote', path: '.' }],
      };
      fixture.setTopology(owners[failure]);
      await expect(
        loadNativeWorkerFederationPolicies({
          appDirectory: fixture.host,
          services: [service()],
          env: 'test',
        }),
      ).rejects.toThrow(/configuration owner|unsafe configuration path/u);
      expect(fs.existsSync(remote.marker)).toBe(false);
      expect(fs.existsSync(remote.moduleMarker)).toBe(false);
      expect(fs.existsSync(remote.routeTrace)).toBe(false);
    },
  );

  it('preflights every remote owner before evaluating the first valid config', async () => {
    const fixture = workspaceFixture();
    const remote = writeNativeApp(fixture.remote);
    await expect(
      loadNativeWorkerFederationPolicies({
        appDirectory: fixture.host,
        services: [service(), service('unmapped')],
        env: 'test',
      }),
    ).rejects.toThrow('configuration owner');
    expect(fs.existsSync(remote.marker)).toBe(false);
    expect(fs.existsSync(remote.moduleMarker)).toBe(false);
    expect(fs.existsSync(remote.routeTrace)).toBe(false);
  });

  it('rejects a declared remote directory symlink that escapes the workspace before source evaluation', async () => {
    const fixture = workspaceFixture();
    const outside = path.join(fixture.ownedRoot, 'outside-remote');
    const remote = writeNativeApp(outside);
    fs.mkdirSync(path.join(fixture.workspace, 'apps'), { recursive: true });
    fs.symlinkSync(outside, fixture.remote, 'dir');
    // Source evaluation must never be needed to prove containment, including
    // when that outside source has valid installed framework dependencies.
    fs.symlinkSync(
      path.join(fixture.workspace, 'node_modules'),
      path.join(outside, 'node_modules'),
      'dir',
    );
    await expect(
      loadNativeWorkerFederationPolicies({
        appDirectory: fixture.host,
        services: [service()],
        env: 'test',
      }),
    ).rejects.toThrow('unsafe configuration path');
    expect(fs.existsSync(remote.marker)).toBe(false);
    expect(fs.existsSync(remote.moduleMarker)).toBe(false);
    expect(fs.existsSync(remote.routeTrace)).toBe(false);
  });
});
