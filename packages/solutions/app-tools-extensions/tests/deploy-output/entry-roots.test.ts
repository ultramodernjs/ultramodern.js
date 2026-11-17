import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeDepEmit } from 'ndepe';
import {
  createNodeDeployEntryFilter,
  traceDeployFiles,
} from '../../src/deploy-output/trace-files';

for (const entry of ['api/index.ts', 'api/custom.mjs']) {
  it(`traces the bundled Effect entry ${entry} and its genuine imports, not unused source roots`, async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'effect-deploy-roots-')),
    );
    try {
      const outputDirectory = path.join(root, '.output');
      const emitted = entry.replace(/\.ts$/u, '.js');
      const write = async (relative: string, contents: string) => {
        const file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
      };
      await write(
        'package.json',
        '{"name":"effect-root-proof","private":true}\n',
      );
      await write(entry, 'export default {};\n');
      await write('.output/package.json', '{"type":"module"}\n');
      for (const relative of [
        'index.js',
        'server/config.js',
        'api/unreachable.js',
        'shared/unused.js',
        'src/unused.js',
        'static/asset.js',
        'static-other/keep.js',
        'server/config.js.map',
      ])
        await write(`.output/${relative}`, 'export default {};\n');
      await write(`.output/${emitted}`, "import '../shared/used.js';\n");
      await write('.output/shared/used.js', "import '../src/reached.js';\n");
      await write('.output/src/reached.js', 'export default 42;\n');
      const entryFilter = await createNodeDeployEntryFilter({
        appDirectory: root,
        outputDirectory,
        apiDirectory: path.join(root, 'api'),
        sharedDirectory: path.join(root, 'shared'),
        bff: {
          runtimeFramework: 'effect',
          effect: { entry },
        },
      });
      let entries: string[] = [];
      let traced = new Set<string>();
      await nodeDepEmit({
        appDir: root,
        sourceDir: outputDirectory,
        entryFilter,
        traceFiles: async options => {
          entries = options.entryFiles;
          const result = await traceDeployFiles(options);
          traced = new Set(
            [...result.fileList].map(file =>
              path.relative(
                outputDirectory,
                path.resolve(options.base ?? '/', file),
              ),
            ),
          );
          return result;
        },
      });
      expect(
        entries.map(file => path.relative(outputDirectory, file)).sort(),
      ).toEqual(
        [
          emitted,
          'index.js',
          'server/config.js',
          'static-other/keep.js',
        ].sort(),
      );
      expect(traced).toContain('shared/used.js');
      expect(traced).toContain('src/reached.js');
      expect(traced).not.toContain('shared/unused.js');
      expect(traced).not.toContain('src/unused.js');
      expect(traced).not.toContain('api/unreachable.js');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

it('retains ordinary, server-only and external Effect SDK source roots', async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'ordinary-deploy-roots-')),
  );
  try {
    const outputDirectory = path.join(root, '.output');
    const outside = path.join(root, 'node_modules/sdk/index.js');
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, 'export default {};\n');
    for (const bff of [
      undefined,
      { runtimeFramework: 'hono' },
      { runtimeFramework: 'effect' },
      {
        runtimeFramework: 'effect',
        effect: { entry: outside },
      },
      { runtimeFramework: 'effect', isCrossProjectServer: true },
    ]) {
      const filter = await createNodeDeployEntryFilter({
        appDirectory: root,
        outputDirectory,
        apiDirectory: path.join(root, 'api'),
        sharedDirectory: path.join(root, 'shared'),
        bff,
      });
      for (const relative of ['api/index.js', 'shared/data.js', 'src/route.js'])
        expect(filter(path.join(outputDirectory, relative))).toBe(true);
      expect(filter(path.join(outputDirectory, 'static/asset.js'))).toBe(false);
      expect(filter(path.join(outputDirectory, 'server/config.js.map'))).toBe(
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
