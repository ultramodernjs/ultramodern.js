import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { compile } from '@modern-js/server-utils';
import { resolveEffectTsrsCompiler } from './build-config/build-environment';

type CompilerProvider = NonNullable<Parameters<typeof compile>[2]['compiler']>;
type Compiler = Awaited<ReturnType<CompilerProvider>>;
type CompilerConfig = Awaited<ReturnType<Compiler['readConfig']>>;

const execute = promisify(execFile);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

// Validate the fields consumed by the neutral projection at the child-process
// boundary. Other native compiler options remain opaque JSON for the CLI.
function isCompilerConfig(value: unknown): value is CompilerConfig {
  if (!isRecord(value) || !isRecord(value.compilerOptions)) return false;
  const options = value.compilerOptions;
  if (
    ![
      'allowJs',
      'composite',
      'declaration',
      'declarationMap',
      'emitDeclarationOnly',
      'experimentalDecorators',
      'incremental',
      'noEmit',
      'noEmitOnError',
    ].every(
      key => options[key] === undefined || typeof options[key] === 'boolean',
    ) ||
    ![
      'baseUrl',
      'jsx',
      'moduleResolution',
      'outDir',
      'rootDir',
      'tsBuildInfoFile',
    ].every(
      key => options[key] === undefined || typeof options[key] === 'string',
    )
  ) {
    return false;
  }
  if (
    options.paths !== undefined &&
    (!isRecord(options.paths) || !Object.values(options.paths).every(isStrings))
  ) {
    return false;
  }
  return (
    isStrings(value.files) &&
    (value.include === undefined || isStrings(value.include)) &&
    (value.references === undefined ||
      (Array.isArray(value.references) &&
        value.references.every(
          reference =>
            isRecord(reference) && typeof reference.path === 'string',
        )))
  );
}

// tsrs has no --showConfig. Its native API returns numeric option enums and
// absolute file paths, not a JSON tsconfig. Serialize those using the matching
// package's enum tables before the neutral server compiler projects its roots.
const inspectConfig = `
  import { pathToFileURL } from 'node:url';
  const [apiPath, protoPath, executable, configFile] = process.argv.slice(1);
  const { API, formatDiagnostics } = await import(pathToFileURL(apiPath).href);
  const enums = await import(pathToFileURL(protoPath).href);
  const api = new API({ tsserverPath: executable });
  try {
    const config = api.parseConfigFile(configFile);
    if (config.errors.length) {
      process.stdout.write(formatDiagnostics(config.errors, api));
      process.exitCode = 1;
    } else {
      const options = { ...config.options };
      delete options.configFilePath;
      // The protocol's typed PluginImport carries only "name". Retain the
      // native parser's raw plugin settings, including Effect severity policy.
      if (config.raw?.compilerOptions?.plugins) {
        options.plugins = config.raw.compilerOptions.plugins;
      }
      const enumOptions = {
        jsx: 'JsxEmit', module: 'ModuleKind',
        moduleResolution: 'ModuleResolutionKind', target: 'ScriptTarget',
        moduleDetection: 'ModuleDetectionKind', newLine: 'NewLineKind',
      };
      for (const [key, table] of Object.entries(enumOptions)) {
        if (typeof options[key] !== 'number') continue;
        if (key === 'target' && options[key] === enums.ScriptTarget.ESNext) {
          options[key] = 'esnext';
          continue;
        }
        const name = enums[table][options[key]];
        if (!name) throw new Error('Unknown tsrs ' + key + ': ' + options[key]);
        options[key] = key === 'jsx'
          ? ({ ReactJSX: 'react-jsx', ReactJSXDev: 'react-jsxdev',
               ReactNative: 'react-native' }[name] ?? name.toLowerCase())
          : name.toLowerCase();
      }
      if (options.lib) {
        options.lib = options.lib.map(file =>
          file.replace(/^.*[/\\\\]/u, '').replace(/^lib\\./u, '').replace(/\\.d\\.ts$/u, ''));
      }
      process.stdout.write(JSON.stringify({
        compilerOptions: options, files: config.fileNames,
        references: config.projectReferences,
      }));
    }
  } finally {
    api.close();
  }
`;

/**
 * Bind all server compilation to the app's strict, metadata-validated Effect
 * tsrs cohort through the shared strict resolver. Explicit overrides undergo
 * --version stamp validation; there is never a vanilla/Effect-Go fallback.
 */
export const nativeServerCompiler: CompilerProvider = async appDirectory => {
  const from = path.join(appDirectory, 'package.json');
  const executable = resolveEffectTsrsCompiler({ from });
  const appRequire = createRequire(from);
  const configApi = appRequire.resolve('tsrs/sync');
  const configProto = appRequire.resolve('tsrs/proto');
  const manifest: unknown = JSON.parse(
    await readFile(appRequire.resolve('tsrs/package.json'), 'utf8'),
  );
  // The strict resolver validates the provider's metadata and commit pairing.
  // The Rslib version comes from that same consumer package, not stable TS.
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('tsrs' in manifest) ||
    typeof manifest.tsrs !== 'object' ||
    manifest.tsrs === null ||
    !('typescriptVersion' in manifest.tsrs) ||
    typeof manifest.tsrs.typescriptVersion !== 'string'
  ) {
    throw new Error(`Missing tsrs TypeScript version for ${from}`);
  }
  const version = manifest.tsrs.typescriptVersion;
  const env = {
    ...process.env,
    TSRS_CHECKER_ASSIGNMENT: process.env.TSRS_CHECKER_ASSIGNMENT || 'go',
  };
  // Rslib 1.x requires a version module and adjacent getExePath.js, with no
  // app-origin argument. An invocation-private adapter is necessary: a static
  // package entry would rediscover from its own origin or share mutable state.
  // This contains only the selected path, never a copied compiler executable.
  const adapter = await mkdtemp(path.join(tmpdir(), 'modern-server-tsrs-'));
  const dispose = () => rm(adapter, { recursive: true, force: true });
  try {
    await writeFile(
      path.join(adapter, 'package.json'),
      '{"type":"commonjs"}\n',
    );
    await writeFile(
      path.join(adapter, 'compiler.cjs'),
      `exports.version = ${JSON.stringify(version)};\n`,
    );
    await writeFile(
      path.join(adapter, 'getExePath.js'),
      `module.exports = () => {
  process.env.TSRS_CHECKER_ASSIGNMENT = ${JSON.stringify(env.TSRS_CHECKER_ASSIGNMENT)};
  return ${JSON.stringify(executable)};
};\n`,
    );
    return {
      command: { executable, args: [], env },
      typescriptPath: path.join(adapter, 'compiler.cjs'),
      async readConfig(tsconfigPath) {
        const result = await execute(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            inspectConfig,
            configApi,
            configProto,
            executable,
            tsconfigPath,
          ],
          {
            cwd: path.dirname(tsconfigPath),
            env,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 10_000,
          },
        ).catch((cause: unknown) => {
          const diagnostics =
            cause instanceof Error &&
            'stdout' in cause &&
            typeof cause.stdout === 'string'
              ? cause.stdout.trim()
              : '';
          throw new Error(
            `Effect tsrs could not parse ${tsconfigPath}: ${diagnostics || String(cause)}`,
            { cause },
          );
        });
        const config: unknown = JSON.parse(result.stdout);
        if (!isCompilerConfig(config)) {
          throw new Error(
            `Invalid Effect tsrs config response for ${tsconfigPath}`,
          );
        }
        return config;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};
