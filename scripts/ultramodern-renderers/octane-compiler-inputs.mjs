import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const renderer = '@modern-js/renderer-octane';
const rendererDependencies = [
  '@modern-js/app-tools-extensions',
  'tsrs',
  '@effect/tsgo',
];
const appDependencies = [
  '@tanstack/router-core',
  '@octanejs/tanstack-router',
  'octane',
];
// Deliberately exclude .env, .npmrc and executable application configuration.
const inputNames = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];
const sha256 = file =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fingerprint = file => ({ path: file, sha256: sha256(file) });

function context(root) {
  return {
    root,
    files: inputNames.flatMap(name => {
      const file = path.join(root, name);
      return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()
        ? [
            {
              ...fingerprint(file),
              ...(name === 'pnpm-lock.yaml'
                ? { content: fs.readFileSync(file, 'utf8') }
                : {}),
            },
          ]
        : [];
    }),
  };
}

function installed(request, name) {
  let manifest;
  try {
    try {
      manifest = request.resolve(`${name}/package.json`);
    } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      let directory = path.dirname(request.resolve(name));
      while (true) {
        const candidate = path.join(directory, 'package.json');
        if (
          fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile() &&
          JSON.parse(fs.readFileSync(candidate, 'utf8')).name
        ) {
          manifest = candidate;
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw error;
        directory = parent;
      }
    }
    manifest = fs.realpathSync(manifest);
  } catch (cause) {
    throw new Error(
      `Required installed dependency ${name} cannot resolve from ${request.resolve.paths(name)?.[0]}`,
      { cause },
    );
  }
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const alias = name.startsWith('@modern-js/')
    ? `@bleedingdev/modern-js-${name.slice('@modern-js/'.length)}`
    : name;
  if (
    ![name, alias].includes(metadata.name) ||
    typeof metadata.version !== 'string' ||
    !metadata.version
  )
    throw new Error(
      `Invalid installed package metadata for ${name}: ${manifest}`,
    );
  const root = path.dirname(manifest);
  const files = [];
  function walk(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (
        entry.name === 'node_modules' ||
        entry.name.startsWith('.env') ||
        entry.isSymbolicLink()
      )
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|g[jt]s)$/u.test(entry.name))
        files.push(fingerprint(file));
    }
  }
  walk(root);
  return {
    name: metadata.name,
    version: metadata.version,
    root,
    manifest: fingerprint(manifest),
    files,
  };
}

/** Hash installed inputs only: never load package code or locate/run a compiler. */
export function captureOctaneCompilerInputs(appRoot) {
  appRoot = fs.realpathSync(appRoot);
  if (
    !fs
      .lstatSync(path.join(appRoot, 'package.json'), { throwIfNoEntry: false })
      ?.isFile()
  )
    throw new Error(
      `Required app package.json missing or not a regular file: ${appRoot}`,
    );
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const packages = { [renderer]: installed(appRequire, renderer) };
  const rendererRequire = createRequire(packages[renderer].manifest.path);
  for (const name of rendererDependencies)
    packages[name] = installed(rendererRequire, name);
  for (const name of appDependencies)
    packages[name] = installed(appRequire, name);
  let workspace = null;
  for (let directory = appRoot; ; directory = path.dirname(directory)) {
    if (
      fs
        .lstatSync(path.join(directory, 'pnpm-workspace.yaml'), {
          throwIfNoEntry: false,
        })
        ?.isFile()
    ) {
      workspace = context(directory);
      break;
    }
    if (path.dirname(directory) === directory) break;
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    appRoot,
    app: context(appRoot),
    workspace,
    packages,
  };
}

/**
 * Hosted qualification only: use the same strict resolver and ESM client anchor
 * as octane-tsc. Resolution validates --version, but never typechecks or emits.
 */
export async function captureResolvedOctaneCompilerInputs(
  appRoot,
  resolveCompiler,
) {
  const capture = captureOctaneCompilerInputs(appRoot);
  const client = fs.realpathSync(
    path.join(capture.packages[renderer].root, 'dist/esm-node/typecheck.mjs'),
  );
  // Match the ESM build-config entry imported by the installed ESM client.
  const resolve =
    resolveCompiler ??
    (
      await import(
        pathToFileURL(
          path.join(
            capture.packages['@modern-js/app-tools-extensions'].root,
            'dist/esm-node/build-config/index.mjs',
          ),
        ).href
      )
    ).resolveEffectTsrsCompiler;
  const compiler = fs.realpathSync(
    await resolve({ from: pathToFileURL(client).href }),
  );
  if (!fs.statSync(compiler).isFile())
    throw new Error(`Selected compiler is not a regular file: ${compiler}`);
  return {
    ...capture,
    compiler: fingerprint(compiler),
    compilerEnvironment: Object.fromEntries(
      [
        'EFFECT_TSGO_BIN',
        'TSRS_BINARY',
        'TSRS_CHECKER_ASSIGNMENT',
        'GOMAXPROCS',
      ].map(name => [name, process.env[name] ?? null]),
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const resolveCompiler = process.argv[3] === '--resolve-compiler';
  if (process.argv.length !== (resolveCompiler ? 4 : 3))
    throw new Error(
      'Usage: node octane-compiler-inputs.mjs <appRoot> [--resolve-compiler]',
    );
  console.log(
    JSON.stringify(
      resolveCompiler
        ? await captureResolvedOctaneCompilerInputs(process.argv[2])
        : captureOctaneCompilerInputs(process.argv[2]),
      null,
      2,
    ),
  );
}
