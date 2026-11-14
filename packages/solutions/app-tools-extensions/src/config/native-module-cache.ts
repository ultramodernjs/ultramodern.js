import { channel } from 'node:diagnostics_channel';
import { realpathSync } from 'node:fs';
import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const invalidations = channel('modern-js:dev:invalidate');
const revision = /\.__modern_dev_\d+(?=\.[^./]+$)/;

interface ModuleEntry {
  generation: number;
  parents: Set<string>;
  children: Set<string>;
}

/**
 * Native ESM cannot be evicted from require.cache. Give only invalidated app
 * modules new identities; virtual paths also work for require(esm), where Node
 * discards URL queries. Node still loads and strips the original source.
 * Virtual identities stay internal; module metadata still points to the source.
 */
export function createNativeModuleCache(appDirectory: string) {
  const appDir = realpathSync(appDirectory);
  const modules = new Map<string, ModuleEntry>();
  const cache = createRequire(path.join(appDir, 'package.json')).cache;

  const originalUrl = (value: string) => {
    const original = value.replace(revision, '');
    return modules.has(original) ? original : value;
  };

  const isAppModule = (url: string) => {
    if (!url.startsWith('file:')) return false;
    const relative = path.relative(appDir, fileURLToPath(url));
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      /\.(?:[cm]?[jt]s|json)$/.test(relative) &&
      !relative.split(path.sep).includes('node_modules')
    );
  };

  const entryFor = (url: string) => {
    let entry = modules.get(url);
    if (!entry) {
      entry = { generation: 0, parents: new Set(), children: new Set() };
      modules.set(url, entry);
    }
    return entry;
  };

  const versionedUrl = (url: string, generation: number) => {
    if (!generation) return url;
    const value = new URL(url);
    const extension = path.posix.extname(value.pathname);
    value.pathname = `${value.pathname.slice(0, -extension.length)}.__modern_dev_${generation}${extension}`;
    return value.href;
  };

  const invalidate = (message: unknown) => {
    if (typeof message !== 'string') return;
    const changed = pathToFileURL(message).href;
    const affected = new Set<string>();
    const visit = (url: string) => {
      if (affected.has(url)) return;
      const entry = modules.get(url);
      if (!entry) return;
      affected.add(url);
      for (const parent of entry.parents) visit(parent);
    };
    visit(changed);
    for (const url of affected) {
      const entry = entryFor(url);
      delete cache[fileURLToPath(versionedUrl(url, entry.generation))];
      entry.generation += 1;
    }
  };
  invalidations.subscribe(invalidate);

  const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
    const parentURL = context.parentURL && originalUrl(context.parentURL);
    const result = nextResolve(specifier, { ...context, parentURL });
    if (!isAppModule(result.url)) return result;
    const url = originalUrl(result.url);
    const entry = entryFor(url);
    if (parentURL && isAppModule(parentURL)) {
      entry.parents.add(parentURL);
      entryFor(parentURL).children.add(url);
    }
    return { ...result, url: versionedUrl(url, entry.generation) };
  };

  const load: LoadHookSync = (url, context, nextLoad) => {
    const original = originalUrl(url);
    const entry = modules.get(original);
    if (entry) {
      for (const child of entry.children) {
        modules.get(child)?.parents.delete(original);
      }
      entry.children.clear();
    }
    const result = nextLoad(original, context);
    if (url === original || !result.source) return result;
    if (result.format === 'json') return result;
    const source =
      typeof result.source === 'string'
        ? result.source
        : new TextDecoder().decode(result.source);
    // Type-only imports must not turn native CommonJS into an ESM module.
    const program = parse(
      original.endsWith('ts') ? stripTypeScriptTypes(source) : source,
      {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
      },
    ).program;
    const filename = fileURLToPath(original);
    const metadata =
      result.format === 'module' ||
      result.format === 'module-typescript' ||
      program.sourceType === 'module'
        ? `import.meta.url=${JSON.stringify(original)};import.meta.filename=${JSON.stringify(filename)};`
        : `__filename=${JSON.stringify(filename)};module.filename=__filename;`;
    const interpreterEnd = program.interpreter?.end;
    const start =
      program.directives.at(-1)?.end ??
      (typeof interpreterEnd === 'number'
        ? Math.min(interpreterEnd + 1, source.length)
        : 0);
    return {
      ...result,
      source: `${source.slice(0, start)}${start === source.length ? '\n' : ';'}${metadata}${source.slice(start)}`,
    };
  };

  return {
    resolve,
    load,
    dispose() {
      invalidations.unsubscribe(invalidate);
      modules.clear();
    },
  };
}
