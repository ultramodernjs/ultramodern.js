import { fork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RendererRouterBindings } from '@modern-js/backend-federation-contracts';
import { createCli } from '@modern-js/plugin/cli';
import type { Renderer } from '@modern-js/renderer-core';
import { loadEnv } from '@rsbuild/core';
import {
  loadUltramodernConfigFile,
  resolveUltramodernEntryIdentities,
} from './config';
import { withEntryMetadataRead } from './config-read-context';
import { findNativeI18nConfig, type NativeI18nConfig } from './native-i18n';
import { resolveEntrypointRouterBindings } from './renderer-router-resolution';
import type { UltramodernConfigLoader } from './types';

export interface UltramodernConfigMetadata {
  renderer: Renderer;
  entries: readonly { entryName: string; isMainEntry: boolean }[];
  primaryEntryName: string;
  routerBindings: RendererRouterBindings;
  /** Present only when the owning analyzer completed all server route hooks. */
  entryBasePaths?: Readonly<Record<string, string>>;
  i18n?: NativeI18nConfig;
}

export interface LoadUltramodernConfigMetadataOptions {
  appDirectory: string;
  configFile?: string;
  env: string;
  command: string;
  /** Run the real public preparation lifecycle in the isolated metadata child. */
  analyzeServerRoutes?: boolean;
  /** Authored files under this root may use the fallbacks; default: the app. */
  sourceRoot?: string;
  /**
   * The app may be a staged copy of another workspace without its installed
   * packages. Imports the copy cannot resolve are resolved from the same
   * location in the original workspace.
   */
  stagedWorkspace?: { root: string; originalRoot: string };
  /** Packages whose dependencies satisfy imports the app has not installed. */
  fallbackPackageRoots?: readonly string[];
}

function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function isMissingModule(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * Resolve bare imports of authored app files that are not installed yet.
 * Installed packages keep Node's normal resolution.
 */
function registerFallbackResolution(
  sourceRoot: string,
  options: LoadUltramodernConfigMetadataOptions,
) {
  const packageRoots = options.fallbackPackageRoots ?? [];
  const staged = options.stagedWorkspace;
  if (!packageRoots.length && !staged) return undefined;
  let resolving = false;
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parentURL = context.parentURL;
        if (
          resolving ||
          !isMissingModule(error) ||
          !parentURL?.startsWith('file:') ||
          specifier.startsWith('.') ||
          specifier.includes(':') ||
          path.isAbsolute(specifier) ||
          isBuiltin(specifier)
        )
          throw error;
        const parent = fileURLToPath(parentURL);
        if (
          parent.split(path.sep).includes('node_modules') ||
          !inside(sourceRoot, parent)
        )
          throw error;
        const anchors = [
          ...(staged && inside(staged.root, parent)
            ? [
                path.join(
                  staged.originalRoot,
                  path.relative(staged.root, parent),
                ),
              ]
            : []),
          ...packageRoots.map(root => path.join(root, 'package.json')),
        ];
        const esm =
          context.conditions.includes('import') &&
          !context.conditions.includes('require');
        resolving = true;
        try {
          for (const anchor of anchors) {
            try {
              if (esm)
                return nextResolve(specifier, {
                  ...context,
                  parentURL: pathToFileURL(anchor).href,
                });
              return {
                url: pathToFileURL(createRequire(anchor).resolve(specifier))
                  .href,
                shortCircuit: true,
              };
            } catch (fallbackError) {
              if (!isMissingModule(fallbackError)) throw fallbackError;
            }
          }
        } finally {
          resolving = false;
        }
        throw error;
      }
    },
  });
}

/** Read an app's metadata in this process; the app must be the working directory. */
export async function readUltramodernConfigMetadata(
  options: LoadUltramodernConfigMetadataOptions,
): Promise<UltramodernConfigMetadata> {
  const appDirectory = path.resolve(options.appDirectory);
  const env = loadEnv({
    cwd: appDirectory,
    mode: process.env.MODERN_ENV || options.env,
    prefixes: ['MODERN_'],
  });
  const hooks = registerFallbackResolution(
    path.resolve(options.sourceRoot ?? appDirectory),
    options,
  );
  try {
    const loaded = await loadUltramodernConfigFile({
      appDirectory,
      configFile: options.configFile,
      env: options.env,
      command: options.analyzeServerRoutes ? 'metadata' : options.command,
    });
    const installedAppDirectory =
      options.stagedWorkspace &&
      (appDirectory === path.resolve(options.stagedWorkspace.root) ||
        inside(path.resolve(options.stagedWorkspace.root), appDirectory))
        ? path.resolve(
            options.stagedWorkspace.originalRoot,
            path.relative(options.stagedWorkspace.root, appDirectory),
          )
        : appDirectory;
    if (options.analyzeServerRoutes) {
      // The native analyzer selects build/serve branches from MODERN_ARGV as
      // well as context.command. Metadata must never inherit a caller's build.
      const previousArgv = process.env.MODERN_ARGV;
      process.env.MODERN_ARGV = 'node modern metadata';
      const cli = createCli<UltramodernConfigLoader>();
      let cleanup: (() => Promise<unknown>) | undefined;
      try {
        return await withEntryMetadataRead(async () => {
          const { appContext } = await cli.init({
            cwd: appDirectory,
            configFile: false,
            config: loaded.config,
            command: 'metadata',
            internalPlugins: [
              {
                name: '@modern-js/ultramodern-route-metadata-context',
                setup(api) {
                  api.updateAppContext({ configFile: loaded.configFile });
                  cleanup = () => api.getHooks().onBeforeExit.call();
                },
              },
            ],
          });
          const context = appContext.pluginAPI!.getAppContext();
          const entrypoints = context.entrypoints ?? [];
          if (!entrypoints.length)
            throw new Error(
              'UltraModern analyzed configuration has no application entries',
            );
          const entryBasePaths: Record<string, string> = {};
          for (const entry of entrypoints) {
            const prefixes = [
              ...new Set(
                (context.serverRoutes ?? [])
                  .filter(
                    route =>
                      route.entryName === entry.entryName && !route.isApi,
                  )
                  .map(route => route.urlPath),
              ),
            ];
            if (prefixes.length !== 1 || typeof prefixes[0] !== 'string')
              throw new Error(
                `Native Worker federation entry ${entry.entryName} requires exactly one analyzed public route prefix.`,
              );
            entryBasePaths[entry.entryName] = prefixes[0];
          }
          const entries = entrypoints.map(({ entryName, isMainEntry }) => ({
            entryName,
            isMainEntry,
          }));
          const primary =
            entries.find(entry => entry.isMainEntry) ?? entries[0];
          const renderer = loaded.config.renderer!;
          const routerBindings = await resolveEntrypointRouterBindings(
            renderer,
            entrypoints,
            context.plugins.map(plugin => plugin.name),
            undefined,
            installedAppDirectory,
          );
          const i18n = findNativeI18nConfig(loaded.config.plugins ?? []);
          return {
            renderer,
            entries,
            primaryEntryName: primary.entryName,
            routerBindings,
            entryBasePaths,
            ...(i18n ? { i18n } : {}),
          };
        });
      } finally {
        try {
          await cleanup?.();
        } finally {
          cli.dispose();
          if (previousArgv === undefined) delete process.env.MODERN_ARGV;
          else process.env.MODERN_ARGV = previousArgv;
        }
      }
    }
    const resolution = await resolveUltramodernEntryIdentities({
      appDirectory,
      installedAppDirectory,
      config: loaded.config,
      command: options.command,
      configFile: loaded.configFile,
    });
    return { renderer: loaded.config.renderer!, ...resolution };
  } finally {
    hooks?.deregister();
    env.cleanup();
  }
}

function workerFile(): string {
  let directory = path.dirname(
    process.env.MODERN_LIB_FORMAT === 'esm'
      ? fileURLToPath(import.meta.url)
      : __filename,
  );
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error('Cannot find the UltraModern app tools package root');
    directory = parent;
  }
  // The ESM build loads modern.config through `jiti.import()`; the CommonJS
  // build's synchronous jiti cannot evaluate configs whose imports read
  // `import.meta` (Effect's ConfigProvider does).
  return path.join(
    directory,
    'dist/esm-node/native-composition/config-metadata-worker.mjs',
  );
}

/**
 * Load an app's modern.config and read its renderer and entries, the way the
 * Modern CLI would for that app. Each load runs in its own short-lived Node
 * process: config plugins keep per-process state such as the working
 * directory captured when they are first imported.
 */
export function loadUltramodernConfigMetadata(
  options: LoadUltramodernConfigMetadataOptions,
): Promise<UltramodernConfigMetadata> {
  const appDirectory = path.resolve(options.appDirectory);
  return new Promise((resolve, reject) => {
    const child = fork(workerFile(), [], {
      cwd: appDirectory,
      execArgv: [],
      env: {
        ...process.env,
        NODE_ENV: options.env,
        ...(options.analyzeServerRoutes
          ? { MODERN_ARGV: 'node modern metadata' }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-65536);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let message: ConfigMetadataMessage | undefined;
    child.once('message', value => {
      message = value as ConfigMetadataMessage;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (message && 'result' in message) resolve(message.result);
      else if (message) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        reject(error);
      } else
        reject(
          new Error(
            `Loading ${appDirectory}/modern.config exited (${signal ?? code}) without a result.${output ? `\n${output}` : ''}`,
          ),
        );
    });
    child.send({ ...options, appDirectory });
  });
}

export type ConfigMetadataMessage =
  | { result: UltramodernConfigMetadata }
  | { error: { message: string; stack?: string } };
