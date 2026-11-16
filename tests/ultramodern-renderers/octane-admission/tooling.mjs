import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  admissionTuple,
  validateAdmissionPackages,
} from './native-artifact.mjs';

const root = process.cwd();
const receipt = path.join(root, 'tooling-evidence.json');
fs.writeFileSync(
  receipt,
  `${JSON.stringify({ passed: false, failure: 'The strict native tooling probe has not completed.' }, null, 2)}\n`,
);
const require = createRequire(path.join(root, 'package.json'));
const privateManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const nativeDeclarationFiles = [
  'jsx-runtime.d.ts',
  'jsx-runtime-strong.d.ts',
  'index.d.ts',
  'public-types.d.ts',
];
const reactDeclarationHashes = {
  'index.d.ts':
    '045c1b395851aa71ef76393398466330fe1eeebc113c8085eefc6d84abea3a88',
  'global.d.ts':
    '7e29f41b158de217f94cb9676bf9cbd0cd9b5a46e1985141ed36e075c52bf6ad',
};
// Authenticate the current owning descriptor before any compiler/tooling probe.
const admittedPackages = await validateAdmissionPackages({
  root,
  workspacePath: privateManifest.ultramodernAdmission?.workspacePath,
  nativeArtifacts: privateManifest.ultramodernAdmission?.nativeArtifacts,
  nativeArchives: privateManifest.ultramodernAdmission?.nativeArchives,
});
const sdkManifestFile = fs.realpathSync(
  require.resolve('@modern-js/renderer-octane/package.json'),
);
const sdkManifest = JSON.parse(fs.readFileSync(sdkManifestFile, 'utf8'));
assert.equal(typeof sdkManifest.bin?.['octane-tsc'], 'string');
const checker = fs.realpathSync(
  path.resolve(path.dirname(sdkManifestFile), sdkManifest.bin['octane-tsc']),
);
const typescriptManifest = fs.realpathSync(
  require.resolve('typescript/package.json'),
);
assert.equal(
  JSON.parse(fs.readFileSync(typescriptManifest, 'utf8')).version,
  '7.0.2',
);
assert.equal(
  fs.realpathSync(createRequire(checker).resolve('typescript/package.json')),
  typescriptManifest,
  'The installed Octane checker and native API must share physical TypeScript 7.0.2',
);
const sdkPublicApiFile = fs.realpathSync(
  require.resolve('@modern-js/renderer-octane/typecheck'),
);
const { checkOctaneProject } = await import(pathToFileURL(sdkPublicApiFile));
const ts = await import(
  pathToFileURL(require.resolve('typescript/unstable/ast'))
);
const { API, SignatureKind, SymbolFlags } = await import(
  pathToFileURL(require.resolve('typescript/unstable/sync'))
);
const { createVirtualFileSystem } = await import(
  pathToFileURL(require.resolve('typescript/unstable/fs'))
);
const compilerEntry = fs.realpathSync(require.resolve('octane/compiler/volar'));
assert.equal(
  fs.realpathSync(createRequire(checker).resolve('octane/compiler/volar')),
  compilerEntry,
  'The installed checker and native inspection must use the same physical Octane projection compiler',
);
const { compileToVolarMappings } = await import(pathToFileURL(compilerEntry));
const formatter = path.join(root, 'node_modules/.bin/oxfmt');
const config = JSON.parse(
  fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
);
for (const flag of [
  'strict',
  'isolatedModules',
  'verbatimModuleSyntax',
  'exactOptionalPropertyTypes',
  'noUncheckedIndexedAccess',
  'noPropertyAccessFromIndexSignature',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'noImplicitReturns',
]) {
  assert.equal(config.compilerOptions[flag], true, `Required ${flag}`);
}
assert.equal(config.compilerOptions.skipLibCheck, false);
assert.notEqual(config.compilerOptions.skipDefaultLibCheck, true);
assert.notEqual(config.compilerOptions.noCheck, true);
assert.deepEqual(config.compilerOptions.types, []);
// Explicit native Node declarations keep automatic ambient package discovery off.
// Preserve pnpm's actual package adjacency for its undici-types dependency.
config.files = [
  path.join(
    path.dirname(require.resolve('@types/node/package.json')),
    'index.d.ts',
  ),
];
const checkedConfig = path.join(root, 'tooling-native-tsconfig.json');
function command(executable, args) {
  const actualExecutable =
    executable === checker ? process.execPath : executable;
  const actualArgs = executable === checker ? [checker, ...args] : args;
  const result = spawnSync(actualExecutable, actualArgs, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    executable: actualExecutable,
    args: actualArgs,
    cwd: root,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileEvidence(file, expectedHash) {
  const realpath = fs.realpathSync(file);
  const bytes = fs.readFileSync(realpath);
  const actualHash = sha256(bytes);
  if (expectedHash !== undefined)
    assert.equal(actualHash, expectedHash, `Exact native type bytes: ${file}`);
  return { realpath, sha256: actualHash, size: bytes.length };
}

function nativeInspection(typeFiles) {
  const inspectionConfig = path.join(root, '.tooling-native-inspection.json');
  const projectionSources = new Map();
  const files = {};
  for (const file of typeFiles) {
    if (!file.endsWith('.tsrx')) continue;
    const projected = `${file}.tsx`;
    files[projected] = compileToVolarMappings(
      fs.readFileSync(file, 'utf8'),
      file,
      { loose: true },
    ).code;
    projectionSources.set(projected, file);
  }
  files[inspectionConfig] = JSON.stringify({
    ...config,
    files: typeFiles.map(file =>
      file.endsWith('.tsrx') ? `${file}.tsx` : file,
    ),
    include: [],
    exclude: [],
  });
  const virtual = createVirtualFileSystem(files);
  const api = new API({
    cwd: root,
    fs: {
      readFile: virtual.readFile,
      fileExists: file => virtual.fileExists(file) || undefined,
      directoryExists: directory =>
        virtual.directoryExists(directory) || undefined,
      realpath: file => (virtual.fileExists(file) ? file : undefined),
    },
  });
  try {
    const project = api
      .updateSnapshot({ openProjects: [inspectionConfig] })
      .getProject(inspectionConfig);
    assert.ok(
      project,
      'Native TypeScript must inspect the actual checked closure',
    );
    const diagnostics = [
      ...project.program.getConfigFileParsingDiagnostics(),
      ...project.program.getProgramDiagnostics(),
      ...project.program.getGlobalDiagnostics(),
      ...project.program.getSyntacticDiagnostics(),
      ...project.program.getBindDiagnostics(),
      ...project.program.getSemanticDiagnostics(),
    ];
    assert.deepEqual(
      diagnostics,
      [],
      'Native declaration inspection must fully typecheck',
    );
    const canonical = file =>
      projectionSources.get(file) ?? fs.realpathSync(file);
    assert.deepEqual(
      project.program.getSourceFileNames().map(canonical).sort(),
      [...typeFiles].sort(),
      'The actual native inspection must use exactly the owning checker closure',
    );
    return { api, project, canonical, projectionSources };
  } catch (error) {
    api.close();
    throw error;
  }
}

function nativeDeclarationInterfaces(inspection) {
  const { project, projectionSources } = inspection;
  const interfaces = {};
  for (const [name, file, property, expectedType, optional] of [
    [
      'App',
      path.join(root, 'src/App.tsx'),
      'deferred',
      'Promise<string>',
      true,
    ],
    ['Signals', path.join(root, 'src/Signals.tsrx'), 'url', 'string', false],
  ]) {
    const nativeFile =
      [...projectionSources].find(([, source]) => source === file)?.[0] ?? file;
    const source = project.program.getSourceFile(nativeFile);
    assert.ok(source, `The native checker must load exported ${name}`);
    const declaration = source.statements.find(
      node => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(declaration, `Missing actual exported ${name} declaration`);
    const symbol = project.checker.getSymbolAtLocation(declaration.name);
    assert.ok(symbol, `Missing native ${name} symbol`);
    const signatures = project.checker.getSignaturesOfType(
      project.checker.getTypeOfSymbol(symbol),
      SignatureKind.Call,
    );
    assert.equal(
      signatures.length,
      1,
      `Native ${name} must expose one call signature`,
    );
    const props = project.checker.getParameterType(signatures[0], 0);
    assert.ok(props, `Missing native ${name} props`);
    assert.deepEqual(
      project.checker.getPropertiesOfType(props).map(item => item.name),
      [property],
    );
    const prop = project.checker.getPropertyOfType(props, property);
    assert.equal(
      Boolean(prop.flags & SymbolFlags.Optional),
      optional,
      `Native ${name}.${property} optionality`,
    );
    const type = project.checker.getTypeOfSymbol(prop);
    assert.ok(type);
    const actualType = project.checker.typeToString(
      project.checker.getNonNullableType(type),
    );
    assert.equal(
      actualType,
      expectedType,
      `Actual native ${name}.${property} declaration type`,
    );
    interfaces[name] = {
      file: path.relative(root, file),
      property,
      optional,
      type: actualType,
      propertyCount: 1,
      signatureCount: signatures.length,
    };
  }
  return interfaces;
}

function incomingGraph(inspection) {
  const { project, canonical } = inspection;
  const graph = new Map(
    project.program.getSourceFileNames().map(file => [canonical(file), []]),
  );
  for (const file of project.program.getSourceFileNames()) {
    const source = project.program.getSourceFile(file);
    const from = canonical(file);
    for (const specifier of source.imports) {
      if (!ts.isStringLiteral(specifier)) continue;
      const symbol = project.checker.getSymbolAtLocation(specifier);
      const targets = new Set(
        symbol?.declarations.flatMap(handle => {
          const declaration = handle.resolve(project);
          return declaration
            ? [canonical(declaration.getSourceFile().fileName)]
            : [];
        }) ?? [],
      );
      for (const to of targets)
        graph
          .get(to)
          ?.push({ kind: 'Imported', specifier: specifier.text, from, to });
    }
    for (const reference of source.referencedFiles) {
      const referenced = path.resolve(path.dirname(file), reference.fileName);
      const target = project.program.getSourceFile(referenced);
      assert.ok(
        target,
        `Native reference is not in the checked program: ${referenced}`,
      );
      const to = canonical(target.fileName);
      graph
        .get(to)
        .push({ kind: 'Referenced', specifier: reference.fileName, from, to });
    }
  }
  return graph;
}

function incomingEdges(graph, file) {
  assert.ok(
    graph.has(file),
    `Required native declaration is not loaded: ${file}`,
  );
  return graph.get(file);
}

function edgeSourceEvidence(edge, expectedStatement) {
  const lines = fs.readFileSync(edge.from, 'utf8').split('\n');
  const matches = lines.flatMap((statement, index) =>
    statement === expectedStatement ? [index] : [],
  );
  assert.equal(
    matches.length,
    1,
    `Exact native type-owner statement: ${edge.from}`,
  );
  const line = matches[0] + 1;
  const statement = lines[matches[0]];
  return {
    ...edge,
    line,
    sourceStatement: statement,
    sourceStatementSha256: sha256(Buffer.from(`${statement}\n`)),
  };
}

function rejectForeignAugmentations(inspection) {
  const foreignModule =
    /^(?:react(?:\/|$)|react-dom(?:\/|$)|@tanstack\/(?:react-router|solid-router)(?:\/|$))/u;
  for (const file of inspection.project.program.getSourceFileNames()) {
    const source = inspection.project.program.getSourceFile(file);
    const visit = node => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
        assert.ok(
          !foreignModule.test(node.name.text),
          `Foreign renderer module augmentation: ${file} -> ${node.name.text}`,
        );
      node.forEachChild(visit);
    };
    visit(source);
  }
}

async function maintainedTypeInterop(inspection, typeFiles) {
  const verified = admittedPackages;
  assert.equal(verified.nativeArtifact.version, admissionTuple.octane);
  assert.equal(
    verified.nativeRouterArtifact.version,
    admissionTuple['@octanejs/tanstack-router'],
  );
  assert.equal(verified.nativeArtifact.installedBytesVerified, true);
  const graph = incomingGraph(inspection);
  const ownerRoot = verified.nativeArtifact.packageRoot;
  const declarations = nativeDeclarationFiles.map(file => ({
    packagePath: `octane/dist/${file}`,
    ...fileEvidence(
      path.join(ownerRoot, 'dist', file),
      verified.nativeArtifact.fileHashes[`dist/${file}`],
    ),
  }));
  const owner = new Map(
    declarations.map(file => [file.packagePath, file.realpath]),
  );
  const jsx = owner.get('octane/dist/jsx-runtime.d.ts');
  const publicTypes = owner.get('octane/dist/public-types.d.ts');
  const index = owner.get('octane/dist/index.d.ts');
  assert.ok(
    graph.has(jsx) && graph.has(publicTypes) && graph.has(index),
    'Load the actual native public type owner',
  );
  const reactTypes = typeFiles.filter(file =>
    /@types[/\\]react[/\\]/u.test(file),
  );
  assert.equal(
    reactTypes.length,
    2,
    'The native interop boundary permits exactly two React declarations',
  );
  const reactIndex = reactTypes.find(
    file => path.basename(file) === 'index.d.ts',
  );
  assert.ok(
    reactIndex,
    'The native type contract imports the exact React index',
  );
  const reactRoot = path.dirname(reactIndex);
  const reactManifest = JSON.parse(
    fs.readFileSync(path.join(reactRoot, 'package.json'), 'utf8'),
  );
  assert.equal(reactManifest.name, '@types/react');
  assert.equal(reactManifest.version, admissionTuple['@types/react']);
  const reactFiles = Object.entries(reactDeclarationHashes).map(
    ([file, hash]) => ({
      packagePath: `@types/react/${file}`,
      ...fileEvidence(path.join(reactRoot, file), hash),
      owningNativeRole:
        file === 'index.d.ts'
          ? 'octane-published-jsx-ref-dom-and-hosted-island-type-contract'
          : 'transitive-dom-interface-placeholders-for-native-jsx',
    }),
  );
  assert.deepEqual(
    [...reactTypes].sort(),
    reactFiles.map(file => file.realpath).sort(),
  );
  const reactGlobal = reactFiles.find(file =>
    file.packagePath.endsWith('/global.d.ts'),
  ).realpath;
  const expectedReactEdges = [
    { kind: 'Imported', specifier: 'react', from: jsx, to: reactIndex },
    { kind: 'Imported', specifier: 'react', from: publicTypes, to: reactIndex },
  ];
  const sortEdges = edges =>
    [...edges].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  assert.deepEqual(
    sortEdges(incomingEdges(graph, reactIndex)),
    sortEdges(expectedReactEdges),
    'Only native owner declarations import React types',
  );
  const globalEdges = [
    {
      kind: 'Referenced',
      specifier: 'global.d.ts',
      from: reactIndex,
      to: reactGlobal,
    },
  ];
  assert.deepEqual(incomingEdges(graph, reactGlobal), globalEdges);
  assert.deepEqual(incomingEdges(graph, publicTypes), [
    {
      kind: 'Imported',
      specifier: './public-types.js',
      from: index,
      to: publicTypes,
    },
  ]);
  assert.ok(
    incomingEdges(graph, jsx).some(
      edge =>
        edge.from === publicTypes && edge.specifier === './jsx-runtime.js',
    ),
  );
  const foreignTypeFiles = typeFiles.filter(file =>
    /(?:octane[/\\]dist[/\\]react[/\\]|@types[/\\]react-dom[/\\]|@tanstack[/\\](?:react-router|solid-router)[/\\])/u.test(
      file,
    ),
  );
  assert.deepEqual(
    foreignTypeFiles,
    [],
    'Foreign renderer types are outside the native interop boundary',
  );
  rejectForeignAugmentations(inspection);
  const runtimeScopes = [
    { name: 'consumer', directory: root },
    { name: 'octane', directory: ownerRoot },
    ...(verified.nativeRouterArtifact
      ? [
          {
            name: '@octanejs/tanstack-router',
            directory: verified.nativeRouterArtifact.packageRoot,
          },
        ]
      : []),
  ];
  for (const scope of runtimeScopes) {
    const scopedRequire = createRequire(
      path.join(scope.directory, 'package.json'),
    );
    for (const name of ['react', 'react-dom'])
      assert.throws(
        () => scopedRequire.resolve(name),
        { code: 'MODULE_NOT_FOUND' },
        `No ${name} runtime in ${scope.name}`,
      );
  }
  return {
    schemaVersion: 1,
    declaredScope:
      'Native-authored JSX/ref/DOM and React-hosted-island TYPE-only interop',
    domTaxonomyOnly: false,
    blanketReactTypeException: false,
    nativeArtifact: verified.nativeArtifact,
    nativeRouterArtifact: verified.nativeRouterArtifact,
    nativeOwnerDeclarations: declarations,
    reactPackage: {
      name: '@types/react',
      version: admissionTuple['@types/react'],
    },
    reactFiles,
    incomingEdges: [
      edgeSourceEvidence(
        expectedReactEdges[0],
        "import type * as React from 'react';",
      ),
      edgeSourceEvidence(
        expectedReactEdges[1],
        "import type * as React from 'react';",
      ),
      edgeSourceEvidence(
        globalEdges[0],
        '/// <reference path="global.d.ts" />',
      ),
      edgeSourceEvidence(
        {
          kind: 'Imported',
          specifier: './public-types.js',
          from: index,
          to: publicTypes,
        },
        "export type * from './public-types.js';",
      ),
    ],
    canonicalTypeProgramSha256: sha256(
      Buffer.from(`${JSON.stringify(typeFiles)}\n`),
    ),
    incomingGraph: [...graph].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    canonicalIncomingGraphSha256: sha256(
      Buffer.from(
        JSON.stringify(
          [...graph].sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    ),
    scopedRuntimeAbsenceVerified: runtimeScopes,
    foreignRendererTypes: [],
    foreignRendererAugmentations: [],
    nonNativeRuntime: false,
    types: [],
    skipLibCheck: false,
  };
}

let inspection;
try {
  fs.writeFileSync(checkedConfig, JSON.stringify(config));
  const checked = command(checker, [
    '--noEmit',
    '-p',
    checkedConfig,
    '--listFiles',
  ]);
  assert.equal(checked.status, 0, checked.output);
  const checkedProgram = checkOctaneProject({
    project: checkedConfig,
    cwd: root,
  });
  assert.equal(checkedProgram.compilerVersion, '7.0.2');
  assert.deepEqual(
    checkedProgram.diagnostics,
    [],
    'The owning renderer public checker must accept the strict native application',
  );
  const typeFiles = [
    ...new Set(checkedProgram.files.map(file => fs.realpathSync(file))),
  ].sort();
  const reportedFiles = checked.stdout
    .split(/\r?\n/u)
    .filter(file => path.isAbsolute(file))
    .map(file => fs.realpathSync(file));
  assert.deepEqual(
    [...new Set(reportedFiles)].sort(),
    typeFiles,
    'The installed Octane binary and public API must check the same native closure',
  );
  inspection = nativeInspection(typeFiles);
  const foreignRouterTypes = typeFiles.filter(file =>
    /@tanstack[/\\](?:react-router|solid-router)[/\\]/.test(file),
  );
  assert.deepEqual(
    foreignRouterTypes,
    [],
    'Another renderer router leaked into the native type program',
  );
  const nativeJsxTypes = typeFiles.filter(file =>
    /@types[/\\]react[/\\]/.test(file),
  );
  assert.ok(
    nativeJsxTypes.length > 0,
    'Record the JSX type dependency authored by the admitted Octane release',
  );
  assert.throws(() => require.resolve('react'), { code: 'MODULE_NOT_FOUND' });
  const nativeTypeInterop = await maintainedTypeInterop(inspection, typeFiles);
  const formatted = command(formatter, [
    '--check',
    'src/Counter.tsrx',
    'src/Signals.tsrx',
  ]);
  assert.equal(formatted.status, 0, formatted.output);
  const declarationInterfaces = nativeDeclarationInterfaces(inspection);

  const negativeDirectory = fs.mkdtempSync(
    path.join(root, 'tooling-negative-'),
  );
  try {
    fs.writeFileSync(
      path.join(negativeDirectory, 'invalid.tsrx'),
      `
export function NeedsNumber({ value }: { value: number }) @{
  <p>{value}</p>;
}
export function Broken() @{
  const invalid: number = 'not-number';
  <NeedsNumber value={'wrong'} />;
  <p>{invalid}</p>;
}
`,
    );
    fs.writeFileSync(
      path.join(negativeDirectory, 'tsconfig.json'),
      JSON.stringify({ ...config, include: ['invalid.tsrx'] }),
    );
    const negative = command(checker, [
      '--noEmit',
      '-p',
      path.join(negativeDirectory, 'tsconfig.json'),
    ]);
    assert.notEqual(
      negative.status,
      0,
      'Native TSRX checker accepted invalid types',
    );
    assert.match(negative.output, /invalid\.tsrx\(6,\d+\): error TS2322/);
    assert.match(negative.output, /invalid\.tsrx\(7,\d+\): error TS2322/);
  } finally {
    fs.rmSync(negativeDirectory, { recursive: true, force: true });
    fs.rmSync(checkedConfig, { force: true });
  }

  const evidence = {
    passed: true,
    strictTypeClosure: true,
    canonicalGeneratedCompilerFlags: true,
    exactOptionalPropertyTypes:
      config.compilerOptions.exactOptionalPropertyTypes === true,
    noUncheckedIndexedAccess:
      config.compilerOptions.noUncheckedIndexedAccess === true,
    noPropertyAccessFromIndexSignature:
      config.compilerOptions.noPropertyAccessFromIndexSignature === true,
    isolatedRouterTypes: true,
    rendererOwnedJsxTypeFiles: nativeJsxTypes,
    reactRuntimeInstalled: false,
    nativeFormatting: true,
    concreteDeclarations: true,
    nativeDeclarationInterfaces: declarationInterfaces,
    nativeChecker: {
      compilerVersion: checkedProgram.compilerVersion,
      bin: checker,
      publicApi: '@modern-js/renderer-octane/typecheck',
      samePhysicalCompiler: typescriptManifest,
      command: {
        executable: checked.executable,
        args: checked.args,
        cwd: checked.cwd,
        status: checked.status,
        signal: checked.signal,
      },
      program: {
        compilerVersion: checkedProgram.compilerVersion,
        diagnostics: checkedProgram.diagnostics,
        config,
        files: typeFiles.map(file => fileEvidence(file)),
      },
      sdk: {
        manifest: fileEvidence(sdkManifestFile),
        bin: fileEvidence(checker),
        publicApi: fileEvidence(sdkPublicApiFile),
      },
    },
    negativeAuthoredDiagnostics: true,
    ...(nativeTypeInterop ? { nativeTypeInterop } : {}),
  };
  fs.writeFileSync(receipt, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} catch (error) {
  fs.writeFileSync(
    receipt,
    `${JSON.stringify({ passed: false, failure: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  inspection?.api.close();
  fs.rmSync(checkedConfig, { force: true });
}
