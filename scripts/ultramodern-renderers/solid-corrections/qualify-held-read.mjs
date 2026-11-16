import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const readHeldReadRecipeBytes = () =>
  fs.readFileSync(new URL('./held-read-recipe.json', import.meta.url));

const environmentKeys = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
]);

/** Creates and always removes workDirectory. Its parent must exist; workDirectory must not. */
export async function qualifyHeldRead(options = {}) {
  return qualifyHeldReadImplementation(options);
}

export async function qualifyHeldReadPacked({
  workDirectory,
  toolchain,
  run,
  fetch,
  recipeBytes,
  payloads,
  manifest,
  lifecycle,
  effectCompiler,
} = {}) {
  assert(
    payloads instanceof Map &&
      payloads.size === 1 &&
      Buffer.isBuffer(payloads.get('solid-js')),
    'Exactly the actual solid-js transport bytes are required',
  );
  assert.equal(manifest?.name, 'solid-js');
  assert.equal(manifest.version, '2.0.0-rc.22');
  assert.equal(
    manifest.integrity,
    `sha512-${createHash('sha512').update(payloads.get('solid-js')).digest('base64')}`,
    'Actual packed Solid transport integrity mismatch',
  );
  return qualifyHeldReadImplementation({
    workDirectory,
    storeDirectory: toolchain?.storeDirectory,
    nodeBinary: toolchain?.node,
    pnpmBinary: toolchain?.pnpm,
    run,
    fetch,
    recipeBytes,
    lifecycle,
    effectCompiler,
    packed: {
      bytes: Buffer.from(payloads.get('solid-js')),
      manifest: { ...manifest },
    },
  });
}

async function qualifyHeldReadImplementation({
  workDirectory,
  storeDirectory,
  recipeBytes,
  run: execute = (command, args, options) => spawnSync(command, args, options),
  fetch: fetchImpl = globalThis.fetch,
  nodeBinary = process.execPath,
  pnpmBinary = 'pnpm',
  typescriptBinary,
  effectCompiler,
  lifecycle,
  packed,
} = {}) {
  assert(
    path.isAbsolute(workDirectory ?? ''),
    'workDirectory must be absolute',
  );
  assert(
    path.isAbsolute(storeDirectory ?? ''),
    'An external absolute storeDirectory is required',
  );
  assert(
    !fs.existsSync(workDirectory),
    'workDirectory must be fresh and operation-owned',
  );
  assert(
    path.relative(workDirectory, storeDirectory).startsWith('..'),
    'Package store must be outside workDirectory',
  );
  assert(
    Buffer.isBuffer(recipeBytes) || typeof recipeBytes === 'string',
    'Reviewed static recipeBytes are required',
  );
  const recipe = JSON.parse(recipeBytes.toString());
  assert.deepEqual(
    recipe,
    JSON.parse(readHeldReadRecipeBytes()),
    'Recipe differs from reviewed dependency identities/selectors',
  );
  const provenance = JSON.parse(
    fs.readFileSync(
      new URL('./held-read-provenance.json', import.meta.url),
      'utf8',
    ),
  );
  const patches = {};
  for (const [name, digest] of Object.entries(provenance.patches)) {
    const bytes = fs.readFileSync(new URL(name, import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      digest,
      `Canonical patch changed: ${name}`,
    );
    patches[name] = { bytes, sha256: digest };
  }
  const directory = workDirectory;
  const dependencies = path.join(directory, 'node_modules');
  const build = path.join(directory, 'build');
  const commit = provenance.source.commit;
  const tuple = Object.fromEntries(
    Object.entries(recipe.dependencies).map(([name, item]) => [
      name,
      item.version,
    ]),
  );
  const registryProof = {};
  const registered = [];
  async function run(command, args, { failure = false, ...options } = {}) {
    const result = await execute(command, args, {
      cwd: directory,
      encoding: 'utf8',
      ...options,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            environmentKeys.has(key),
          ),
        ),
        CI: 'true',
        TMPDIR: directory,
      },
    });
    if (!failure)
      assert.equal(
        result.status,
        0,
        `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
      );
    return result;
  }
  async function register(filename, kind) {
    registered.push(filename);
    await lifecycle?.register?.({ path: filename, kind });
  }
  async function fetchBytes(url) {
    const result = await fetchImpl(url);
    assert(result.ok, `${url}: ${result.status}`);
    return Buffer.from(await result.arrayBuffer());
  }
  // Block YAML is deliberately emitted without a repository dependency: pnpm may add release-age entries.
  const writeWorkspace = root =>
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages: []\noverrides:\n' +
        Object.entries(recipe.serializerOverrides)
          .map(
            ([selector, version]) =>
              `  ${JSON.stringify(selector)}: ${JSON.stringify(version)}\n`,
          )
          .join(''),
    );
  fs.mkdirSync(directory);
  try {
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        packageManager: `pnpm@${recipe.pnpm}`,
        dependencies: tuple,
      }),
    );
    writeWorkspace(directory);
    assert.equal(
      (await run(nodeBinary, ['--version'])).stdout.trim(),
      `v${recipe.node}`,
    );
    assert.equal(
      (await run(pnpmBinary, ['--version'])).stdout.trim(),
      recipe.pnpm,
    );
    await run(pnpmBinary, [
      'install',
      '--ignore-scripts',
      '--strict-peer-dependencies',
      '--config.package-import-method=clone-or-copy',
      `--store-dir=${storeDirectory}`,
    ]);
    await register(dependencies, 'dependencies');
    fs.mkdirSync(build);
    await register(build, 'build');
    const require = createRequire(path.join(directory, 'package.json'));
    const packageRoot = (request, from = require, name = request) => {
      let current = path.dirname(fs.realpathSync(from.resolve(request)));
      for (;;) {
        const manifest = path.join(current, 'package.json');
        if (
          fs.existsSync(manifest) &&
          JSON.parse(fs.readFileSync(manifest)).name === name
        )
          return current;
        const parent = path.dirname(current);
        assert.notEqual(current, parent);
        current = parent;
      }
    };
    const installed = {};
    for (const name of Object.keys(tuple)) {
      const metadata = JSON.parse(
        await fetchBytes(`https://registry.npmjs.org/${name}/${tuple[name]}`),
      );
      if (provenance.packages[name])
        assert.equal(metadata.gitHead, commit, `${name} source identity`);
      assert.equal(
        metadata.dist.integrity,
        recipe.dependencies[name].integrity,
        `${name} pinned registry integrity`,
      );
      const bytes = await fetchBytes(metadata.dist.tarball);
      assert.equal(
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        metadata.dist.integrity,
      );
      const archive = path.join(build, `${name.replaceAll('/', '-')}.tgz`);
      fs.writeFileSync(archive, bytes);
      const source = `${archive}.source`;
      fs.mkdirSync(source);
      await run('tar', ['-xzf', archive, '-C', source]);
      installed[name] = packageRoot(
        name === 'seroval-plugins'
          ? 'seroval-plugins/web'
          : name === 'typescript'
            ? 'typescript/package.json'
            : name === 'csstype'
              ? 'csstype/package.json'
              : name,
        require,
        name,
      );
      let files = 0;
      const compare = relative => {
        for (const item of fs.readdirSync(
          path.join(source, 'package', relative),
          { withFileTypes: true },
        )) {
          const filename = path.join(relative, item.name);
          if (item.isDirectory()) compare(filename);
          else {
            const expected = fs.readFileSync(
              path.join(source, 'package', filename),
            );
            assert.deepEqual(
              fs.readFileSync(path.join(installed[name], filename)),
              expected,
              `fixture ${name}/${filename}`,
            );
            files++;
          }
        }
      };
      compare('');
      registryProof[name] = {
        integrity: metadata.dist.integrity,
        gitHead: metadata.gitHead,
        files,
      };
    }
    const archive = await fetchBytes(
      `https://codeload.github.com/solidjs/solid/tar.gz/${commit}`,
    );
    assert.equal(
      createHash('sha256').update(archive).digest('hex'),
      provenance.source.archiveSha256,
      'Pinned upstream source archive changed',
    );
    fs.writeFileSync(path.join(build, 'source.tgz'), archive);
    await run('tar', ['-xzf', path.join(build, 'source.tgz'), '-C', build]);
    const source = path.join(build, `solid-${commit}`);
    const original = path.join(source, 'packages/solid/src/index.ts');
    const sourceIndex = fs.readFileSync(original, 'utf8');
    assert.equal(
      createHash('sha1')
        .update(`blob ${Buffer.byteLength(sourceIndex)}\0`)
        .update(sourceIndex)
        .digest('hex'),
      provenance.source.indexGitBlob,
      'Upstream source index Git blob identity',
    );
    assert(
      sourceIndex.includes(
        'export { setSwapHook, isHidden, heldRead } from "@solidjs/signals";',
      ),
    );
    const project = path.join(directory, 'source-build.json');
    const emit = path.join(build, 'emitted');
    const compiler =
      typescriptBinary ??
      require
        .resolve('typescript/package.json')
        .replace(/package\.json$/u, 'bin/tsc');
    assert.equal(
      await (await run(nodeBinary, [compiler, '--version'])).stdout.trim(),
      'Version 7.0.2',
    );
    const config = {
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        declaration: true,
        emitDeclarationOnly: true,
        stripInternal: true,
        rootDir: path.dirname(original),
        outDir: emit,
        types: [],
        jsx: 'preserve',
        paths: {
          'solid-js': [original],
          'solid-js/internal': [
            path.join(path.dirname(original), 'internal.ts'),
          ],
        },
      },
      include: [path.join(path.dirname(original), '**/*.ts')],
    };
    fs.writeFileSync(project, JSON.stringify(config));
    const typeProbe = path.join(directory, 'public-api.ts');
    fs.copyFileSync(
      new URL('./held-read-public-api.ts', import.meta.url),
      typeProbe,
    );
    const checkConfig = {
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      },
      files: [typeProbe],
    };
    fs.writeFileSync(
      path.join(directory, 'check.json'),
      JSON.stringify(checkConfig),
    );
    const before = await run(
      nodeBinary,
      [compiler, '-p', path.join(directory, 'check.json')],
      { failure: true },
    );
    assert.notEqual(
      before.status,
      0,
      'Pristine rc22 must fail public type closure',
    );
    assert.match(before.stdout + before.stderr, /TS2305[\s\S]*heldRead/u);
    // The canonical owning source is corrected before declaration emission.
    await run(
      'patch',
      [
        '-p1',
        '--batch',
        '--fuzz=0',
        '-i',
        fileURLToPath(new URL('./held-read-source.patch', import.meta.url)),
      ],
      { cwd: source },
    );
    await run(nodeBinary, [compiler, '-p', project]);
    const declaration = fs.readFileSync(path.join(emit, 'index.d.ts'), 'utf8');
    assert(
      !declaration.includes('setSwapHook'),
      'Unrelated internal helpers must remain stripped',
    );
    assert(
      !declaration.includes('isHidden'),
      'Unrelated internal helpers must remain stripped',
    );
    assert(declaration.includes('getOwner, heldRead,'));
    const reconstructed = path.join(build, 'reconstruction');
    fs.mkdirSync(reconstructed);
    const corrected = path.join(reconstructed, 'package');
    fs.cpSync(installed['solid-js'], corrected, { recursive: true });
    fs.copyFileSync(
      path.join(emit, 'index.d.ts'),
      path.join(corrected, 'types/index.d.ts'),
    );
    // Install the reconstructed package normally: no paths alias or installed-file patch.
    const correctedTarball = path.join(
      build,
      'solid-js-rc22-held-read-correction.tgz',
    );
    await run('tar', [
      '-czf',
      correctedTarball,
      '-C',
      reconstructed,
      'package',
    ]);
    if (packed) {
      const payloadFile = path.join(build, 'actual-transport.tgz');
      fs.writeFileSync(payloadFile, packed.bytes);
      const entries = (await run('tar', ['-tzf', payloadFile])).stdout
        .trim()
        .split('\n');
      assert.equal(
        new Set(entries).size,
        entries.length,
        'Duplicate packed entries',
      );
      for (const entry of entries)
        assert(
          entry.startsWith('package/') &&
            !entry.split('/').includes('..') &&
            !entry.includes('\\'),
          `Unsafe transport entry ${entry}`,
        );
      const listing = (await run('tar', ['-tvzf', payloadFile])).stdout
        .trim()
        .split('\n');
      for (const entry of listing)
        assert(
          ['-', 'd'].includes(entry[0]),
          'Packed payload links and special files are forbidden',
        );
      const unpacked = path.join(build, 'transport');
      fs.mkdirSync(unpacked);
      await run('tar', ['-xzf', payloadFile, '-C', unpacked]);
      const inventory = root => {
        const items = {};
        const visit = relative => {
          for (const item of fs.readdirSync(path.join(root, relative), {
            withFileTypes: true,
          })) {
            const name = path.join(relative, item.name);
            assert(!item.isSymbolicLink(), 'Symlink payload forbidden');
            if (item.isDirectory()) visit(name);
            else {
              assert(item.isFile(), 'Special payload forbidden');
              items[name] = createHash('sha256')
                .update(fs.readFileSync(path.join(root, name)))
                .digest('hex');
            }
          }
        };
        visit('');
        return items;
      };
      assert.deepEqual(
        inventory(path.join(unpacked, 'package')),
        inventory(corrected),
        'Actual packed payload differs from canonical source-generated correction',
      );
      const metadata = JSON.parse(
        fs.readFileSync(path.join(unpacked, 'package/package.json')),
      );
      assert.equal(metadata.name, packed.manifest.name);
      assert.equal(metadata.version, packed.manifest.version);
      // The install below consumes the actual caller buffer, not our reconstructed tarball.
      fs.writeFileSync(correctedTarball, packed.bytes);
    }
    const consumer = path.join(directory, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        packageManager: 'pnpm@12.21.0',
        dependencies: { ...tuple, 'solid-js': `file:${correctedTarball}` },
      }),
    );
    writeWorkspace(consumer);
    await run(
      pnpmBinary,
      [
        'install',
        '--ignore-scripts',
        '--strict-peer-dependencies',
        '--config.package-import-method=clone-or-copy',
        `--store-dir=${storeDirectory}`,
      ],
      { cwd: consumer },
    );
    await register(path.join(consumer, 'node_modules'), 'dependencies');
    fs.copyFileSync(typeProbe, path.join(consumer, 'public-api.ts'));
    assert.equal(checkConfig.compilerOptions.skipLibCheck, false);
    assert.equal(checkConfig.compilerOptions.paths, undefined);
    fs.writeFileSync(
      path.join(consumer, 'check.json'),
      JSON.stringify({ ...checkConfig, files: ['./public-api.ts'] }),
    );
    await run(nodeBinary, [compiler, '-p', path.join(consumer, 'check.json')]);
    let effectCompilerResult = {
      status: 'pending',
      reason: 'No owned Effect compiler payload supplied',
    };
    if (effectCompiler) {
      const stamp = await run(effectCompiler.binary, ['--version']);
      assert.match(
        stamp.stdout,
        /effect-tsgo/u,
        'Injected Effect compiler must identify its real payload',
      );
      await run(effectCompiler.binary, [
        '--project',
        path.join(consumer, 'check.json'),
      ]);
      effectCompilerResult = { status: 'passed', version: stamp.stdout.trim() };
    }
    const consumerRequire = createRequire(path.join(consumer, 'package.json'));
    const served = packageRoot('solid-js', consumerRequire);
    const verifyUnchanged = relative => {
      for (const item of fs.readdirSync(
        path.join(installed['solid-js'], relative),
        { withFileTypes: true },
      )) {
        const filename = path.join(relative, item.name);
        if (item.isDirectory()) verifyUnchanged(filename);
        else if (filename !== 'types/index.d.ts')
          assert.deepEqual(
            fs.readFileSync(path.join(served, filename)),
            fs.readFileSync(path.join(installed['solid-js'], filename)),
            `No unrelated package byte may change: ${filename}`,
          );
      }
    };
    verifyUnchanged('');
    assert.equal(
      fs.readFileSync(path.join(served, 'types/index.d.ts'), 'utf8'),
      declaration,
    );
    const diff = await run(
      'diff',
      [
        '-u',
        '--label',
        'a/types/index.d.ts',
        '--label',
        'b/types/index.d.ts',
        path.join(installed['solid-js'], 'types/index.d.ts'),
        path.join(emit, 'index.d.ts'),
      ],
      { failure: true },
    );
    assert.equal(diff.status, 1);
    assert.equal(
      diff.stdout,
      fs.readFileSync(
        new URL('./held-read-declarations.patch', import.meta.url),
        'utf8',
      ),
      'Canonical declaration patch must equal actual stable-TS7 source emission',
    );
    await run(nodeBinary, [
      fileURLToPath(new URL('./held-read-runtime.mjs', import.meta.url)),
      consumer,
    ]);

    const licenseBytes = fs.readFileSync(path.join(source, 'LICENSE'));
    assert.match(licenseBytes.toString(), /MIT License/u);
    return {
      status: 'passed',
      sourceArchive: {
        bytes: archive,
        sha256: provenance.source.archiveSha256,
        commit,
      },
      patches,
      license: {
        path: 'LICENSE',
        bytes: licenseBytes,
        sha256: createHash('sha256').update(licenseBytes).digest('hex'),
      },
      evidence: {
        registryProof,
        serializerPolicy: recipe.serializerOverrides,
        compiler: recipe.dependencies.typescript.version,
        before: before.stdout,
        transport: packed
          ? {
              status: 'passed',
              integrity: packed.manifest.integrity,
              installedActualPayload: true,
            }
          : { status: 'not-requested' },
        checks: [
          'stable-ts7-fail-before',
          'owning-source-declaration-emission',
          'normally-installed-corrected-tarball-public-api',
          'all-runtime-and-metadata-bytes-unchanged',
          'unchanged-real-runtime',
        ],
        effectCompiler: effectCompilerResult,
      },
    };
  } finally {
    try {
      for (const filename of registered)
        await lifecycle?.release?.({ path: filename });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(
    process.env.OWNED_TEMP_DIR,
    'CLI requires an owned operation directory',
  );
  assert(process.env.PNPM_STORE_DIR, 'CLI requires external PNPM_STORE_DIR');
  const result = await qualifyHeldRead({
    workDirectory: path.join(process.env.OWNED_TEMP_DIR, 'held-read-portable'),
    storeDirectory: process.env.PNPM_STORE_DIR,
    recipeBytes: readHeldReadRecipeBytes(),
  });
  console.log(
    JSON.stringify(
      {
        status: result.status,
        sourceArchiveSha256: result.sourceArchive.sha256,
        licenseSha256: result.license.sha256,
        evidence: result.evidence,
      },
      null,
      2,
    ),
  );
}
