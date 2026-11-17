import os from 'node:os';
import path from 'node:path';
import type { NodeFileTraceResult } from '@vercel/nft';

// Directories owned by the build host rather than the app. nft statically
// evaluates `os.homedir()`, `os.tmpdir()` and literal system paths, so code
// like `fs.readFileSync(path.join(os.homedir(), name))` becomes a glob of the
// whole home directory. With `base: '/'` that glob walks the machine.
const SYSTEM_ROOTS =
  process.platform === 'win32'
    ? []
    : ['/dev', '/etc', '/proc', '/run', '/sys', '/var/run'];

const GLOB_SEGMENT = /[*?[{]/;

const isInside = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}${path.sep}`);

/** Select emitted runtime roots; nft still follows every real import. */
export async function createNodeDeployEntryFilter(options: {
  appDirectory: string;
  outputDirectory: string;
  apiDirectory: string;
  sharedDirectory: string;
  bff?: {
    runtimeFramework?: string;
    isCrossProjectServer?: boolean;
    effect?: { entry?: string };
  };
}) {
  const { appDirectory, outputDirectory, apiDirectory, sharedDirectory, bff } =
    options;
  const output = path.resolve(outputDirectory);
  const staticDirectory = path.join(output, 'static');
  let bundledEntry: string | undefined;
  if (bff?.runtimeFramework === 'effect' && !bff.isCrossProjectServer) {
    const { resolveEffectEntryPaths } = await import(
      '@modern-js/plugin-bff-extensions/effect-source-loader'
    );
    const { relativeEffectEntry } = resolveEffectEntryPaths({
      appDir: appDirectory,
      apiDir: apiDirectory,
      effectEntry: bff.effect?.entry,
    });
    const entry = path.resolve(output, relativeEffectEntry);
    // Server-only apps have no Effect entry. External SDK entries belong to
    // their package trace rather than this app's bundled source directories.
    if (
      relativeEffectEntry &&
      !relativeEffectEntry.split(/[\\/]/u).includes('node_modules') &&
      isInside(output, entry)
    )
      bundledEntry = entry;
  }
  const bundledDirectories = [
    apiDirectory,
    sharedDirectory,
    path.join(appDirectory, 'src'),
  ]
    .filter(directory =>
      isInside(path.resolve(appDirectory), path.resolve(directory)),
    )
    .map(directory =>
      path.resolve(output, path.relative(appDirectory, directory)),
    );
  return (file: string) => {
    const absolute = path.resolve(file);
    if (isInside(staticDirectory, absolute) || absolute.endsWith('.map'))
      return false;
    return (
      !bundledEntry ||
      absolute === bundledEntry ||
      !bundledDirectories.some(directory => isInside(directory, absolute))
    );
  };
}

const globRoot = (absolutePattern: string) => {
  const { root } = path.parse(absolutePattern);
  const segments = absolutePattern.slice(root.length).split(path.sep);
  const index = segments.findIndex(segment => GLOB_SEGMENT.test(segment));
  return index === -1
    ? undefined
    : path.join(root, ...segments.slice(0, index));
};

/**
 * Builds the nft `ignore` predicate for a trace rooted at `base`: skip every
 * path under a system root, and skip globs that would enumerate the file
 * system root, the home directory or the temp directory as a whole. Files
 * inside home or temp are still traced, since package stores can live there.
 */
export const createBuildHostIgnore = (base: string) => {
  const wholeDirectories = new Set([
    path.parse(path.resolve(base)).root,
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
  ]);
  return (relativePath: string) => {
    const absolutePath = path.resolve(base, relativePath);
    if (SYSTEM_ROOTS.some(root => isInside(root, absolutePath))) {
      return true;
    }
    const root = globRoot(absolutePath);
    return root !== undefined && wholeDirectories.has(root);
  };
};

/**
 * `traceFiles` implementation for ndepe's `nodeDepEmit`, tracing with the
 * `@vercel/nft` release app-tools-extensions depends on instead of the one ndepe pins.
 */
export const traceDeployFiles = ({
  entryFiles,
  sourceDir,
  base = '/',
}: {
  entryFiles: string[];
  sourceDir: string;
  base?: string;
}): Promise<NodeFileTraceResult> => {
  const resolvedBase = path.resolve(base);
  const ignore = createBuildHostIgnore(resolvedBase);
  try {
    // NFT resolves roots and maps entries before its first await. Capture the
    // same invocation here so loading it cannot observe a later cwd or edit.
    const options = {
      base: resolvedBase,
      processCwd: path.resolve(sourceDir || resolvedBase),
      ignore,
    };
    const entries = entryFiles.map(file => path.resolve(file));
    return import('@vercel/nft').then(({ nodeFileTrace }) =>
      nodeFileTrace(entries, options),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};
