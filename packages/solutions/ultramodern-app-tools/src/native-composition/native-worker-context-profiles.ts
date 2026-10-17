import fs from 'node:fs/promises';
import path from 'node:path';

const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.tsrx',
]);
const maxProfileModules = 32;
const maxProfilePathCharacters = 4096;
const reservedPathCharacters = /[\\:?#\u0000-\u001f\u007f]/u;

/** Resolve source imports without loading profile code into the config process. */
export async function resolveNativeWorkerContextProfiles(
  value: unknown,
  appDirectory: string,
): Promise<readonly string[]> {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value))
    throw new Error(
      'deploy.worker.federation.contextProfiles must be an array of relative source modules.',
    );
  const moduleCount = value.length;
  if (
    !Number.isInteger(moduleCount) ||
    moduleCount < 0 ||
    moduleCount > maxProfileModules
  )
    throw new Error(
      'deploy.worker.federation.contextProfiles supports at most 32 source modules.',
    );

  const modules: string[] = [];
  const lexicalModules = new Set<string>();
  for (let index = 0; index < moduleCount; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    const module: unknown =
      descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (
      typeof module !== 'string' ||
      module.length > maxProfilePathCharacters ||
      !module.startsWith('./') ||
      module !== module.trim() ||
      reservedPathCharacters.test(module) ||
      module
        .slice(2)
        .split('/')
        .some(segment => !segment || segment === '.' || segment === '..') ||
      !sourceExtensions.has(path.extname(module))
    )
      throw new Error(
        'Each native Worker context profile must be a plain ./ source-module path of at most 4096 characters.',
      );
    if (lexicalModules.has(module))
      throw new Error(
        'Native Worker context profiles contain a duplicate module.',
      );
    lexicalModules.add(module);
    modules.push(module);
  }
  if (!modules.length) return Object.freeze([]);

  const appRoot = await fs.realpath(appDirectory);
  if (!(await fs.stat(appRoot)).isDirectory())
    throw new Error(
      'Native Worker context profiles require an application directory.',
    );
  const inspected = await Promise.allSettled(
    modules.map(async module => {
      const canonical = await fs.realpath(path.resolve(appRoot, module));
      const relative = path.relative(appRoot, canonical);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error(
          'Native Worker context profile escapes its application directory.',
        );
      if (reservedPathCharacters.test(relative.split(path.sep).join('/')))
        throw new Error(
          'Native Worker context profile must resolve to a plain source-module path.',
        );
      if (!sourceExtensions.has(path.extname(canonical)))
        throw new Error(
          'Native Worker context profile must resolve to a source module.',
        );
      const stats = await fs.stat(canonical, { bigint: true });
      if (!stats.isFile())
        throw new Error(
          'Native Worker context profile must resolve to a source file.',
        );
      return { canonical, physical: `${stats.dev}:${stats.ino}` };
    }),
  );

  const imports: string[] = [];
  const canonicalModules = new Set<string>();
  const physicalModules = new Set<string>();
  for (const result of inspected) {
    if (result.status === 'rejected') throw result.reason;
    const { canonical, physical } = result.value;
    if (canonicalModules.has(canonical) || physicalModules.has(physical))
      throw new Error(
        'Native Worker context profiles refer to the same physical module.',
      );
    canonicalModules.add(canonical);
    physicalModules.add(physical);
    imports.push(canonical);
  }
  return Object.freeze(imports);
}
