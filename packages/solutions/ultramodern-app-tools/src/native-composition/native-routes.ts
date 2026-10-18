import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileSystemRouteIR } from '@modern-js/renderer-core/data';

export interface NativeRouteDiscovery {
  routesDirectory: string;
  entryName: string;
  extensions: readonly string[];
}

function conventionalPath(directory: string): string | undefined {
  if (directory.startsWith('__')) return undefined;
  return directory
    .split('.')
    .map(segment => {
      const suffix = segment.endsWith('$');
      const value = suffix ? segment.slice(0, -1) : segment;
      const parameter = /^\[([^\]]+)\]$/u.exec(value);
      if (suffix && !parameter)
        throw new Error(
          `Optional native route segments require a bracketed parameter: ${segment}`,
        );
      const inline = parameter?.[1].endsWith('$') ?? false;
      const name = inline ? parameter?.[1].slice(0, -1) : parameter?.[1];
      return `${parameter ? `:${name}` : value}${suffix || inline ? '?' : ''}`;
    })
    .join('/');
}

/** Discover structure and source references; native routers own URL matching. */
export async function discoverNativeFileSystemRoutes(
  options: NativeRouteDiscovery,
): Promise<FileSystemRouteIR[]> {
  const root = path.resolve(options.routesDirectory);
  const idFor = (file: string): string => {
    const relative = path
      .relative(root, file)
      .split(path.sep)
      .join('/')
      .replace(/\.[^.]+$/u, '')
      .replace(/\[([^\]]+)\]/gu, '($1)');
    return options.entryName === 'main'
      ? relative
      : `${options.entryName}_${relative}`;
  };

  const walk = async (
    directory: string,
    isRoot: boolean,
  ): Promise<FileSystemRouteIR | undefined> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const files = new Map(
      entries.filter(entry => entry.isFile()).map(entry => [entry.name, entry]),
    );
    const find = (basename: string): string | undefined => {
      const candidates = options.extensions
        .map(extension => `${basename}${extension}`)
        .filter(filename => files.has(filename));
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous native route module ${path.join(directory, basename)}: ${candidates.join(', ')}`,
        );
      }
      return candidates[0] && path.join(directory, candidates[0]);
    };
    const modules = (basename: string, boundaries: boolean) => {
      const references = {
        data: find(`${basename}.data`),
        clientData: find(`${basename}.data.client`),
        search: find(`${basename}.search`),
        head: find(`${basename}.head`),
        loading: boundaries ? find('loading') : undefined,
        error: boundaries ? find('error') : undefined,
        notFound: boundaries ? find('not-found') : undefined,
      };
      return Object.fromEntries(
        Object.entries(references).filter(([, reference]) => reference),
      );
    };
    const layout = find('layout');
    const folderPath = isRoot
      ? '/'
      : conventionalPath(path.basename(directory));
    const node: FileSystemRouteIR = {
      id: idFor(path.join(directory, 'layout.ts')),
      ...(layout ? { file: layout } : {}),
      ...(folderPath === undefined ? {} : { path: folderPath }),
      ...(isRoot ? { isRoot: true } : {}),
      modules: modules('layout', true),
      children: [],
    };
    const page = find('page');
    if (page) {
      node.children.push({
        id: idFor(page),
        file: page,
        index: true,
        modules: modules('page', false),
        children: [],
      });
    }
    const splat = find('$');
    if (splat) {
      node.children.push({
        id: idFor(splat),
        file: splat,
        path: '*',
        modules: modules('$', false),
        children: [],
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = await walk(path.join(directory, entry.name), false);
      if (child) node.children.push(child);
    }
    if (
      !isRoot &&
      node.children.length === 0 &&
      !node.file &&
      Object.keys(node.modules ?? {}).length === 0
    )
      return undefined;
    return node;
  };
  const discovered = await walk(root, true);
  return discovered ? [discovered] : [];
}

export interface NativeApplicationModuleOptions {
  routes: readonly FileSystemRouteIR[];
  mode: 'client' | 'server';
  basePath: string;
  sourceRequests?: ReadonlyMap<string, string>;
}

/** TS source requests use the bundler's extension resolution, also understood by
 * strict TypeScript consumers. Keep native and JavaScript suffixes explicit. */
export function nativeApplicationSourceRequest(file: string): string {
  return file.replace(/\.tsx?$/u, '');
}

export type NativeApplicationTarget = 'client' | 'node' | 'worker';

const defaultSourceExtensions = [
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.jsx',
  '.json',
  '.cjs',
  '.mts',
  '.cts',
];

// adapterBasic prepends each extension in this order. Worker SSR targets web,
// so it deliberately receives only Worker extensions, not Node/server ones.
const nodeSourceExtensions = [
  '.node.js',
  '.node.jsx',
  '.node.ts',
  '.node.tsx',
  '.node.mjs',
  '.server.js',
  '.server.jsx',
  '.server.ts',
  '.server.tsx',
  '.server.mjs',
];
const workerSourceExtensions = [
  '.worker.js',
  '.worker.jsx',
  '.worker.ts',
  '.worker.tsx',
];

/** Preserve the source selected by adapterBasic's explicit extension aliases.
 * Converting an explicit TS request must not change its platform or compiler. */
export async function resolveNativeApplicationSourceRequest(
  file: string,
  extensions: readonly string[],
  target: NativeApplicationTarget,
): Promise<string> {
  const request = nativeApplicationSourceRequest(file);
  if (request === file) return file;
  const selectedExtension = path.extname(file);
  const exists = async (candidate: string) => {
    try {
      return (await fs.stat(candidate)).isFile();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
      )
        throw error;
      return false;
    }
  };
  const assertUniqueCompiler = async (basename: string) => {
    for (const extension of new Set([
      ...extensions,
      ...defaultSourceExtensions,
    ])) {
      const sibling = `${basename}${extension}`;
      if (extension !== selectedExtension && (await exists(sibling))) {
        throw new Error(
          `Ambiguous native application module ${file}: extensionless imports could select ${sibling}`,
        );
      }
    }
  };
  await assertUniqueCompiler(request);
  const aliases =
    target === 'client'
      ? []
      : [
          `${request}.${target === 'node' ? 'node' : 'worker'}${selectedExtension}`,
          `${request}.server${selectedExtension}`,
        ];
  let selected = file;
  for (const alias of aliases) {
    if (await exists(alias)) {
      selected = alias;
      break;
    }
  }
  const resolutionExtensions = [
    ...(target === 'node'
      ? [...nodeSourceExtensions].reverse()
      : target === 'worker'
        ? [...workerSourceExtensions].reverse()
        : []),
    ...defaultSourceExtensions,
    ...extensions,
  ];
  const resolve = async (basename: string) => {
    for (const extension of resolutionExtensions) {
      const candidate = `${basename}${extension}`;
      if (await exists(candidate)) return candidate;
    }
    // A route hook may provide a virtual source that its compiler materializes.
    return undefined;
  };
  const resolved = await resolve(request);
  if (!resolved || resolved === selected) return request;
  if (selected !== file) {
    // E.g. Worker explicit layout.tsx aliases to layout.server.tsx, while an
    // extensionless layout request cannot see .server overlays in a web target.
    const platformRequest = nativeApplicationSourceRequest(selected);
    await assertUniqueCompiler(platformRequest);
    if ((await resolve(platformRequest)) === selected) return platformRequest;
  }
  throw new Error(
    `Ambiguous native application module ${file}: extensionless imports could select ${resolved}`,
  );
}

const viewModules = [
  ['component', 'file'],
  ['pendingComponent', 'loading'],
  ['errorComponent', 'error'],
  ['notFoundComponent', 'notFound'],
  ['head', 'head'],
  ['search', 'search'],
] as const;

/** Validate executable imports only. Source metadata can name server-only
 * modules that are deliberately absent from the client compilation. */
export async function resolveNativeApplicationSourceRequests(
  routes: readonly FileSystemRouteIR[],
  extensions: readonly string[],
  target: NativeApplicationTarget,
): Promise<ReadonlyMap<string, string>> {
  const files = new Set<string>();
  const visit = (route: FileSystemRouteIR) => {
    for (const [, reference] of viewModules) {
      const file =
        reference === 'file' ? route.file : route.modules?.[reference];
      if (file) files.add(file);
    }
    const data =
      target === 'client' ? route.modules?.clientData : route.modules?.data;
    if (data) files.add(data);
    for (const child of route.children) visit(child);
  };
  for (const route of routes) visit(route);
  return new Map(
    await Promise.all(
      [...files].map(
        async file =>
          [
            file,
            await resolveNativeApplicationSourceRequest(
              file,
              extensions,
              target,
            ),
          ] as const,
      ),
    ),
  );
}

/**
 * Emit a routed entry's generated application module: route source imports
 * and route data, without server-only data in the client graph. The renderer
 * runtime turns it into its native router.
 */
export function emitNativeApplicationModule(
  options: NativeApplicationModuleOptions,
): string {
  if (
    typeof options.basePath !== 'string' ||
    !options.basePath.startsWith('/')
  ) {
    throw new Error(
      'Native route emission requires its analyzed public base path',
    );
  }
  const imports: string[] = [];
  const bindings = new Map<string, string>();
  const moduleImport = (file: string): string => {
    let binding = bindings.get(file);
    if (!binding) {
      binding = `routeModule${bindings.size}`;
      bindings.set(file, binding);
      imports.push(
        `import * as ${binding} from ${JSON.stringify(options.sourceRequests?.get(file) ?? nativeApplicationSourceRequest(file))};`,
      );
    }
    return binding;
  };
  const routeModules: string[] = [];
  const dataModules: string[] = [];
  const serverDataRoutes: string[] = [];
  const visit = (route: FileSystemRouteIR) => {
    const fields = viewModules.flatMap(([field, reference]) => {
      const file =
        reference === 'file' ? route.file : route.modules?.[reference];
      return file ? [`${field}: ${moduleImport(file)}`] : [];
    });
    // Computed keys: a literal "__proto__" key would set the prototype.
    routeModules.push(
      `  [${JSON.stringify(route.id)}]: { ${fields.join(', ')} },`,
    );
    const dataFile =
      options.mode === 'server'
        ? route.modules?.data
        : route.modules?.clientData;
    if (dataFile)
      dataModules.push(
        `  [${JSON.stringify(route.id)}]: ${moduleImport(dataFile)},`,
      );
    if (route.modules?.data) serverDataRoutes.push(route.id);
    for (const child of route.children) visit(child);
  };
  for (const route of options.routes) visit(route);
  // Only structural source metadata is shared. It contains no executable loader.
  const clientIR = (
    routes: readonly FileSystemRouteIR[],
  ): FileSystemRouteIR[] =>
    routes.map(route => ({
      ...route,
      modules: route.modules
        ? {
            ...route.modules,
            ...(route.modules.data ? { data: `server-data:${route.id}` } : {}),
          }
        : undefined,
      children: clientIR(route.children),
    }));
  const routeIR =
    options.mode === 'client' ? clientIR(options.routes) : options.routes;
  // Set the prototypes after construction so TypeScript infers only route
  // entries, rather than a null-valued `__proto__` index signature member.
  return `${imports.join('\n')}
export const basePath = ${JSON.stringify(options.basePath)};
export const routeIR = ${JSON.stringify(routeIR, null, 2)};
export const routeModules = {
${routeModules.join('\n')}
};
Object.setPrototypeOf(routeModules, null);
export const dataModules = {
${dataModules.join('\n')}
};
Object.setPrototypeOf(dataModules, null);
${options.mode === 'client' ? `export const serverDataRoutes = ${JSON.stringify(serverDataRoutes)};\n` : ''}`;
}
