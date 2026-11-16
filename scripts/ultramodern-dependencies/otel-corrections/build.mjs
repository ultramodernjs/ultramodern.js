import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { validateMappings } from './mappings.mjs';

export const compilerOptions = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  skipLibCheck: false,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  inlineSources: true,
  noEmitOnError: true,
  rewriteRelativeImportExtensions: true,
  types: ['node'],
};
export function files(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry =>
      entry.isDirectory()
        ? files(path.join(root, entry.name)).map(
            file => `${entry.name}/${file}`,
          )
        : [entry.name],
    );
}
export function tree(root) {
  return Object.fromEntries(
    files(root).map(file => [
      file,
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}
export function assertOwned(root) {
  assert(
    process.env.OWNED_TEMP_DIR &&
      path
        .resolve(root)
        .startsWith(`${path.resolve(process.env.OWNED_TEMP_DIR)}/`),
    'build outputs must be inside owned temp directory',
  );
}
export function validateMaps(root) {
  let count = 0;
  for (const emitted of files(path.join(root, 'dist')).filter(
    file => file.endsWith('.js') || file.endsWith('.d.ts'),
  ))
    assert(
      fs.existsSync(path.join(root, 'dist', emitted + '.map')),
      `missing map: ${emitted}`,
    );
  for (const file of files(path.join(root, 'dist')).filter(file =>
    file.endsWith('.map'),
  )) {
    const absolute = path.join(root, 'dist', file);
    const map = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    assert.equal(map.version, 3);
    assert(map.mappings.length > 0);
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert(!map.sourceRoot || !path.isAbsolute(map.sourceRoot));
    assert.equal(map.file, path.basename(file).replace(/\.map$/, ''));
    map.sources.forEach((source, index) => {
      assert(!path.isAbsolute(source) && !source.includes('://'));
      const target = path.resolve(
        path.dirname(absolute),
        map.sourceRoot ?? '',
        source,
      );
      assert(target.startsWith(`${root}/src/`));
      assert.equal(map.sourcesContent[index], fs.readFileSync(target, 'utf8'));
    });
    validateMappings(map, fs.readFileSync(absolute.slice(0, -4), 'utf8'));
    assert(
      fs
        .readFileSync(absolute.slice(0, -4), 'utf8')
        .includes(`sourceMappingURL=${path.basename(file)}`),
    );
    count++;
  }
  assert(count > 0);
  return count;
}
export function rebuild(root, modules, registerBuild) {
  assertOwned(root);
  const config = path.join(
    path.dirname(root),
    `${path.basename(root)}-build.json`,
  );
  const link = path.join(root, 'node_modules');
  assert(!fs.existsSync(link));
  fs.symlinkSync(modules, link, 'dir');
  // This is only an operation-owned copy, never an existing checkout's dist.
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'dist'));
  registerBuild(path.join(root, 'dist'));
  const options = {
    ...compilerOptions,
    typeRoots: [path.join(modules, '@types')],
    rootDir: path.join(root, 'src'),
    outDir: path.join(root, 'dist'),
  };
  fs.writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: options,
      include: [`${root}/src/**/*.ts`],
    }),
  );
  try {
    execFileSync(path.join(modules, '.bin/tsc'), ['-p', config], {
      stdio: 'inherit',
    });
    // TypeScript declaration maps omit sourcesContent. Embed the exact compiler
    // input without altering mappings, just as inlineSources does for JS maps.
    for (const file of files(path.join(root, 'dist')).filter(file =>
      file.endsWith('.d.ts.map'),
    )) {
      const absolute = path.join(root, 'dist', file);
      const map = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      map.sourcesContent = map.sources.map(source =>
        fs.readFileSync(
          path.resolve(path.dirname(absolute), map.sourceRoot ?? '', source),
          'utf8',
        ),
      );
      fs.writeFileSync(absolute, JSON.stringify(map));
    }
    return validateMaps(root);
  } finally {
    fs.unlinkSync(link);
    fs.unlinkSync(config);
  }
}
export function createPatch(original, corrected, destination) {
  const scratch = path.join(path.dirname(corrected), 'patch-layout');
  assertOwned(scratch);
  fs.mkdirSync(scratch);
  fs.cpSync(original, path.join(scratch, 'a'), { recursive: true });
  fs.cpSync(corrected, path.join(scratch, 'b'), { recursive: true });
  const result = spawnSync(
    'git',
    [
      '-c',
      'diff.algorithm=myers',
      '-c',
      'core.autocrlf=false',
      'diff',
      '--no-index',
      '--no-prefix',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--unified=3',
      '--indent-heuristic',
      '--binary',
      '--',
      'a',
      'b',
    ],
    {
      cwd: scratch,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 1);
  assert(result.stdout.startsWith('diff --git a/'));
  fs.writeFileSync(destination, result.stdout);
  return createHash('sha256').update(result.stdout).digest('hex');
}
