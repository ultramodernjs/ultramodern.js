import fs from 'node:fs/promises';
import path from 'node:path';
import type { NativeRendererAdapter } from '@modern-js/renderer-core/adapter';
import type { FileSystemRouteIR } from '@modern-js/renderer-core/data';
import type { RendererIdentity } from '@modern-js/renderer-core/identity';
import { findNativeFederationConfig } from './native-federation-files';
import {
  emitNativeI18nModule,
  validateNativeLocalisedUrls,
} from './native-i18n';
import type {
  NativeEntryGeneration,
  NativeEntryGenerator,
} from './native-infrastructure';
import { NATIVE_FEDERATION_HYDRATION_MODULE } from './native-module-federation';
import {
  discoverNativeFileSystemRoutes,
  emitNativeApplicationModule,
  resolveNativeApplicationSourceRequest,
  resolveNativeApplicationSourceRequests,
} from './native-routes';
import { nativeWorkerEntrySource } from './native-worker';
import {
  nativeWorkerContextStartupSource,
  nativeWorkerFederationRegistrySource,
} from './native-worker-federation';
import { resolveNativeRendererAdapter } from './renderer-registration';

const entryRoutes = new WeakMap<
  NativeEntryGeneration,
  Promise<FileSystemRouteIR[]>
>();

export function resolveNativeEntryIdentity(
  context: NativeEntryGeneration,
  renderer: NativeEntryGeneration['renderer'],
): RendererIdentity {
  if (context.renderer !== renderer)
    throw new Error('Native generator renderer conflict');
  const identity = context.rendererIdentity;
  if (
    !identity ||
    identity.renderer !== context.renderer ||
    identity.entryName !== context.entrypoint.entryName ||
    identity.protocolVersion !== 1 ||
    !identity.appId?.trim() ||
    !identity.buildId?.trim()
  ) {
    throw new Error(
      'Native entry emission requires its resolved immutable build identity',
    );
  }
  return identity;
}

function entryDirectory(context: NativeEntryGeneration): string {
  return context.entrypoint.internalEntry
    ? path.dirname(context.entrypoint.internalEntry)
    : path.join(
        context.internalDirectory,
        context.renderer,
        context.entrypoint.entryName,
      );
}

async function writeNativeEntryModules(
  directory: string,
  sources: Readonly<Record<string, string>>,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(sources).map(([filename, source]) =>
      fs.writeFile(path.join(directory, filename), source),
    ),
  );
}

/**
 * Discover routes and write the entry's generated application module,
 * `app.<mode>.ts`, and its `i18n.ts`: route source imports and data only.
 */
export async function emitNativeEntryApplication(
  context: NativeEntryGeneration,
  mode: 'client' | 'server' | 'worker',
): Promise<{ routed: boolean; directory: string }> {
  const directory = entryDirectory(context);
  const source = context.entrypoint.entry;
  const routed = (await fs.stat(source)).isDirectory();
  const sources: Record<string, string> = {};
  if (context.i18n) {
    if (!routed)
      throw new Error(
        `i18nPlugin() localizes file-system routes; entry ${context.entrypoint.entryName} has no routes directory`,
      );
    sources['i18n.ts'] = emitNativeI18nModule(context.i18n);
  }
  if (routed) {
    let discovery = entryRoutes.get(context);
    if (!discovery) {
      discovery = discoverNativeFileSystemRoutes({
        routesDirectory: source,
        entryName: context.entrypoint.entryName,
        extensions: context.profile.sourceExtensions,
      }).then(routes => context.modifyRoutes(routes));
      entryRoutes.set(context, discovery);
    }
    const routes = await discovery;
    const sourceRequests = await resolveNativeApplicationSourceRequests(
      routes,
      context.profile.sourceExtensions,
      mode === 'server' ? 'node' : mode,
    );
    if (context.i18n) validateNativeLocalisedUrls(context.i18n, routes);
    sources[`app.${mode}.ts`] = emitNativeApplicationModule({
      routes,
      mode: mode === 'client' ? 'client' : 'server',
      basePath: context.basePath,
      sourceRequests,
    });
  } else {
    const sourceRequest = await resolveNativeApplicationSourceRequest(
      source,
      context.profile.sourceExtensions,
      mode === 'server' ? 'node' : mode,
    );
    sources[`app.${mode}.ts`] =
      `export { default } from ${JSON.stringify(sourceRequest)};\n`;
  }
  await writeNativeEntryModules(directory, sources);
  return { routed, directory };
}

/**
 * The request a generated client entry passes to import() to load the
 * application: the routes, layouts and their styles. Every document needs it,
 * so its stylesheets belong in the server document head.
 */
export const NATIVE_APPLICATION_CLIENT_REQUEST = './app.client';

/**
 * The renderer runtime owns the entry lifecycle. Generated entries are stubs
 * that pass identity, the application importer and the bundler's HMR object
 * to the adapter's entry modules.
 */
export function createNativeEntryStubGenerator(
  adapter: NativeRendererAdapter,
): NativeEntryGenerator {
  const renderer = adapter.name;
  const extra = adapter.entryClient;
  const serverSource = async (
    context: NativeEntryGeneration,
    worker = false,
  ) => {
    const identity = resolveNativeEntryIdentity(context, renderer);
    const { directory, routed } = await emitNativeEntryApplication(
      context,
      worker ? 'worker' : 'server',
    );
    const federated = Boolean(
      !worker && findNativeFederationConfig(context.appDirectory),
    );
    const server = `import { createNativeServerEntry } from ${JSON.stringify(adapter.runtime.entryServer)};
${worker && !context.workerFederation?.plan ? workerContextStartup(context, routed) : ''}${context.i18n ? 'import { i18n } from "./i18n";\n' : ''}${federated ? nativeFederationDeclaration : ''}
export const { ${nativeServerHandlers.join(', ')} } = createNativeServerEntry({
  identity: ${JSON.stringify(identity)},
  app: () => import("./app.${worker ? 'worker' : 'server'}"),${worker && context.workerFederation ? `\n  workerFederationLocale: ${JSON.stringify(context.i18n?.fallbackLanguage ?? 'default')},` : ''}${federated ? `\n  federation: ${nativeServerFederationBinding},` : ''}${context.i18n ? '\n  i18n,' : ''}
});
`;
    if (!federated) return { source: server, directory, routed };
    await writeNativeEntryModules(directory, {
      'handlers.server.ts': server,
    });
    return { source: federatedServerSource(identity), directory, routed };
  };
  return {
    async client(context) {
      const identity = resolveNativeEntryIdentity(context, renderer);
      // Worker SSR uses service snapshots, but its browser compilation owns
      // the same native MF host used to hydrate the admitted remote component.
      const federated = Boolean(
        findNativeFederationConfig(context.appDirectory),
      );
      const { routed } = await emitNativeEntryApplication(context, 'client');
      const fields = {
        identity: JSON.stringify(identity),
        load: `() => import(${JSON.stringify(NATIVE_APPLICATION_CLIENT_REQUEST)})`,
        ...(context.i18n ? { i18n: 'i18n' } : {}),
        hot: 'import.meta.webpackHot',
        ...(federated ? { federation: nativeFederationBinding } : {}),
        ...(context.workerFederation
          ? { workerFederation: 'workerFederation' }
          : {}),
        ...extra?.fields,
      };
      return `import { startNativeClient } from ${JSON.stringify(adapter.runtime.entryClient)};
${workerContextStartup(context, routed)}${context.workerFederation ? nativeWorkerClientTransportSource(context) : ''}${context.i18n ? 'import { i18n } from "./i18n";\n' : ''}${extra?.declarations ?? ''}${federated ? nativeFederationDeclaration : ''}
startNativeClient({
${Object.entries(fields)
  .map(([name, value]) => `  ${name === value ? name : `${name}: ${value}`},`)
  .join('\n')}
});
`;
    },
    server: async context => (await serverSource(context)).source,
    async worker(context) {
      const { source, directory, routed } = await serverSource(context, true);
      const federation = context.workerFederation;
      await writeNativeEntryModules(directory, {
        'handlers.worker.ts': source,
        ...(federation?.plan
          ? {
              'federation.worker.ts': nativeWorkerFederationRegistrySource(
                federation.plan,
                workerContextOptions(context, routed),
              ),
            }
          : {}),
      });
      return nativeWorkerEntrySource(
        './handlers.worker',
        federation
          ? {
              runtime: adapter.runtime.entryServer,
              compatibility: federation.compatibility,
              registry: federation.plan ? './federation.worker' : undefined,
            }
          : undefined,
      );
    },
  };
}

function workerContextOptions(context: NativeEntryGeneration, routed: boolean) {
  return context.renderer === 'octane' && context.workerFederation
    ? {
        router: routed,
        i18n: Boolean(context.i18n),
        contextProfiles: context.workerFederation.contextProfiles,
      }
    : {};
}

function workerContextStartup(context: NativeEntryGeneration, routed: boolean) {
  const source = nativeWorkerContextStartupSource(
    workerContextOptions(context, routed),
  );
  return source ? `${source}\n` : '';
}

// MF owns this compiler-local runtime. Passing a getter from the generated
// entry keeps application ownership when another host or remote starts later.
const nativeFederationBinding =
  '{ instance: () => __webpack_require__.federation.instance }';
// The server names the client module that hydrates its remotes.
const nativeServerFederationBinding = `{ instance: () => __webpack_require__.federation.instance, hydrationModule: ${JSON.stringify(NATIVE_FEDERATION_HYDRATION_MODULE)} }`;
const nativeFederationDeclaration =
  'declare const __webpack_require__: { federation: { instance: import("@modern-js/renderer-core/federation").FederationInstance } };\n';

const nativeServerHandlers = [
  'rendererIdentity',
  'nativeRequestHandler',
  'nativeCSRRequestHandler',
  'nativeMatchRouteIds',
] as const;

/**
 * A federated server entry reaches the renderer through an import() boundary,
 * like the federated client entry: the Module Federation share scope must
 * initialize before the entry consumes the shared renderer singletons.
 */
function federatedServerSource(identity: RendererIdentity): string {
  return `import type { NativeRequestContext } from '@modern-js/renderer-core/server';
export const rendererIdentity = Object.freeze(${JSON.stringify(identity)});
const handlers = () => import('./handlers.server');
${nativeServerHandlers
  .slice(1)
  .map(
    name =>
      `export async function ${name}(request: Request, context: NativeRequestContext) {
  return (await handlers()).${name}(request, context);
}`,
  )
  .join('\n')}
`;
}

/** Select the renderer-owned implementation of the existing entry contract. */
export function createNativeEntryGenerator(
  renderer: NativeEntryGeneration['renderer'],
): NativeEntryGenerator {
  return createNativeEntryStubGenerator(resolveNativeRendererAdapter(renderer));
}

function nativeWorkerClientTransportSource(
  context: NativeEntryGeneration,
): string {
  const federation = context.workerFederation!;
  return `import { createWorkerFederationTransport } from '@modern-js/renderer-core/worker-federation';
import { assertRendererFederationCompatibility, readRendererFederationContract } from '@modern-js/federation-runtime/renderer-contract';
const expectedWorkerRenderer = ${JSON.stringify(federation.compatibility)};
const workerFederation = signal => ({
  locale: ${JSON.stringify(context.i18n?.fallbackLanguage ?? 'default')},
  signal,
  transport: createWorkerFederationTransport({
    signal,
    services: ${JSON.stringify(federation.services)}.map(service => ({...service, fetch: request => globalThis.fetch(request)})),
    admitRendererContract(value) {
      const contract = readRendererFederationContract(value);
      assertRendererFederationCompatibility(expectedWorkerRenderer, contract);
      return contract;
    },
  }),
});
`;
}
