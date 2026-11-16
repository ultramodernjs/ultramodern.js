// One public Rslib library build: the unchanged @rslib/core receives the
// selected rsbuild-plugin-dts through lib.plugins and lib.dts stays unset.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [fixture, pluginEntry, typescriptPath, app] = process.argv.slice(2);
const { pluginDts } = await import(pathToFileURL(pluginEntry).href);
const { createRslib } = await import(
  pathToFileURL(
    createRequire(path.join(fixture, 'package.json')).resolve('@rslib/core'),
  ).href
);
const rslib = await createRslib({
  cwd: app,
  config: {
    lib: [
      {
        format: 'esm',
        bundle: false,
        source: { entry: { index: ['src/index.ts'] } },
        plugins: [
          pluginDts({
            bundle: false,
            distPath: 'dist/types',
            tsgo: true,
            typescriptPath,
            dtsExtension: '.d.ts',
            autoExternal: true,
          }),
        ],
      },
    ],
    output: { target: 'node', distPath: { root: 'dist/esm' } },
  },
});
await rslib.build();
