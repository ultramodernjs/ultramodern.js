import { createHash } from 'node:crypto';
import { globSync } from 'node:fs';
import { builtinModules } from 'node:module';
import ncc from '@vercel/ncc';
import fs from 'fs-extra';
import { dirname, join } from 'path';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import { DEFAULT_EXTERNALS, ROOT_DIR } from './constant';
import { findDepPath, pick } from './helper';
import type { ParsedTask } from './types';

function emitAssets(
  assets: Record<string, { source: string }>,
  distPath: string,
) {
  for (const key of Object.keys(assets)) {
    const asset = assets[key];
    fs.outputFileSync(join(distPath, key), asset.source);
  }
}

function emitIndex(code: string, distPath: string) {
  const distIndex = join(distPath, 'index.js');
  fs.outputFileSync(distIndex, code);
}

function emitESMIndex(code: string, distPath: string) {
  const distIndex = join(distPath, 'index.mjs');
  fs.outputFileSync(
    distIndex,
    `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${code}`,
  );
}

async function emitDts(task: ParsedTask) {
  if (!task.emitDts) {
    return [require.resolve(`@types/${task.depName}/package.json`)];
  }
  const manifest = fs.readJSONSync(join(task.depPath, 'package.json'));
  const types =
    manifest.types ??
    manifest.typings ??
    manifest.exports?.types ??
    manifest.exports?.['.']?.types ??
    (fs.existsSync(join(task.depPath, 'index.d.ts'))
      ? 'index.d.ts'
      : undefined);
  const input = types
    ? join(task.depPath, types)
    : join(
        dirname(require.resolve(`@types/${task.depName}/package.json`)),
        'index.d.ts',
      );
  const externals = { ...DEFAULT_EXTERNALS, ...task.externals };
  const bundle = await rollup({
    input,
    external: name =>
      name.startsWith('node:') ||
      builtinModules.includes(name) ||
      name in externals,
    plugins: [dts({ respectExternal: true })],
  });
  try {
    await bundle.write({
      file: join(task.distPath, 'index.d.ts'),
      format: 'es',
      paths: externals,
    });
  } finally {
    await bundle.close();
  }
  return bundle.watchFiles;
}

function emitPackageJson(task: ParsedTask) {
  const packageJsonPath = join(task.depPath, 'package.json');
  const packageJson = fs.readJsonSync(packageJsonPath, 'utf-8');
  const outputPath = join(task.distPath, 'package.json');

  const pickedPackageJson = pick(packageJson, [
    'name',
    'author',
    'version',
    'funding',
    'license',
    'types',
    'typing',
    'typings',
    ...task.packageJsonField,
  ]);

  pickedPackageJson.types = 'index.d.ts';

  // The lodash forwarding package must not collide with the external package
  // when deployment tools group traced files by package name and version.
  pickedPackageJson.name =
    task.depName === 'lodash' ? 'lodash-compiled' : task.depName;

  if (task.ignoreDts) {
    delete pickedPackageJson.typing;
    delete pickedPackageJson.typings;
    pickedPackageJson.types = 'index.d.ts';
  }

  fs.writeJSONSync(outputPath, pickedPackageJson);
}

const licenseName = /^(?:license|licence|copying|notice)(?:\..*)?$/i;

function licenseFiles(directory: string) {
  return fs
    .readdirSync(directory)
    .filter(
      name =>
        licenseName.test(name) && fs.statSync(join(directory, name)).isFile(),
    );
}

function emitLicense(task: ParsedTask, declarationInputs: string[]) {
  const licenses = licenseFiles(task.depPath);
  if (licenses.length === 0) {
    throw new Error(`Missing license for ${task.depName}`);
  }
  for (const license of licenses) {
    fs.copySync(join(task.depPath, license), join(task.distPath, license));
  }
  const dependency = fs.readJSONSync(join(task.depPath, 'package.json'));
  const producer = fs.readJSONSync(
    join(ROOT_DIR, 'scripts/prebundle/package.json'),
  );
  const declarationPackages = new Map<
    string,
    { name: string; version: string; license: string }
  >();
  for (const input of declarationInputs) {
    const directory = findDepPath(task.depName, input);
    const source = fs.readJSONSync(join(directory, 'package.json'));
    if (!declarationPackages.has(source.name)) {
      declarationPackages.set(
        source.name,
        pick(source, ['name', 'version', 'license']),
      );
      for (const file of licenseFiles(directory)) {
        fs.copySync(
          join(directory, file),
          join(
            task.distPath,
            'declaration-licenses',
            source.name.replaceAll('/', '_'),
            file,
          ),
        );
      }
    }
  }
  fs.writeJSONSync(
    join(task.distPath, 'provenance.json'),
    {
      name: task.depName,
      sourceName: dependency.name,
      version: dependency.version,
      entrySha256: createHash('sha256')
        .update(fs.readFileSync(task.depEntry))
        .digest('hex'),
      license: dependency.license,
      repository: dependency.repository,
      producer: 'scripts/prebundle',
      ncc: producer.dependencies['@vercel/ncc'],
      declarations: producer.dependencies['rollup-plugin-dts'],
      declarationSources: [...declarationPackages.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      lockfileSha256: createHash('sha256')
        .update(fs.readFileSync(join(ROOT_DIR, 'pnpm-lock.yaml')))
        .digest('hex'),
    },
    { spaces: 2 },
  );
}

function emitExtraFiles(task: ParsedTask) {
  const { emitFiles } = task;
  emitFiles.forEach(item => {
    const path = join(task.distPath, item.path);
    fs.outputFileSync(path, item.content);
  });
}

function removeSourceMap(task: ParsedTask) {
  for (const mapPath of globSync('**/*.map', { cwd: task.distPath })) {
    fs.removeSync(join(task.distPath, mapPath));
  }
}

export async function prebundle(task: ParsedTask) {
  console.log(`==== Start prebundle "${task.depName}" ====`);

  if (task.clear) {
    fs.removeSync(task.distPath);
  }

  if (task.beforeBundle) {
    await task.beforeBundle(task);
  }

  const { code, assets } = await ncc(task.depEntry, {
    externals: {
      ...DEFAULT_EXTERNALS,
      ...task.externals,
    },
    assetBuilds: false,
    minify: task.minify,
    esm: false,
    license: 'licenses-cjs.txt',
  });

  if (task.depEsmEntry) {
    const { code: esmCode, assets: esmAssets } = await ncc(task.depEsmEntry, {
      externals: {
        ...DEFAULT_EXTERNALS,
        ...task.externals,
      },
      assetBuilds: false,
      minify: task.minify,
      esm: true,
      license: 'licenses-esm.txt',
    });
    emitESMIndex(esmCode, task.distPath);
    emitAssets(esmAssets, task.distPath);
  }

  emitIndex(code, task.distPath);
  emitAssets(assets, task.distPath);
  const declarationInputs = await emitDts(task);
  if (
    (task.depEsmEntry ||
      task.emitFiles.some(file => file.path === 'index.mjs')) &&
    task.emitDts
  ) {
    fs.copySync(
      join(task.distPath, 'index.d.ts'),
      join(task.distPath, 'index.d.mts'),
    );
  }
  emitLicense(task, declarationInputs);
  emitPackageJson(task);
  removeSourceMap(task);
  emitExtraFiles(task);

  if (task.afterBundle) {
    await task.afterBundle(task);
  }

  console.log(`==== Finish prebundle "${task.depName}" ====\n\n`);
}
