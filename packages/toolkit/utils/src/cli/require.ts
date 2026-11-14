import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moduleResolve } from 'import-meta-resolve';
import { findExists } from './fs';

async function importPath(path: string) {
  const modulePath = isAbsolute(path) ? pathToFileURL(path).href : path;
  if (process.env.NODE_ENV === 'development') {
    const timestamp = Date.now();
    // @ts-ignore
    return await import(`${modulePath}?t=${timestamp}`);
  } else {
    // @ts-ignore
    return await import(modulePath);
  }
}

/**
 * Require function compatible with esm and cjs module.
 * @param path - File to required.
 * @returns module export object.
 */

async function compatibleRequireESM(
  path: string,
  interop = true,
): Promise<any> {
  if (path.endsWith('.json')) {
    return JSON.parse(await readFile(path, 'utf8'));
  }

  const requiredModule = await importPath(path);
  if (!interop || !Object.hasOwn(requiredModule, 'default')) {
    return requiredModule;
  }
  let value = requiredModule.default;
  // Node marks CJS namespaces; genuine ESM default payloads stay untouched.
  if (requiredModule['module.exports'] === value) {
    const seen = new Set();
    while (
      value &&
      typeof value === 'object' &&
      value.__esModule === true &&
      Object.hasOwn(value, 'default') &&
      !seen.has(value)
    ) {
      seen.add(value);
      value = value.default;
    }
  }
  return value;
}

async function compatibleRequireCJS(
  path: string,
  interop = true,
): Promise<any> {
  if (path.endsWith('.json')) {
    return require(path);
  }

  try {
    const requiredModule = require(path);
    return interop && requiredModule?.__esModule
      ? requiredModule.default
      : requiredModule;
  } catch (err: any) {
    // Node's require(esm) rejects ESM graphs that use top-level await.
    if (
      err?.code === 'ERR_REQUIRE_ESM' ||
      err?.code === 'ERR_REQUIRE_ASYNC_MODULE'
    ) {
      return await compatibleRequireESM(path, interop);
    }
    throw err;
  }
}

export async function compatibleRequire(
  path: string,
  interop = true,
): Promise<any> {
  if (process.env.MODERN_LIB_FORMAT === 'esm') {
    return await compatibleRequireESM(path, interop);
  } else {
    return await compatibleRequireCJS(path, interop);
  }
}

export async function loadFromProject(moduleName: string, appDir: string) {
  let requiredModule;
  const paths = [appDir, process.cwd()];

  try {
    const modulePath = tryResolve(moduleName, ...paths);
    if (process.env.MODERN_LIB_FORMAT === 'esm') {
      const moduleUrl = pathToFileURL(modulePath).href;
      requiredModule = await import(moduleUrl);
    } else {
      requiredModule = require(modulePath);
    }

    return requiredModule.default || requiredModule;
  } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Cannot find module ${moduleName}.`);
    }
    throw error;
  }
}

export const requireExistModule = async (
  filename: string,
  opt?: {
    extensions?: string[];
    interop?: boolean;
  },
) => {
  const final = {
    extensions: ['.ts', '.js'],
    interop: true,
    ...opt,
  };
  const exist = findExists(final.extensions.map(ext => `${filename}${ext}`));
  if (!exist) {
    return null;
  }

  return compatibleRequire(exist, final.interop);
};

export const cleanRequireCache = (filelist: string[]) => {
  if (process.env.MODERN_LIB_FORMAT !== 'esm') {
    filelist.forEach(filepath => {
      if (typeof require !== 'undefined' && require.cache) {
        delete require.cache[filepath];
      }
    });
  }
};

/**
 * Try to resolve npm package entry file path.
 * @param name - Package name.
 * @param resolvePath - Path to resolve dependencies.
 * @returns Resolved file path.
 */
const tryResolveESM = (name: string, ...resolvePath: string[]) => {
  const conditions = new Set(['node', 'import', 'module', 'default']);
  for (const p of resolvePath) {
    try {
      return fileURLToPath(
        moduleResolve(name, pathToFileURL(`${p}/`), conditions, false),
      );
    } catch (err) {
      // ignore
    }
  }
  const err = new Error(`Can not find module ${name}.`);
  (err as any).code = 'MODULE_NOT_FOUND';
  throw err;
};

export const tryResolve = (name: string, ...resolvePath: string[]) => {
  let filePath = '';
  try {
    if (process.env.MODERN_LIB_FORMAT === 'esm') {
      filePath = tryResolveESM(name, ...resolvePath);
    } else {
      filePath = require.resolve(name, { paths: resolvePath });
      delete require.cache[filePath];
    }
  } catch (err) {
    if ((err as any).code === 'MODULE_NOT_FOUND') {
      throw new Error(`Can not find module ${name}.`);
    }
    throw err;
  }
  return filePath;
};
