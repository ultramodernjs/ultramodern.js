import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { builtinModules, createRequire, Module } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAdmissionPackages } from './native-artifact.mjs';

// This driver admits the installed native pair with the owning framework's
// Element-fragment source contract. It is separate from packed/generated proof.
const root = fs.realpathSync(process.cwd());
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const strictOnly = process.argv.includes('--strict-only');
const prepareSourceHost = process.argv.includes('--prepare-source-host');
const sourceHostArgument = process.argv
  .slice(2)
  .find(argument => argument.startsWith('--source-host='))
  ?.slice('--source-host='.length);
const workspace =
  process.argv.slice(2).find(argument => !argument.startsWith('--')) ??
  manifest.ultramodernAdmission?.workspacePath;
assert.ok(
  workspace && path.isAbsolute(workspace),
  'Pass the owning workspace.',
);
const require = createRequire(path.join(root, 'package.json'));
const packages = await validateAdmissionPackages({
  root,
  workspacePath: workspace,
  nativeArtifacts: manifest.ultramodernAdmission?.nativeArtifacts,
  nativeArchives: manifest.ultramodernAdmission?.nativeArchives,
});
assert.ok(packages.nativeArtifact?.installedBytesVerified);
assert.ok(packages.nativeRouterArtifact?.installedBytesVerified);
const { rspack } = await import(pathToFileURL(require.resolve('@rspack/core')));
const { OctaneRspackPlugin } = await import(
  pathToFileURL(require.resolve('@octanejs/rspack-plugin'))
);
const { createRsbuild } = await import(
  pathToFileURL(require.resolve('@rsbuild/core'))
);
const { chromium } = require('playwright-core');
const originalAdapter = path.join(
  workspace,
  'packages/runtime/renderer-octane',
);
const originalCore = path.join(workspace, 'packages/runtime/renderer-core');
const originalSource = path.join(root, 'router-fragment-fixture');
assert.ok(
  sourceHostArgument && path.isAbsolute(sourceHostArgument),
  'Pass an allocated, registered --source-host directory.',
);
const sourceHost = fs.realpathSync(sourceHostArgument);
assert.equal(path.dirname(sourceHost), root);
assert.ok(path.basename(sourceHost).startsWith('router-fragment-source-host-'));
const adapter = path.join(sourceHost, 'renderer-octane');
const source = path.join(sourceHost, 'fixture');
const output = path.join(root, 'dist/router-fragment');
assert.ok(
  fs.existsSync(originalSource),
  'Copy the authored router-fragment fixtures.',
);
const digestFile = file =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const authoredInputs = [
  'router-fragment.mjs',
  ...['client.ts', 'server.ts', 'routes.tsx', 'Leaf.tsx', 'Sibling.tsx'].map(
    file => `router-fragment-fixture/${file}`,
  ),
]
  .sort()
  .map(file => ({ file, sha256: digestFile(path.join(root, file)) }));
const consumerCohort = ['package.json', 'pnpm-lock.yaml'].map(file => ({
  file,
  sha256: digestFile(path.join(root, file)),
}));
const strictConfigInput = {
  file: 'router-fragment-fixture/tsconfig.json',
  sha256: digestFile(path.join(originalSource, 'tsconfig.json')),
};
const frameworkSnapshot = new Map();
function snapshot(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) snapshot(file);
    else if (item.isFile()) frameworkSnapshot.set(file, digestFile(file));
    else assert.fail(`Authored source contains a special file: ${file}`);
  }
}
function sourceFileSet(directory, relative = '') {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap(item => {
      const file = path.join(relative, item.name);
      if (item.isDirectory()) return sourceFileSet(directory, file);
      assert.ok(
        item.isFile(),
        `Staged source contains a special file: ${file}`,
      );
      return [file];
    })
    .sort();
}
snapshot(path.join(originalAdapter, 'src'));
snapshot(path.join(originalCore, 'src'));
const frameworkManifests = [originalAdapter, originalCore].map(directory => ({
  file: path.relative(workspace, path.join(directory, 'package.json')),
  sha256: digestFile(path.join(directory, 'package.json')),
}));
const frameworkModules = new Map();

if (prepareSourceHost) {
  assert.deepEqual(
    fs.readdirSync(sourceHost).filter(file => file !== '.disk-guardian-owner'),
    [],
    'Source host may contain only its lifecycle ownership marker.',
  );
  let prepared = false;
  try {
    fs.cpSync(
      path.join(originalCore, 'src'),
      path.join(sourceHost, 'core-package/src'),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(originalCore, 'package.json'),
      path.join(sourceHost, 'core-package/package.json'),
    );
    fs.cpSync(path.join(originalAdapter, 'src'), path.join(adapter, 'src'), {
      recursive: true,
    });
    fs.mkdirSync(source);
    for (const file of [
      'client.ts',
      'server.ts',
      'routes.tsx',
      'Leaf.tsx',
      'Sibling.tsx',
      'tsconfig.json',
    ])
      fs.copyFileSync(path.join(originalSource, file), path.join(source, file));
    fs.writeFileSync(
      path.join(sourceHost, 'package.json'),
      `${JSON.stringify(
        {
          name: 'ultramodern-octane-router-source-host',
          private: true,
          type: 'module',
          dependencies: { '@modern-js/renderer-core': 'file:./core-package' },
        },
        null,
        2,
      )}\n`,
    );
    for (const [file, sha256] of frameworkSnapshot) {
      const packageRoot = file.startsWith(`${originalAdapter}${path.sep}`)
        ? originalAdapter
        : originalCore;
      const copiedRoot =
        packageRoot === originalAdapter
          ? adapter
          : path.join(sourceHost, 'core-package');
      assert.equal(
        digestFile(file),
        sha256,
        `Framework source changed during staging: ${file}`,
      );
      assert.equal(
        digestFile(path.join(copiedRoot, path.relative(packageRoot, file))),
        sha256,
      );
    }
    assert.equal(
      digestFile(path.join(sourceHost, 'core-package/package.json')),
      frameworkManifests[1].sha256,
    );
    for (const input of frameworkManifests)
      assert.equal(digestFile(path.join(workspace, input.file)), input.sha256);
    for (const file of [
      'client.ts',
      'server.ts',
      'routes.tsx',
      'Leaf.tsx',
      'Sibling.tsx',
      'tsconfig.json',
    ])
      assert.equal(
        digestFile(path.join(source, file)),
        digestFile(path.join(originalSource, file)),
      );
    prepared = true;
    console.log(
      JSON.stringify({
        preparedSourceHost: sourceHost,
        installRequired: [
          'pnpm',
          'install',
          '--ignore-workspace',
          '--strict-peer-dependencies',
        ],
        owningManifestBytesCopied: true,
        authoredSourceBytesCopied: true,
        requiresDeclaredSeroval: '1.6.2',
        existingNativeDependencyGraphUntouched: true,
        sourceHostRetainedCallerOwned: true,
        resourcesClosed: true,
      }),
    );
  } finally {
    if (!prepared) {
      for (const child of [
        'core-package',
        'renderer-octane',
        'fixture',
        'package.json',
      ])
        fs.rmSync(path.join(sourceHost, child), {
          recursive: true,
          force: true,
        });
    }
  }
} else {
  const core = fs.realpathSync(
    path.join(sourceHost, 'node_modules/@modern-js/renderer-core'),
  );
  for (const [original, staged] of [
    [originalAdapter, adapter],
    [originalCore, path.join(sourceHost, 'core-package')],
    [originalCore, core],
  ])
    assert.deepEqual(
      sourceFileSet(path.join(staged, 'src')),
      sourceFileSet(path.join(original, 'src')),
      `Staged authored source file set differs: ${staged}`,
    );
  const stagedOrigins = new Map();
  for (const [file, sha256] of frameworkSnapshot) {
    const packageRoot = file.startsWith(`${originalAdapter}${path.sep}`)
      ? originalAdapter
      : originalCore;
    const copiedRoot =
      packageRoot === originalAdapter
        ? adapter
        : path.join(sourceHost, 'core-package');
    const relative = path.relative(packageRoot, file);
    const copied = path.join(copiedRoot, relative);
    assert.equal(
      digestFile(copied),
      sha256,
      `Copied source differs: ${copied}`,
    );
    const entered =
      packageRoot === originalAdapter ? copied : path.join(core, relative);
    assert.equal(
      digestFile(entered),
      sha256,
      `Installed source differs: ${entered}`,
    );
    stagedOrigins.set(fs.realpathSync(entered), file);
  }
  for (const file of [
    'client.ts',
    'server.ts',
    'routes.tsx',
    'Leaf.tsx',
    'Sibling.tsx',
    'tsconfig.json',
  ])
    assert.equal(
      digestFile(path.join(source, file)),
      digestFile(path.join(originalSource, file)),
      `Staged fixture differs: ${file}`,
    );
  assert.equal(
    digestFile(path.join(sourceHost, 'core-package/package.json')),
    frameworkManifests[1].sha256,
  );
  assert.equal(
    digestFile(path.join(core, 'package.json')),
    frameworkManifests[1].sha256,
  );
  const coreRequire = createRequire(path.join(core, 'package.json'));
  const serovalEntry = fs.realpathSync(coreRequire.resolve('seroval'));
  let serovalRoot = path.dirname(serovalEntry);
  while (!fs.existsSync(path.join(serovalRoot, 'package.json'))) {
    assert.notEqual(path.dirname(serovalRoot), serovalRoot);
    serovalRoot = path.dirname(serovalRoot);
  }
  const serovalManifest = JSON.parse(
    fs.readFileSync(path.join(serovalRoot, 'package.json')),
  );
  assert.equal(serovalManifest.name, 'seroval');
  assert.equal(serovalManifest.version, '1.6.9');
  assert.ok(
    serovalRoot.startsWith(`${sourceHost}${path.sep}node_modules${path.sep}`),
  );
  const nativeImportResolution = [];
  for (const from of [
    path.join(adapter, 'src/client.ts'),
    path.join(source, 'client.ts'),
    require.resolve('@octanejs/tanstack-router'),
  ]) {
    const fromRequire = createRequire(from);
    for (const specifier of [
      'octane',
      'octane/server',
      '@octanejs/tanstack-router',
    ]) {
      const resolved = fs.realpathSync(fromRequire.resolve(specifier));
      assert.equal(
        resolved,
        fs.realpathSync(require.resolve(specifier)),
        `Native import identity differs: ${from} -> ${specifier}`,
      );
      nativeImportResolution.push({
        from: path.relative(root, from),
        specifier,
        realpath: resolved,
      });
    }
  }
  const sourceHostEvidence = {
    sourceHost,
    scope: 'supporting-byte-identical-source-package-body',
    packedFrameworkProof: false,
    sourceExportCondition: 'modern:source',
    canonicalStrictSafetyFlagsUnchanged: true,
    actualCoreManifestBytesVerified: true,
    allAuthoredSourceBytesVerified: true,
    sourceHostRetainedCallerOwned: true,
    frameworkManifests,
    frameworkSourceInventory: [...frameworkSnapshot]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, sha256]) => ({
        file: path.relative(workspace, file),
        sha256,
      })),
    hostCohort: ['package.json', 'pnpm-lock.yaml'].map(file => ({
      file,
      sha256: digestFile(path.join(sourceHost, file)),
    })),
    corePackageRealpath: core,
    declaredCoreSeroval: {
      version: serovalManifest.version,
      realpath: serovalRoot,
      entry: serovalEntry,
    },
    runtime: {
      node: process.version,
      executable: fs.realpathSync(process.execPath),
    },
    nativeImportResolution,
  };
  const owningModuleEvidence = files =>
    [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, sha256]) => ({
        file: path.relative(workspace, file),
        sha256,
        stagedFile: path.relative(
          sourceHost,
          [...stagedOrigins].find(([, origin]) => origin === file)[0],
        ),
      }));
  function recheckSourceHost() {
    for (const [stagedFile, originalFile] of stagedOrigins) {
      const sha256 = frameworkSnapshot.get(originalFile);
      assert.equal(
        digestFile(originalFile),
        sha256,
        `Original framework source changed: ${originalFile}`,
      );
      assert.equal(
        digestFile(stagedFile),
        sha256,
        `Staged framework source changed: ${stagedFile}`,
      );
    }
    for (const input of sourceHostEvidence.hostCohort)
      assert.equal(digestFile(path.join(sourceHost, input.file)), input.sha256);
    for (const input of frameworkManifests)
      assert.equal(digestFile(path.join(workspace, input.file)), input.sha256);
    assert.equal(
      digestFile(path.join(core, 'package.json')),
      frameworkManifests[1].sha256,
    );
    assert.equal(
      digestFile(path.join(sourceHost, 'core-package/package.json')),
      frameworkManifests[1].sha256,
    );
    for (const [file, sha256] of frameworkSnapshot) {
      if (file.startsWith(`${originalCore}${path.sep}`))
        assert.equal(
          digestFile(
            path.join(
              sourceHost,
              'core-package',
              path.relative(originalCore, file),
            ),
          ),
          sha256,
        );
    }
    for (const file of [
      'client.ts',
      'server.ts',
      'routes.tsx',
      'Leaf.tsx',
      'Sibling.tsx',
      'tsconfig.json',
    ])
      assert.equal(
        digestFile(path.join(source, file)),
        digestFile(path.join(originalSource, file)),
        `Staged fixture changed: ${file}`,
      );
  }

  try {
    const sourceExport = (file, names) =>
      `export { ${names} } from ${JSON.stringify(file)};\n`;
    fs.writeFileSync(
      path.join(source, 'framework-client.ts'),
      sourceExport(
        path.join(adapter, 'src/client.ts'),
        'hydrateOctaneApplication, readOctaneDocumentBootstrap',
      ) +
        sourceExport(
          path.join(adapter, 'src/router-client.ts'),
          'OctaneRouterRoot, prepareOctaneRouterHydration',
        ),
    );
    fs.writeFileSync(
      path.join(source, 'framework-routes.ts'),
      sourceExport(
        path.join(adapter, 'src/routes.ts'),
        'createFileSystemRouteTree',
      ),
    );
    fs.writeFileSync(
      path.join(source, 'framework-server.ts'),
      sourceExport('@modern-js/renderer-core/session', 'createRequestSession') +
        sourceExport(
          path.join(adapter, 'src/router-server.ts'),
          'createOctaneRequestHandler, createSsrStreamResponse, OctaneRouterServer',
        ) +
        sourceExport(
          path.join(adapter, 'src/server.ts'),
          'renderOctaneApplication',
        ),
    );

    async function runStrictAdmission() {
      const config = JSON.parse(
        fs.readFileSync(path.join(source, 'tsconfig.json')),
      );
      const canonical = JSON.parse(
        fs.readFileSync(path.join(root, 'tsconfig.json')),
      );
      assert.deepEqual(
        config.compilerOptions,
        canonical.compilerOptions,
        'The isolated fragment must use exactly the canonical strict flags.',
      );
      assert.deepEqual(
        config.tsrx,
        canonical.tsrx,
        'The isolated fragment must retain the canonical Octane projection contract.',
      );
      assert.deepEqual(config.include, ['./**/*']);
      config.files = [
        path.join(
          path.dirname(require.resolve('@types/node/package.json')),
          'index.d.ts',
        ),
      ];
      config.compilerOptions.customConditions = ['modern:source'];
      config.include = ['fixture/**/*'];
      const checkedConfig = path.join(sourceHost, 'strict-tsconfig.json');
      const checkerManifestFile = fs.realpathSync(
        require.resolve('@modern-js/renderer-octane/package.json'),
      );
      const checkerRoot = path.dirname(checkerManifestFile);
      assert.ok(
        checkerRoot.startsWith(`${root}${path.sep}node_modules${path.sep}`),
        'The canonical Octane checker must belong to the installed consumer.',
      );
      const checkerManifest = JSON.parse(fs.readFileSync(checkerManifestFile));
      assert.equal(checkerManifest.name, '@modern-js/renderer-octane');
      assert.equal(checkerManifest.dependencies.typescript, '7.0.2');
      const checkerBin = checkerManifest.bin?.['octane-tsc'];
      assert.equal(typeof checkerBin, 'string');
      const checker = fs.realpathSync(path.resolve(checkerRoot, checkerBin));
      const checkerEntry = fs.realpathSync(
        require.resolve('@modern-js/renderer-octane/typecheck'),
      );
      for (const file of [checker, checkerEntry])
        assert.ok(file.startsWith(`${checkerRoot}${path.sep}`));
      const typescriptEntry = fs.realpathSync(require.resolve('typescript'));
      for (const file of [checker, checkerEntry])
        assert.equal(
          fs.realpathSync(createRequire(file).resolve('typescript')),
          typescriptEntry,
          'The checker and admission API must share the installed native TypeScript.',
        );
      assert.equal(require('typescript').version, '7.0.2');
      const [{ checkOctaneProject }, { API }, ts] = await Promise.all([
        import(pathToFileURL(checkerEntry)),
        import(pathToFileURL(require.resolve('typescript/unstable/sync'))),
        import(pathToFileURL(require.resolve('typescript/unstable/ast'))),
      ]);
      assert.equal(typeof checkOctaneProject, 'function');
      const command = {
        executable: fs.realpathSync(process.execPath),
        args: [
          checker,
          '--project',
          checkedConfig,
          '--pretty',
          'false',
          '--listFiles',
        ],
        cwd: root,
        timeoutMs: 60_000,
      };
      let result;
      let checkedConfigSha256;
      let checked;
      let typeFiles;
      const nativeTypeImportResolution = [];
      const api = new API({ cwd: root });
      try {
        fs.writeFileSync(checkedConfig, `${JSON.stringify(config, null, 2)}\n`);
        checkedConfigSha256 = digestFile(checkedConfig);
        checked = checkOctaneProject({ project: checkedConfig, cwd: root });
        assert.equal(checked.compilerVersion, '7.0.2');
        result = spawnSync(command.executable, command.args, {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        });
        const project = api
          .updateSnapshot({ openProjects: [checkedConfig] })
          .getProject(checkedConfig);
        assert.ok(project, 'The native API must load the checked fragment.');
        const program = project.program;
        assert.deepEqual(program.getCompilerOptions().customConditions, [
          'modern:source',
        ]);
        assert.equal(program.getCompilerOptions().skipLibCheck, false);
        assert.equal(program.getCompilerOptions().noEmit, true);
        typeFiles = [
          ...new Set(
            program.getSourceFileNames().map(file => fs.realpathSync(file)),
          ),
        ].sort();
        assert.deepEqual(
          [...new Set(checked.files.map(file => fs.realpathSync(file)))].sort(),
          typeFiles,
          'The public Octane checker and native API must check the same authored program.',
        );
        const listedFiles = [
          ...new Set(
            (result.stdout ?? '')
              .split(/\r?\n/u)
              .filter(line => path.isAbsolute(line) && fs.existsSync(line))
              .map(file => fs.realpathSync(file)),
          ),
        ].sort();
        assert.deepEqual(
          listedFiles,
          typeFiles,
          'octane-tsc and the native API must check the same declaration closure.',
        );
        const programFiles = new Set(typeFiles);
        for (const file of program.getSourceFileNames()) {
          const sourceFile = program.getSourceFile(file);
          assert.ok(sourceFile, 'The audited file must belong to the program.');
          sourceFile.forEachChild(node => {
            if (
              (!ts.isImportDeclaration(node) &&
                !ts.isExportDeclaration(node)) ||
              !node.moduleSpecifier ||
              !ts.isStringLiteral(node.moduleSpecifier)
            )
              return;
            const specifier = node.moduleSpecifier.text;
            const packageName =
              specifier === 'octane' || specifier.startsWith('octane/')
                ? 'octane'
                : specifier === '@octanejs/tanstack-router' ||
                    specifier.startsWith('@octanejs/tanstack-router/')
                  ? '@octanejs/tanstack-router'
                  : undefined;
            if (!packageName) return;
            const symbol = project.checker.getSymbolAtLocation(
              node.moduleSpecifier,
            );
            const declarations = [
              ...new Set(
                symbol?.declarations.flatMap(declaration => {
                  const selected = declaration.resolve(project);
                  return selected ? [selected.getSourceFile().fileName] : [];
                }) ?? [],
              ),
            ];
            assert.equal(
              declarations.length,
              1,
              `Actual native import must select one module: ${file} -> ${specifier}`,
            );
            const realpath = fs.realpathSync(declarations[0]);
            assert.ok(programFiles.has(realpath));
            assert.ok(
              realpath.startsWith(`${root}${path.sep}node_modules${path.sep}`),
              `Native type import escaped the consumer: ${file} -> ${specifier}`,
            );
            const metadata = program.getSourceFileMetadata(declarations[0]);
            assert.ok(metadata?.packageJsonDirectory);
            const packageRoot = fs.realpathSync(metadata.packageJsonDirectory);
            const packageManifestFile = path.join(packageRoot, 'package.json');
            const packageManifest = JSON.parse(
              fs.readFileSync(packageManifestFile),
            );
            assert.equal(packageManifest.name, packageName);
            const exportKey = `.${specifier.slice(packageName.length)}`;
            const packageExport = packageManifest.exports[exportKey];
            const typeExport =
              typeof packageExport === 'string'
                ? packageExport
                : packageExport?.types;
            assert.equal(typeof typeExport, 'string');
            assert.equal(
              realpath,
              fs.realpathSync(path.resolve(packageRoot, typeExport)),
              `The actual native import must select its declared package export: ${specifier}`,
            );
            nativeTypeImportResolution.push({
              from: path.relative(root, file),
              specifier,
              realpath,
              packageId: {
                name: packageManifest.name,
                version: packageManifest.version,
                subModuleName: path.relative(packageRoot, realpath),
              },
              exportKey,
              packageExport,
              packageManifestSha256: digestFile(packageManifestFile),
              resolution: 'actual-native-program-module-symbol',
            });
          });
        }
        nativeTypeImportResolution.sort(
          (left, right) =>
            left.from.localeCompare(right.from) ||
            left.specifier.localeCompare(right.specifier),
        );
        for (const specifier of new Set(
          nativeImportResolution.map(record => record.specifier),
        ))
          assert.ok(
            nativeTypeImportResolution.some(
              record => record.specifier === specifier,
            ),
            `The actual native program must import ${specifier}.`,
          );
        assert.equal(digestFile(checkedConfig), checkedConfigSha256);
      } finally {
        api.close();
        fs.rmSync(checkedConfig, { force: true });
      }
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const diagnostics = checked.diagnostics
        .filter(diagnostic => diagnostic.category === 'error')
        .map(diagnostic => ({
          file: diagnostic.fileName
            ? path.relative(root, diagnostic.fileName)
            : '',
          line: diagnostic.line,
          column: diagnostic.column,
          code: diagnostic.code,
          message: diagnostic.text,
        }));
      const counts = key =>
        Object.fromEntries(
          [
            ...diagnostics.reduce((map, diagnostic) => {
              const value = diagnostic[key];
              map.set(value, (map.get(value) ?? 0) + 1);
              return map;
            }, new Map()),
          ].sort(([left], [right]) =>
            String(left).localeCompare(String(right)),
          ),
        );
      const owningFrameworkModules = typeFiles
        .filter(file => stagedOrigins.has(file))
        .sort()
        .map(file => {
          const origin = stagedOrigins.get(file);
          return {
            file: path.relative(workspace, origin),
            stagedFile: path.relative(sourceHost, file),
            sha256: frameworkSnapshot.get(origin),
          };
        });
      const nativeTypeFiles = typeFiles.filter(file =>
        /[/\\]node_modules[/\\](?:octane|@octanejs[/\\]tanstack-router)[/\\]/u.test(
          file,
        ),
      );
      for (const file of nativeTypeFiles)
        assert.ok(
          file.startsWith(`${root}${path.sep}node_modules${path.sep}`),
          `Native type escaped the single consumer graph: ${file}`,
        );
      assert.ok(nativeTypeFiles.length > 0);
      recheckSourceHost();
      for (const input of [
        ...authoredInputs,
        ...consumerCohort,
        strictConfigInput,
      ])
        assert.equal(
          digestFile(path.join(root, input.file)),
          input.sha256,
          `Strict admission input changed: ${input.file}`,
        );
      for (const [file, sha256] of frameworkSnapshot)
        assert.equal(
          digestFile(file),
          sha256,
          `Framework source changed during strict admission: ${file}`,
        );
      const receipt = {
        passed:
          result.status === 0 && !result.error && diagnostics.length === 0,
        qualifyingSourceStrictGate:
          result.status === 0 && !result.error && diagnostics.length === 0,
        status: result.status,
        signal: result.signal,
        failure: result.error ? String(result.error) : undefined,
        independentNativeApplication: true,
        owningFrameworkSourceProbe: true,
        sourceHostEvidence,
        canonicalStrictFlags: true,
        automaticAmbientDiscovery: false,
        libraryChecking: true,
        command,
        actualConfig: config,
        checkedConfig: {
          file: path.relative(root, checkedConfig),
          sha256: checkedConfigSha256,
          removed: !fs.existsSync(checkedConfig),
        },
        nodeDeclarationImportRoot: path.dirname(config.files[0]),
        nativeChecker: {
          typescript: typescriptEntry,
          octaneTsc: checker,
          publicTypecheck: checkerEntry,
          compilerVersion: checked.compilerVersion,
          checkerManifestSha256: digestFile(checkerManifestFile),
        },
        diagnosticCount: diagnostics.length,
        fixtureDiagnosticCount: diagnostics.filter(diagnostic =>
          diagnostic.file.startsWith(`${path.relative(root, source)}/`),
        ).length,
        diagnostics,
        diagnosticsByCode: counts('code'),
        diagnosticsByFile: counts('file'),
        typeProgramFileCount: typeFiles.length,
        nativeTypeFiles,
        nativeTypeImportResolution,
        singleNativeTypeGraph: true,
        owningFrameworkModules,
        output,
        authoredInputs,
        consumerCohort,
        strictConfigInput,
        immutableInputsRechecked: true,
        nativeRuntime: packages.nativeArtifact.version,
        nativeRouter: packages.nativeRouterArtifact.version,
        nativeArtifactSha256: packages.nativeArtifact.sha256,
        nativeProvenanceSha256: packages.nativeArtifact.provenanceSha256,
        routerArtifactSha256: packages.nativeRouterArtifact.sha256,
        routerProvenanceSha256: packages.nativeRouterArtifact.provenanceSha256,
        nativePublicDependencyURIs: {
          runtime: packages.nativeArtifact.dependencyURI,
          router: packages.nativeRouterArtifact.dependencyURI,
        },
        resourcesClosed: true,
        browserClosure: 'not-created',
        serverClosure: 'not-created',
      };
      fs.writeFileSync(
        path.join(root, 'router-fragment-strict-diagnostics.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      console.log(
        JSON.stringify({
          ...receipt,
          output: undefined,
          diagnostics: undefined,
        }),
      );
      if (!receipt.passed)
        throw new Error(
          `Independent strict fragment gate failed with ${diagnostics.length} diagnostics; ${receipt.fixtureDiagnosticCount} belong to the fixture. See router-fragment-strict-diagnostics.json.`,
        );
    }

    async function runBrowserAdmission() {
      const resolve = {
        extensions: ['.tsrx', '.tsx', '.ts', '.js'],
        conditionNames: ['modern:source', '...'],
        // Normal ancestor package lookup preserves core's own Seroval1.6.2 while
        // every native package resolves to the private consumer ancestor.
        modules: ['node_modules'],
      };
      const rule = {
        test: /\.(?:tsrx|[cm]?[jt]sx?)$/u,
        type: 'javascript/auto',
        use: [
          { loader: 'builtin:swc-loader', options: { detectSyntax: 'auto' } },
        ],
      };
      const compiled = [];
      function inspectCompilation(stats, environment) {
        assert.equal(
          stats.hasErrors(),
          false,
          stats.toString({ all: false, errors: true, errorDetails: true }),
        );
        const modules = [...stats.compilation.modules].flatMap(module => {
          const visit = current => [
            current,
            ...[...(current.modules ?? [])].flatMap(visit),
          ];
          return visit(module);
        });
        const resources = modules
          .map(module => module.resource)
          .filter(Boolean);
        const externalImports = modules
          .filter(module => module.externalType)
          .map(module => ({
            type: module.externalType,
            request: module.request,
          }));
        for (const external of externalImports)
          assert.ok(
            typeof external.request === 'string' &&
              builtinModules.includes(external.request.replace(/^node:/u, '')),
            `Compiled nonbuiltin external escaped dependency checks: ${JSON.stringify(external)}`,
          );
        const filesystemResources = resources.filter(resource => {
          if (path.isAbsolute(resource.split('?')[0])) return true;
          assert.ok(
            resource.startsWith('data:'),
            `Unexpected compiled resource identifier: ${resource}`,
          );
          return false;
        });
        const nativeResources = filesystemResources.filter(resource =>
          /node_modules[/\\](?:octane|@octanejs[/\\]tanstack-router|@tanstack[/\\](?:router-core|history|store))(?:[/\\]|$)/u.test(
            resource,
          ),
        );
        for (const resource of filesystemResources) {
          const file = resource.split('?')[0];
          const original = stagedOrigins.get(fs.realpathSync(file));
          if (!original) continue;
          const sha256 = frameworkSnapshot.get(original);
          assert.ok(sha256, `Framework source was not captured: ${file}`);
          assert.equal(
            digestFile(file),
            sha256,
            `Framework source changed during compilation: ${file}`,
          );
          frameworkModules.set(original, sha256);
        }
        const dependencyResources = filesystemResources.filter(resource =>
          /[/\\]node_modules[/\\]/u.test(resource),
        );
        assert.ok(
          nativeResources.length > 0,
          `${environment} has no native graph`,
        );
        for (const resource of dependencyResources) {
          const actual = fs.realpathSync(resource.split('?')[0]);
          assert.ok(
            actual.startsWith(`${root}${path.sep}node_modules${path.sep}`) ||
              actual.startsWith(
                `${sourceHost}${path.sep}node_modules${path.sep}`,
              ),
            `Compiled dependency escaped private graph: ${actual}`,
          );
        }
        for (const resource of nativeResources)
          assert.ok(
            fs
              .realpathSync(resource.split('?')[0])
              .startsWith(`${root}${path.sep}node_modules${path.sep}`),
            `Native dependency escaped its single private owner: ${resource}`,
          );
        assert.equal(
          resources.some(resource =>
            /node_modules[/\\](?:react|react-dom)(?:[/\\]|$)/u.test(resource),
          ),
          false,
          `${environment} included React`,
        );
        const evidence = {
          environment,
          hash: stats.hash,
          nativeResources: nativeResources.length,
          reactRuntimeModules: false,
          privateNativeRealpaths: true,
          privateDependencyRealpaths: true,
          virtualDataModules: resources.length - filesystemResources.length,
          virtualDataSourceDigests: resources
            .filter(resource => resource.startsWith('data:'))
            .map(resource => {
              const comma = resource.indexOf(',');
              assert.ok(comma > 0, 'Compiled data URI has no source carrier.');
              const carrier = resource.slice(0, comma);
              const sourceBytes = /;base64$/u.test(carrier)
                ? Buffer.from(resource.slice(comma + 1), 'base64')
                : Buffer.from(decodeURIComponent(resource.slice(comma + 1)));
              return {
                carrier,
                uriSha256: createHash('sha256').update(resource).digest('hex'),
                sourceContentSha256: createHash('sha256')
                  .update(sourceBytes)
                  .digest('hex'),
              };
            }),
          externalImports,
        };
        compiled.push(evidence);
        return evidence;
      }

      async function compileServer() {
        const files = new Map();
        const outputPath = path.join(output, 'server');
        const compiler = rspack({
          context: root,
          mode: 'development',
          target: 'node',
          entry: path.join(source, 'server.ts'),
          output: {
            path: outputPath,
            filename: 'server.cjs',
            library: { type: 'commonjs2' },
          },
          resolve,
          module: { rules: [rule] },
          plugins: [
            new OctaneRspackPlugin({
              root,
              environment: 'server',
              transpile: false,
              parallel: false,
            }),
          ],
          optimization: { minimize: false, splitChunks: false },
        });
        compiler.outputFileSystem = {
          writeFile(file, bytes, callback) {
            files.set(file, Buffer.from(bytes));
            callback();
          },
          mkdir(_file, ...args) {
            args.at(-1)();
          },
          stat(_file, callback) {
            callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
          },
          readFile(file, callback) {
            const bytes = files.get(file);
            callback(
              bytes
                ? null
                : Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
              bytes,
            );
          },
          join: path.join,
        };
        try {
          const stats = await new Promise((accept, reject) =>
            compiler.run((error, stats) =>
              error ? reject(error) : accept(stats),
            ),
          );
          inspectCompilation(stats, 'server');
          const modules = new Map();
          const load = file => {
            if (modules.has(file)) return modules.get(file).exports;
            const entry = new Module(file);
            entry.filename = file;
            entry.paths = Module._nodeModulePaths(root);
            modules.set(file, entry);
            entry.require = function (specifier) {
              const target = path.resolve(path.dirname(file), specifier);
              return files.has(target)
                ? load(target)
                : Module.prototype.require.call(this, specifier);
            };
            entry._compile(files.get(file).toString(), file);
            return entry.exports;
          };
          return load(path.join(outputPath, 'server.cjs'));
        } finally {
          await new Promise((accept, reject) =>
            compiler.close(error => (error ? reject(error) : accept())),
          );
        }
      }

      let browser;
      let browserCreation;
      let browserClosure;
      let browserClosed = false;
      let devServer;
      let createdServer;
      let devCreation;
      let serverClosed = false;
      let interruption;
      const nativeShutdownFailures = [];
      let failure;
      let serverResult;
      let initialCompile;
      const firstCompile = new Promise((accept, reject) => {
        initialCompile = { accept, reject };
      });
      // Observe a rejected compilation even if server creation fails first.
      void firstCompile.catch(() => {});
      const leaf = path.join(source, 'Leaf.tsx');
      const sibling = path.join(source, 'Sibling.tsx');
      const originalLeaf = fs.readFileSync(leaf, 'utf8');
      const originalSibling = fs.readFileSync(sibling, 'utf8');
      const evidence = {
        passed: false,
        owningFrameworkSourceFragmentPair: true,
        generatedFrameworkProof: false,
        packedFrameworkProof: false,
      };
      const errors = [];
      const checkpoint = () => {
        if (interruption) throw interruption;
      };
      const closeBrowser = () => {
        if (!browserCreation && !browser) return Promise.resolve();
        return (browserClosure ??= (async () => {
          await browserCreation?.catch(() => {});
          if (browser) {
            await browser.close();
            browserClosed = true;
          }
        })());
      };
      const handlers = new Map();
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
          interruption ??= new Error(
            `Router fragment admission interrupted by ${signal}`,
          );
          initialCompile.reject(interruption);
          void closeBrowser().catch(error =>
            nativeShutdownFailures.push(error),
          );
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      try {
        checkpoint();
        const serverFixture = await compileServer();
        checkpoint();
        const host = await createRsbuild({
          cwd: root,
          rsbuildConfig: {
            source: { entry: { fragment: path.join(source, 'client.ts') } },
            output: { distPath: { root: 'dist/router-fragment/client' } },
            server: {
              host: '127.0.0.1',
              port: 0,
              setup({ server }) {
                server.middlewares.use(async (request, response, next) => {
                  if (
                    !['/', '/products/42'].includes(
                      new URL(request.url, 'http://native.test').pathname,
                    )
                  )
                    return next();
                  try {
                    await firstCompile;
                    response.setHeader(
                      'content-type',
                      'text/html; charset=utf-8',
                    );
                    response.end(
                      serverResult.html.replace(
                        '</body>',
                        '<script src="/static/js/fragment.js"></script></body>',
                      ),
                    );
                  } catch (error) {
                    next(error);
                  }
                });
              },
            },
            tools: {
              htmlPlugin: false,
              rspack: {
                resolve,
                output: { library: { type: 'window', name: '__fragment' } },
                optimization: {
                  minimize: false,
                  splitChunks: false,
                  runtimeChunk: false,
                },
              },
            },
            plugins: [
              {
                name: 'admission:native-router-fragment',
                setup(api) {
                  api.modifyRspackConfig(config => {
                    config.plugins.push(
                      new OctaneRspackPlugin({
                        root,
                        environment: 'client',
                        transpile: false,
                        parallel: false,
                      }),
                    );
                    config.module.rules.push(rule);
                  });
                  api.onDevCompileDone(async ({ stats, isFirstCompile }) => {
                    try {
                      const current = stats.stats?.[0] ?? stats;
                      const compilation = inspectCompilation(current, 'client');
                      if (isFirstCompile) {
                        const nativeBuild = JSON.parse(
                          current.compilation.assets[
                            'octane-client-build.json'
                          ].source(),
                        );
                        assert.equal(nativeBuild.buildId, compilation.hash);
                        serverResult = await serverFixture.renderDocument(
                          nativeBuild.buildId,
                        );
                        assert.deepEqual(serverResult.calls, [
                          'application',
                          'home',
                        ]);
                        assert.equal(serverResult.cleanups, 1);
                        assert.equal(serverResult.completion, 'completed');
                        assert.match(serverResult.html, /home server data/u);
                        evidence.nativeHydrationBuildId = nativeBuild.buildId;
                        initialCompile.accept();
                      }
                    } catch (error) {
                      initialCompile.reject(error);
                      errors.push(String(error));
                    }
                  });
                },
              },
            ],
          },
        });
        host.onBeforeStartDevServer(({ server }) => {
          createdServer = server;
        });
        host.onCloseDevServer(async () => {
          await devCreation?.catch(() => {});
          try {
            await closeBrowser();
          } catch (error) {
            nativeShutdownFailures.push(error);
          }
        });
        checkpoint();
        devCreation = host.createDevServer();
        createdServer = await devCreation;
        checkpoint();
        devServer = await createdServer.listen();
        checkpoint();
        await firstCompile;
        checkpoint();
        browserCreation = chromium.launch({ headless: true, timeout: 10_000 });
        browser = await browserCreation;
        checkpoint();
        const page = await browser.newPage();
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(devServer.urls[0], { waitUntil: 'networkidle' });
        await page.waitForFunction(() => Boolean(globalThis.__fragment));
        const negatives = [];
        for (const kind of [
          'renderer',
          'document',
          'native',
          'document-id',
          'compiled-native',
        ]) {
          negatives.push(
            await page.evaluate(
              kind => globalThis.__fragment.negativeStartup(kind),
              kind,
            ),
          );
        }
        assert.ok(
          negatives.every(
            result =>
              result.authoredImports === 0 &&
              result.retainedMain &&
              result.unchangedDom,
          ),
        );
        const initial = await page.evaluate(() =>
          globalThis.__fragment.start(),
        );
        assert.deepEqual(initial, {
          retainedMain: true,
          retainedHome: true,
          retainedTitle: true,
          routerPathname: '/',
          pathname: '/',
          loadCalls: 1,
          calls: [],
          roots: 1,
        });
        negatives.push(
          await page.evaluate(() =>
            globalThis.__fragment.negativeStartup('duplicate-framework-bridge'),
          ),
        );
        assert.match(
          negatives.at(-1).error,
          /signal bridge already owns this document/u,
        );
        assert.equal(negatives.at(-1).authoredImports, 0);
        assert.equal(negatives.at(-1).unchangedDom, true);
        const duplicateNative = await page.evaluate(() =>
          globalThis.__fragment.duplicateNativeBridge(),
        );
        assert.match(duplicateNative.error, /already installed/u);
        assert.equal(duplicateNative.retainedIngress, true);
        assert.equal(duplicateNative.retainedSelectionRegistration, true);
        assert.equal(duplicateNative.loadCalls, 1);
        await page.getByTestId('root-count').click();
        await page.getByTestId('sibling').click();
        const documentState = await page.evaluate(() => {
          globalThis.fragmentDocumentSentinel = crypto.randomUUID();
          return {
            sentinel: globalThis.fragmentDocumentSentinel,
            timeOrigin: performance.timeOrigin,
          };
        });
        for (const pathname of ['/products/42', '/', '/products/42']) {
          await page
            .getByTestId(pathname === '/' ? 'home-link' : 'product-link')
            .click();
          await page.waitForFunction(
            pathname =>
              globalThis.__fragment.inspect().routerPathname === pathname &&
              location.pathname === pathname,
            pathname,
          );
          assert.equal(
            await page.getByTestId('root-count').innerText(),
            'Root count: 1',
          );
          assert.equal(
            await page.getByTestId('sibling').innerText(),
            'Sibling count: 1',
          );
          const state = await page.evaluate(() => ({
            sentinel: globalThis.fragmentDocumentSentinel,
            timeOrigin: performance.timeOrigin,
          }));
          assert.deepEqual(state, documentState);
          assert.equal(
            (await page.evaluate(() => globalThis.__fragment.inspect()))
              .retainedMain,
            true,
          );
        }
        assert.deepEqual(
          (await page.evaluate(() => globalThis.__fragment.inspect())).calls,
          ['product'],
        );
        await page.getByTestId('leaf-count').click();
        const beforeHmr = await page.evaluate(
          () => globalThis.fragmentLifecycle,
        );
        assert.deepEqual(beforeHmr, {
          leaf: { mounts: 2, cleanups: 1 },
          sibling: { mounts: 1, cleanups: 0 },
        });
        fs.writeFileSync(
          leaf,
          originalLeaf.replace('Leaf count: ', 'Leaf HMR: '),
        );
        await page
          .getByTestId('leaf-count')
          .filter({ hasText: 'Leaf HMR: 1' })
          .waitFor();
        await page.waitForFunction(
          () => globalThis.fragmentLifecycle.leaf.mounts === 3,
        );
        assert.deepEqual(
          await page.evaluate(() => globalThis.fragmentLifecycle),
          {
            leaf: { mounts: 3, cleanups: 2 },
            sibling: { mounts: 1, cleanups: 0 },
          },
        );
        fs.writeFileSync(
          sibling,
          originalSibling.replace('Sibling count: ', 'Sibling HMR: '),
        );
        await page
          .getByTestId('sibling')
          .filter({ hasText: 'Sibling HMR: 1' })
          .waitFor();
        await page.waitForFunction(
          () => globalThis.fragmentLifecycle.sibling.mounts === 2,
        );
        assert.equal(
          await page.getByTestId('leaf-count').innerText(),
          'Leaf HMR: 1',
        );
        assert.equal(
          await page.getByTestId('root-count').innerText(),
          'Root count: 1',
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            sentinel: globalThis.fragmentDocumentSentinel,
            timeOrigin: performance.timeOrigin,
          })),
          documentState,
        );
        const afterHmr = await page.evaluate(() =>
          globalThis.__fragment.inspect(),
        );
        assert.equal(afterHmr.retainedMain, true);
        assert.equal(afterHmr.routerPathname, '/products/42');
        assert.equal(afterHmr.pathname, '/products/42');
        assert.equal(afterHmr.roots, 1);
        assert.deepEqual(
          await page.evaluate(() => globalThis.fragmentLifecycle),
          {
            leaf: { mounts: 3, cleanups: 2 },
            sibling: { mounts: 2, cleanups: 1 },
          },
        );
        const disposed = await page.evaluate(() =>
          globalThis.__fragment.dispose(),
        );
        assert.deepEqual(disposed, {
          nodes: 0,
          lifecycle: {
            leaf: { mounts: 3, cleanups: 3 },
            sibling: { mounts: 2, cleanups: 2 },
          },
        });
        assert.deepEqual(errors, []);
        Object.assign(evidence, {
          passed: true,
          nativeRuntime: packages.nativeArtifact.version,
          nativeRouter: packages.nativeRouterArtifact.version,
          publicArtifactBytesVerified: true,
          nativeArtifactSha256: packages.nativeArtifact.sha256,
          nativeProvenanceSha256: packages.nativeArtifact.provenanceSha256,
          routerArtifactSha256: packages.nativeRouterArtifact.sha256,
          routerProvenanceSha256:
            packages.nativeRouterArtifact.provenanceSha256,
          nativeHmrBuildIdentityPolicy: 'initial-dev-session-snapshot',
          retainedSsrFragmentDom: true,
          retainedServerHead: true,
          nativeLinkNavigationCount: 3,
          initialClientLoaderCalls: 0,
          navigationClientLoaderCalls: 1,
          leafAndSiblingNativeHmr: true,
          exactEditedBoundaryDisposal: true,
          unrelatedRootStateRetained: true,
          routerLocationRetained: true,
          noDocumentReload: true,
          negatives,
          duplicateNativeBridge: {
            error: duplicateNative.error,
            retainedIngress: duplicateNative.retainedIngress,
            retainedSelectionRegistration:
              duplicateNative.retainedSelectionRegistration,
          },
          lifecycle: disposed.lifecycle,
          compiled,
          browserErrors: errors,
        });
      } catch (error) {
        failure = error;
        Object.assign(evidence, {
          passed: false,
          failure: String(error),
          compiled,
          browserErrors: errors,
        });
      } finally {
        await devCreation?.catch(() => {});
        await browserCreation?.catch(() => {});
        const releases = await Promise.allSettled([
          closeBrowser(),
          Promise.resolve().then(async () => {
            const server = devServer?.server ?? createdServer;
            if (server) {
              await server.close();
              serverClosed = true;
            }
          }),
        ]);
        fs.writeFileSync(leaf, originalLeaf);
        fs.writeFileSync(sibling, originalSibling);
        const cleanupFailures = [
          ...nativeShutdownFailures,
          ...releases
            .filter(result => result.status === 'rejected')
            .map(result => result.reason),
        ].map(String);
        if (interruption) {
          failure ??= interruption;
          Object.assign(evidence, { passed: false, failure: String(failure) });
        }
        evidence.browserClosure = browser
          ? browserClosed
            ? 'closed'
            : 'failed'
          : 'not-created';
        evidence.serverClosure = createdServer
          ? serverClosed
            ? 'closed'
            : 'failed'
          : 'not-created';
        evidence.resourcesClosed =
          (!browser || browserClosed) &&
          (!createdServer || serverClosed) &&
          cleanupFailures.length === 0;
        if (cleanupFailures.length) {
          Object.assign(evidence, { passed: false, cleanupFailures });
          failure ??= new Error(cleanupFailures.join('\n'));
        }
        try {
          for (const input of [
            ...authoredInputs,
            ...consumerCohort,
            strictConfigInput,
          ])
            assert.equal(
              digestFile(path.join(root, input.file)),
              input.sha256,
              `Admission input changed: ${input.file}`,
            );
          for (const [file, sha256] of frameworkModules)
            assert.equal(
              digestFile(file),
              sha256,
              `Framework source changed during admission: ${file}`,
            );
          Object.assign(evidence, {
            authoredInputs,
            consumerCohort,
            strictConfigInput,
            sourceHostEvidence,
            immutableInputsRechecked: true,
            owningFrameworkModules: owningModuleEvidence(frameworkModules),
            nativePublicDependencyURIs: {
              runtime: packages.nativeArtifact.dependencyURI,
              router: packages.nativeRouterArtifact.dependencyURI,
            },
          });
          recheckSourceHost();
        } catch (error) {
          failure ??= error;
          Object.assign(evidence, {
            passed: false,
            failure: String(error),
            immutableInputsRechecked: false,
          });
        }
        for (const [signal, handler] of handlers)
          process.removeListener(signal, handler);
        fs.writeFileSync(
          path.join(root, 'router-fragment-evidence.json'),
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
        console.log(JSON.stringify(evidence));
      }
      if (failure) throw failure;
    }

    if (strictOnly) await runStrictAdmission();
    else await runBrowserAdmission();
  } finally {
    for (const file of [
      'framework-client.ts',
      'framework-routes.ts',
      'framework-server.ts',
    ])
      fs.rmSync(path.join(source, file), { force: true });
  }
}
