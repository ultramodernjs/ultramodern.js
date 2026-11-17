import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compile } from '@modern-js/server-utils';
import serverBuildPlugin from '../src/plugins/serverBuild';

rstest.mock('@modern-js/server-utils', () => ({ compile: rstest.fn() }));

type Context = {
  appDirectory: string;
  distDirectory: string;
  metaName: string;
  moduleType: 'commonjs';
  serverCompileExcludedFiles?: string[];
  serverCompileOwner?: string;
  resolveServerCompileSourceDirs?: () => string[];
};

async function fixture() {
  const appDirectory = await mkdtemp(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'modern-server-build-',
    ),
  );
  const serverDir = path.join(appDirectory, 'server');
  const sharedDir = path.join(appDirectory, 'shared');
  let context: Context = {
    appDirectory,
    distDirectory: path.join(appDirectory, 'dist'),
    metaName: 'modern-js',
    moduleType: 'commonjs',
  };
  let afterBuild: (() => Promise<void>) | undefined;
  const compiler = rstest.fn();
  const api = {
    getAppContext: () => context,
    updateAppContext: (update: Partial<Context>) => {
      context = { ...context, ...update };
    },
    getNormalizedConfig: () => ({
      source: { alias: {} },
      output: { sourceMap: false },
      tools: { serverCompiler: compiler },
    }),
    onAfterBuild: (callback: () => Promise<void>) => {
      afterBuild = callback;
    },
  };
  await mkdir(serverDir);
  await mkdir(sharedDir);
  await writeFile(path.join(appDirectory, 'tsconfig.json'), '{}');
  rstest.mocked(compile).mockReset();
  rstest.mocked(compile).mockResolvedValue({ rootFiles: [], emittedFiles: [] });
  serverBuildPlugin().setup!(api as never);
  return {
    appDirectory,
    serverDir,
    sharedDir,
    compiler,
    api,
    afterBuild: () => afterBuild!(),
    get context() {
      return context;
    },
    remove: () => rm(appDirectory, { recursive: true, force: true }),
  };
}

describe('server build compilation policy', () => {
  it('forwards current exclusions supplied after setup', async () => {
    const app = await fixture();
    try {
      await writeFile(path.join(app.serverDir, 'cache.ts'), 'export {};\n');
      // Policy can be supplied by another plugin after this plugin's setup.
      const excludeFiles = [path.join(app.appDirectory, 'src/client.d.ts')];
      app.api.updateAppContext({ serverCompileExcludedFiles: excludeFiles });
      await app.afterBuild();

      expect(compile).toHaveBeenCalledWith(
        app.appDirectory,
        { alias: {}, sourceMap: false },
        expect.objectContaining({ excludeFiles, compiler: app.compiler }),
      );
    } finally {
      await app.remove();
    }
  });

  it('compiles server and shared once for a server-only app without BFF', async () => {
    const app = await fixture();
    try {
      await writeFile(
        path.join(app.serverDir, 'modern.server.ts'),
        'export default {};\n',
      );
      await app.afterBuild();

      expect(compile).toHaveBeenCalledTimes(1);
      expect(rstest.mocked(compile).mock.calls[0][2].sourceDirs).toEqual([
        app.serverDir,
        app.sharedDir,
      ]);
    } finally {
      await app.remove();
    }
  });

  it('publishes the same gate lazily, reflecting the final app files', async () => {
    const app = await fixture();
    try {
      const resolve = app.context.resolveServerCompileSourceDirs!;
      // A server folder without cache or server config is not a server root.
      expect(resolve()).toEqual([]);
      await app.afterBuild();
      expect(compile).not.toHaveBeenCalled();

      await writeFile(path.join(app.serverDir, 'cache.js'), '');
      expect(resolve()).toEqual([app.serverDir, app.sharedDir]);
      await rm(app.sharedDir, { recursive: true });
      expect(resolve()).toEqual([app.serverDir]);
    } finally {
      await app.remove();
    }
  });

  it.each(['before setup', 'after setup'])(
    'leaves claimed server roots to their owner (claimed %s)',
    async when => {
      const app = await fixture();
      try {
        await writeFile(
          path.join(app.serverDir, 'modern.server.ts'),
          'export default {};\n',
        );
        if (when === 'before setup') {
          app.api.updateAppContext({ serverCompileOwner: 'owner' });
          serverBuildPlugin().setup!(app.api as never);
        } else {
          app.api.updateAppContext({ serverCompileOwner: 'owner' });
        }
        expect(app.context.serverCompileOwner).toBe('owner');
        await app.afterBuild();

        expect(compile).not.toHaveBeenCalled();
        expect(app.context.resolveServerCompileSourceDirs!()).toEqual([
          app.serverDir,
          app.sharedDir,
        ]);
      } finally {
        await app.remove();
      }
    },
  );
});
