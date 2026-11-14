const fs = require('fs');
const path = require('path');

const { createRepositoryGitEnv, runCommand } = require('../lib/process-kit');
const {
  DEFAULT_DIVERGENCE_BASE_REF,
  DEFAULT_UPSTREAM_PROVENANCE_REF,
  parseLedgerEvidenceRows,
  resolveCommitSha,
  resolveRepositoryTopLevel,
} = require('./divergence');
const { createImportOwnership, packageName } = require('./import-ownership');

const DEFAULT_BASE_REF = DEFAULT_DIVERGENCE_BASE_REF;
const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, 'allowlist.json');
const SOURCE_FILE_PATTERN =
  /^packages\/.+\/src\/.+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/;
const ALLOWLIST_SCHEMA_VERSION = 2;

const DEFAULT_DENYLIST = Object.freeze([
  '@modern-js/plugin-tanstack',
  '@modern-js/plugin-i18n',
  'create-request',
  'backend-federation',
  'runtime-extensions',
  'data-platform',
  'ultramodern',
  'micro-vertical',
  'superapp',
  'delivery-unit',
]);

const toPosixPath = value => value.split(path.sep).join('/');

const runGit = ({ rootDir, args, allowFailure = false }) => {
  const result = runCommand('git', ['--literal-pathspecs', ...args], {
    env: createRepositoryGitEnv(),
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = result.processStatus;

  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (!allowFailure && status !== 0) {
    const stderr = result.stderr.trim();
    const suffix = stderr ? `: ${stderr}` : '';
    throw new Error(`git ${args.join(' ')} failed${suffix}`);
  }

  return {
    ...result,
    status,
  };
};

const normalizeViolation = violation => ({
  file: toPosixPath(violation.file),
  specifier: violation.specifier,
});

const violationKey = violation =>
  `${violation.file}\u0000${violation.specifier}`;

const sortViolationRecords = violations =>
  [...violations].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.specifier.localeCompare(right.specifier),
  );

const listPackageSourceFiles = (rootDir, headRef) => {
  const result = runGit({
    rootDir,
    args: headRef
      ? ['ls-tree', '-r', '--name-only', '-z', headRef, '--', 'packages']
      : ['ls-files', '-z', '--', 'packages'],
  });

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(toPosixPath)
    .filter(file => SOURCE_FILE_PATTERN.test(file))
    .filter(file => headRef || fs.existsSync(path.join(rootDir, file)))
    .sort();
};

const listUpstreamOwnedPackageSourceFiles = ({
  rootDir,
  baseRef = DEFAULT_BASE_REF,
  upstreamRef = baseRef === DEFAULT_BASE_REF
    ? DEFAULT_UPSTREAM_PROVENANCE_REF
    : baseRef,
  files,
  headRef,
}) => {
  const resolvedBase = resolveCommitSha({ rootDir, ref: baseRef });
  if (!resolvedBase) {
    throw new Error(
      `Import ownership base ${String(baseRef)} does not resolve to a commit.`,
    );
  }
  const inventory = createImportOwnership({
    rootDir,
    baseRef: resolvedBase,
    upstreamRef,
    headRef,
    runGit,
  });
  return [...inventory.files]
    .filter(
      file =>
        SOURCE_FILE_PATTERN.test(inventory.ownership.get(file) ?? file) &&
        (inventory.ownership.has(file) ||
          inventory.packageForFile(file)?.upstream) &&
        (!files || files.includes(file)),
    )
    .sort();
};

const findDenylistMatches = ({ specifier, denylist = DEFAULT_DENYLIST }) => {
  // Legacy unresolved edges retain exact markers; a name substring is never
  // package ownership. Resolved edges use the measured package/source identity.
  return denylist.filter(marker =>
    marker.startsWith('@')
      ? specifier === marker || specifier.startsWith(`${marker}/`)
      : specifier.split('/').includes(marker),
  );
};

const NATIVE_REQUEST_PACKAGE = 'packages/server/create-request';
const NATIVE_REQUEST_SPECIFIER = '@modern-js/create-request';
const NATIVE_REQUEST_BINDINGS = new Set([
  'configure',
  'createRequest',
  'createUploader',
]);
const NATIVE_REQUEST_TYPES = new Set([
  'RequestOptions',
  'UploadOptions',
  'BFFRequestPayload',
  'Sender',
  'HttpMethodDecider',
  'RequestTarget',
  'RequestHeaders',
  'RequestFetcher',
  'RequestStartContext',
  'RequestHeadersContext',
  'RequestDispatchContext',
  'RequestHooks',
  'RequestCreatorOptions',
  'RequestCreator',
  'UploadCreatorOptions',
  'UploadCreator',
  'IOptions',
  'RequestClient',
]);
const RETIRED_REQUEST_POLICY_NAMES = new Set([
  'BFF_ENVELOPE_HEADER',
  'BFF_OPERATION_CONTEXT_HEADER',
  'BFF_OPERATION_CONTEXT_DETAIL_HEADER',
  'BFF_DEFAULT_PROTECTED_IDENTITY_HEADERS',
  'ResolveHeadersOptions',
  'ResolveHeaders',
  'AllowCrossOriginEnvelopeOptions',
  'AllowCrossOriginEnvelope',
  'TransportTarget',
  'RetryDecisionContext',
  'RetryBackoffOptions',
  'DegradedModeReason',
  'DegradedModeEvent',
  'TransportResilienceOptions',
  'IdentityBindingViolationReason',
  'IdentityBindingViolation',
  'DeriveIdentityHeadersOptions',
  'IdentityBindingOptions',
  'OperationContractViolationReason',
  'OperationContractViolation',
  'CrossProjectOperationContract',
  'CrossProjectPolicyViolationReason',
  'CrossProjectPolicyViolation',
  'OperationContractOptions',
  'OperationContextSource',
  'OperationContext',
  'CrossOriginEnvelopePolicyError',
  'IdentityBindingViolationError',
  'OperationContractViolationError',
  'ProducerClientNotInitializedError',
  'ProducerDomainNotConfiguredError',
  'requireEnvelope',
  'allowCrossOriginEnvelope',
  'resolveHeaders',
  'transport',
  'identityBinding',
  'operationContract',
  'operationContext',
  'traceparent',
  'policyCore',
  'requestContext',
]);

const parseSourceAst = (content, file) => {
  const { parseSync } = require('@babel/core');
  try {
    return parseSync(content, {
      filename: file,
      babelrc: false,
      configFile: false,
      sourceType: 'unambiguous',
      parserOpts: {
        plugins: ['typescript', ...(file.endsWith('x') ? ['jsx'] : [])],
      },
    });
  } catch {
    return null;
  }
};

const astName = node =>
  node?.type === 'Identifier'
    ? node.name
    : node?.type === 'StringLiteral'
      ? node.value
      : null;

const collectModuleReferences = ast => {
  const { types: babelTypes } = require('@babel/core');
  const references = [];
  babelTypes.traverseFast(ast, node => {
    let source;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      if (!node.source) return;
      source = node.source;
    } else if (node.type === 'ImportExpression') {
      source = node.source;
    } else if (node.type === 'TSImportType') {
      source = node.source ?? node.argument;
    } else if (
      node.type === 'TSImportEqualsDeclaration' &&
      node.moduleReference.type === 'TSExternalModuleReference'
    ) {
      source = node.moduleReference.expression;
    } else if (
      node.type === 'CallExpression' &&
      (node.callee.type === 'Import' ||
        (node.callee.type === 'Identifier' && node.callee.name === 'require'))
    ) {
      source = node.arguments[0];
    } else {
      return;
    }
    references.push({
      node,
      specifier:
        source?.type === 'StringLiteral'
          ? source.value
          : source?.type === 'TemplateLiteral' &&
              source.expressions.length === 0
            ? (source.quasis[0].value.cooked ?? source.quasis[0].value.raw)
            : null,
    });
  });
  return references;
};

const hasOnlyNativeRequestBindings = (content, file = 'index.ts') => {
  const ast = parseSourceAst(content, file);
  if (!ast) return false;
  const references = collectModuleReferences(ast).filter(
    reference => reference.specifier === NATIVE_REQUEST_SPECIFIER,
  );
  return (
    references.length > 0 &&
    references.every(({ node }) => {
      if (node.type === 'ImportDeclaration') {
        return (
          node.specifiers.length > 0 &&
          node.specifiers.every(
            specifier =>
              specifier.type === 'ImportSpecifier' &&
              NATIVE_REQUEST_BINDINGS.has(astName(specifier.imported)),
          )
        );
      }
      return (
        node.type === 'ExportNamedDeclaration' &&
        node.specifiers.length > 0 &&
        node.specifiers.every(
          specifier =>
            specifier.type === 'ExportSpecifier' &&
            NATIVE_REQUEST_BINDINGS.has(astName(specifier.local)),
        )
      );
    })
  );
};

const publicBindings = ast => {
  const { types: babelTypes } = require('@babel/core');
  const bindings = [];
  const wildcardSources = [];
  for (const node of ast.program.body) {
    if (
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'TSExportAssignment'
    ) {
      return null;
    }
    if (node.type === 'ExportAllDeclaration') {
      wildcardSources.push(astName(node.source));
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration) {
      const declaration = node.declaration;
      const typeOnly =
        declaration.type === 'TSTypeAliasDeclaration' ||
        declaration.type === 'TSInterfaceDeclaration';
      const names = typeOnly
        ? [declaration.id.name]
        : Object.keys(babelTypes.getBindingIdentifiers(declaration));
      if (names.length === 0) return null;
      bindings.push(...names.map(name => ({ name, typeOnly })));
    }
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier') return null;
      bindings.push({
        name: astName(specifier.exported),
        typeOnly: node.exportKind === 'type' || specifier.exportKind === 'type',
      });
    }
  }
  return { bindings, wildcardSources };
};

const containsRetiredRequestPolicy = ast => {
  const { types: babelTypes } = require('@babel/core');
  let found = false;
  babelTypes.traverseFast(ast, node => {
    if (
      node.type === 'Identifier' &&
      RETIRED_REQUEST_POLICY_NAMES.has(node.name)
    ) {
      found = true;
    }
    // Quoted/computed property keys are code, unlike unrelated string values.
    if (
      RETIRED_REQUEST_POLICY_NAMES.has(astName(node.key)) ||
      ((node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression') &&
        RETIRED_REQUEST_POLICY_NAMES.has(astName(node.property)))
    ) {
      found = true;
    }
  });
  return found;
};

const isRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasKeys = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const stringLeaves = value => {
  if (typeof value === 'string') return [value];
  if (!isRecord(value) && !Array.isArray(value)) return [null];
  const children = Object.values(value);
  return children.length > 0 ? children.flatMap(stringLeaves) : [null];
};

const isNativeCreateRequestSurface = ({ manifest, sources }, native) => {
  if (!isRecord(manifest) || manifest.name !== NATIVE_REQUEST_SPECIFIER) {
    return false;
  }
  if (
    !hasKeys(manifest.exports, ['.', './client', './server']) ||
    !hasKeys(manifest.typesVersions, ['*']) ||
    !hasKeys(manifest.typesVersions['*'], ['.', 'client', 'server'])
  ) {
    return false;
  }
  const targets = [
    manifest.main,
    manifest.types,
    manifest['modern:source'],
    ...stringLeaves(manifest.exports),
    ...stringLeaves(manifest.typesVersions),
  ];
  if (
    targets.some(
      target =>
        typeof target !== 'string' ||
        !/^\.\/(?:src\/(?:node|browser)\.ts|dist\/(?:types\/(?:node|browser)\.d\.ts|(?:cjs|esm|esm-node)\/(?:node|browser)\.(?:js|mjs)))$/.test(
          target,
        ),
    )
  ) {
    return false;
  }
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (
      manifest[field] !== undefined &&
      (!isRecord(manifest[field]) ||
        Object.entries(manifest[field]).some(
          ([name, range]) =>
            !native.dependencies.has(name) ||
            typeof range !== 'string' ||
            (range.includes(':') && !range.startsWith('workspace:')),
        ))
    ) {
      return false;
    }
  }
  if (
    !isRecord(sources) ||
    !['node.ts', 'browser.ts', 'types.ts'].every(file =>
      Object.hasOwn(sources, file),
    ) ||
    Object.keys(sources).some(file => !native.sources.has(file))
  ) {
    return false;
  }
  for (const [file, content] of Object.entries(sources)) {
    const ast = parseSourceAst(content, file);
    if (!ast || containsRetiredRequestPolicy(ast)) return false;
    for (const { specifier } of collectModuleReferences(ast)) {
      if (specifier === null) return false;
      if (findDenylistMatches({ specifier }).length > 0) return false;
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        );
        if (
          !Object.hasOwn(sources, resolved) &&
          !Object.hasOwn(sources, `${resolved}.ts`)
        ) {
          return false;
        }
      } else {
        const dependency = packageName(specifier);
        if (
          !native.dependencies.has(dependency) &&
          specifier !== 'http' &&
          specifier !== 'node:http'
        ) {
          return false;
        }
      }
    }
    if (file === 'node.ts' || file === 'browser.ts') {
      const exports = publicBindings(ast);
      if (
        !exports ||
        exports.bindings.some(
          binding =>
            !NATIVE_REQUEST_BINDINGS.has(binding.name) &&
            binding.name !== 'createClient',
        ) ||
        [...NATIVE_REQUEST_BINDINGS].some(
          name =>
            !exports.bindings.some(
              binding => binding.name === name && !binding.typeOnly,
            ),
        ) ||
        exports.wildcardSources.some(source => source !== './types')
      ) {
        return false;
      }
    }
    if (file === 'types.ts') {
      const exports = publicBindings(ast);
      if (
        !exports ||
        exports.wildcardSources.length > 0 ||
        exports.bindings.some(
          binding =>
            !binding.typeOnly || !NATIVE_REQUEST_TYPES.has(binding.name),
        )
      ) {
        return false;
      }
    }
  }
  return true;
};

const readNativeRequestTarget = ({ rootDir, headRef }) => {
  const read = file =>
    headRef
      ? runGit({ rootDir, args: ['show', `${headRef}:${file}`] }).stdout
      : fs.readFileSync(path.join(rootDir, file), 'utf8');
  const manifest = JSON.parse(read(`${NATIVE_REQUEST_PACKAGE}/package.json`));
  const prefix = `${NATIVE_REQUEST_PACKAGE}/src/`;
  let files;
  if (headRef) {
    const tree = runGit({
      rootDir,
      args: ['ls-tree', '-r', '-z', headRef, '--', prefix],
    }).stdout;
    files = tree
      .split('\0')
      .filter(Boolean)
      .map(record => {
        const [metadata, file] = record.split('\t');
        if (
          !metadata.startsWith('100644 ') &&
          !metadata.startsWith('100755 ')
        ) {
          throw new Error('Native request source must be an ordinary file.');
        }
        return file;
      });
  } else {
    files = fs
      .readdirSync(path.join(rootDir, prefix), { recursive: true })
      .map(file => `${prefix}${toPosixPath(file)}`)
      .filter(file => {
        const stat = fs.lstatSync(path.join(rootDir, file));
        if (stat.isSymbolicLink()) {
          throw new Error('Native request source must not follow symlinks.');
        }
        return !stat.isDirectory();
      });
  }
  return {
    manifest,
    sources: Object.fromEntries(
      files.map(file => [file.slice(prefix.length), read(file)]),
    ),
  };
};

const isNativeCreateRequestPackage = ({ rootDir, baseRef, headRef }) => {
  try {
    const base = readNativeRequestTarget({ rootDir, headRef: baseRef });
    const dependencies = new Set(Object.keys(base.manifest.dependencies));
    for (const [file, content] of Object.entries(base.sources)) {
      const ast = parseSourceAst(content, file);
      if (!ast) return false;
      for (const { specifier } of collectModuleReferences(ast)) {
        if (specifier && !specifier.startsWith('.')) {
          const dependency = packageName(specifier);
          if (Object.hasOwn(base.manifest.devDependencies ?? {}, dependency))
            dependencies.add(dependency);
        }
      }
    }
    // Only the reviewed neutral factory/header extraction extends native source
    // identity; arbitrary new files never inherit a package-wide exemption.
    const native = {
      dependencies,
      sources: new Set([
        ...Object.keys(base.sources),
        'headers.ts',
        'requestFactory.ts',
      ]),
    };
    return (
      base.manifest.name === NATIVE_REQUEST_SPECIFIER &&
      isNativeCreateRequestSurface(
        readNativeRequestTarget({ rootDir, headRef }),
        native,
      )
    );
  } catch {
    // Incomplete, malformed or unreviewed targets retain the original marker.
    return false;
  }
};

const scanUpstreamOwnedForkImports = ({
  rootDir = process.cwd(),
  baseRef = DEFAULT_BASE_REF,
  upstreamRef = baseRef === DEFAULT_BASE_REF
    ? DEFAULT_UPSTREAM_PROVENANCE_REF
    : baseRef,
  denylist = DEFAULT_DENYLIST,
  files,
  headRef,
} = {}) => {
  rootDir = resolveRepositoryTopLevel({ rootDir });
  const targetRef = headRef ?? 'HEAD';
  const resolvedHead = resolveCommitSha({ rootDir, ref: targetRef });
  if (!resolvedHead) {
    throw new Error(
      `Import target ${String(targetRef)} does not resolve to a commit.`,
    );
  }
  const resolvedBase = resolveCommitSha({ rootDir, ref: baseRef });
  if (!resolvedBase) {
    throw new Error(
      `Import ownership base ${String(baseRef)} does not resolve to a commit.`,
    );
  }
  runGit({
    rootDir,
    args: ['merge-base', '--is-ancestor', resolvedBase, resolvedHead],
  });
  const resolvedUpstream = resolveCommitSha({ rootDir, ref: upstreamRef });
  if (!resolvedUpstream)
    throw new Error(
      'Import reviewed upstream provenance does not resolve to a commit.',
    );
  runGit({
    rootDir,
    args: ['merge-base', '--is-ancestor', resolvedBase, resolvedUpstream],
  });
  runGit({
    rootDir,
    args: ['merge-base', '--is-ancestor', resolvedUpstream, resolvedHead],
  });
  const inventory = createImportOwnership({
    rootDir,
    baseRef: resolvedBase,
    upstreamRef: resolvedUpstream,
    headRef: headRef === undefined ? undefined : resolvedHead,
    runGit,
  });
  const upstreamOwnedFiles = [...inventory.files].filter(
    file =>
      SOURCE_FILE_PATTERN.test(inventory.ownership.get(file) ?? file) &&
      (inventory.ownership.has(file) ||
        inventory.packageForFile(file)?.upstream) &&
      (!files || files.includes(file)),
  );
  const violations = [];
  let nativeRequestPackage;

  upstreamOwnedFiles.forEach(file => {
    const content = inventory.read(file);
    const ast = parseSourceAst(content, file);
    if (!ast) throw new Error(`Cannot parse governed import source: ${file}`);
    const specifiers = [
      ...new Set(
        collectModuleReferences(ast)
          .map(reference => reference.specifier)
          .filter(specifier => specifier !== null),
      ),
    ];

    specifiers.forEach(specifier => {
      const targets = inventory.resolve(specifier, file);
      const forkTargets = targets.filter(target => target.forkOwned);
      let markers =
        targets.length === 0
          ? findDenylistMatches({ specifier, denylist })
          : [...new Set(forkTargets.map(target => target.marker))];
      if (
        specifier === NATIVE_REQUEST_SPECIFIER ||
        (targets.some(target => target.package === NATIVE_REQUEST_SPECIFIER) &&
          inventory.packageForFile(file)?.manifest.name !==
            NATIVE_REQUEST_SPECIFIER)
      ) {
        nativeRequestPackage ??= isNativeCreateRequestPackage({
          rootDir,
          baseRef: resolvedBase,
          headRef: headRef === undefined ? undefined : resolvedHead,
        });
        markers.push('create-request');
      }
      if (
        specifier === NATIVE_REQUEST_SPECIFIER &&
        markers.includes('create-request') &&
        hasOnlyNativeRequestBindings(content, file)
      ) {
        nativeRequestPackage ??= isNativeCreateRequestPackage({
          rootDir,
          baseRef: resolvedBase,
          headRef: headRef === undefined ? undefined : resolvedHead,
        });
        if (nativeRequestPackage) {
          markers = markers.filter(marker => marker !== 'create-request');
        }
      }
      if (markers.length === 0) {
        return;
      }

      violations.push({
        file,
        specifier,
        markers,
        ...(forkTargets.length > 0
          ? { targets: forkTargets.map(target => target.target) }
          : {}),
      });
    });
  });

  return {
    baseRef: resolvedBase,
    upstreamRef: resolvedUpstream,
    headRef: headRef === undefined ? null : resolvedHead,
    scannedFiles: upstreamOwnedFiles.length,
    violations: sortViolationRecords(violations),
  };
};

const createAllowlistSnapshot = ({
  baseRef = DEFAULT_BASE_REF,
  upstreamRef = baseRef === DEFAULT_BASE_REF
    ? DEFAULT_UPSTREAM_PROVENANCE_REF
    : baseRef,
  denylist = DEFAULT_DENYLIST,
  violations,
  bridges = [],
}) => ({
  schemaVersion: ALLOWLIST_SCHEMA_VERSION,
  baseRef,
  upstreamRef,
  migrationGoal:
    'Shrink this list as UltraModern-only imports move out of upstream-owned files.',
  denylist: [...denylist],
  bridges,
  violations: sortViolationRecords(violations).map(normalizeViolation),
});

const readAllowlist = (allowlistPath, { rootDir, headRef } = {}) => {
  if (!headRef && !fs.existsSync(allowlistPath)) {
    throw new Error(`Allowlist does not exist: ${allowlistPath}`);
  }

  const allowlist = JSON.parse(
    headRef
      ? runGit({
          rootDir,
          args: [
            'show',
            `${headRef}:${toPosixPath(path.relative(rootDir, allowlistPath))}`,
          ],
        }).stdout
      : fs.readFileSync(allowlistPath, 'utf8'),
  );

  if (allowlist.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported allowlist schemaVersion ${String(
        allowlist.schemaVersion,
      )}; expected ${String(ALLOWLIST_SCHEMA_VERSION)}`,
    );
  }

  if (!Array.isArray(allowlist.violations)) {
    throw new Error('Allowlist violations must be an array');
  }
  if (!Array.isArray(allowlist.bridges))
    throw new Error('Import bridges must be an array.');
  const bridgeKeys = new Set();
  for (const bridge of allowlist.bridges) {
    if (
      !hasKeys(bridge, ['file', 'specifier', 'target', 'owner', 'reason']) ||
      Object.values(bridge).some(
        value => typeof value !== 'string' || value.trim().length === 0,
      ) ||
      [bridge.file, bridge.specifier, bridge.target].some(value =>
        /[*?\\]/.test(value),
      ) ||
      !SOURCE_FILE_PATTERN.test(bridge.file) ||
      !bridge.target.startsWith('packages/') ||
      [bridge.file, bridge.target].some(
        value => path.posix.normalize(value) !== value,
      )
    ) {
      throw new Error(
        'Import bridges require exact source, specifier, target, owner and reason.',
      );
    }
    const key = `${bridge.file}\0${bridge.specifier}\0${bridge.target}`;
    if (bridgeKeys.has(key)) throw new Error('Duplicate import bridge.');
    bridgeKeys.add(key);
  }

  return {
    ...allowlist,
    violations: sortViolationRecords(
      allowlist.violations.map(normalizeViolation),
    ),
  };
};

const writeAllowlist = ({
  rootDir = process.cwd(),
  baseRef = DEFAULT_BASE_REF,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  denylist = DEFAULT_DENYLIST,
  files,
} = {}) => {
  const report = scanUpstreamOwnedForkImports({
    rootDir,
    baseRef,
    denylist,
    files,
  });
  const snapshot = createAllowlistSnapshot({
    baseRef,
    denylist,
    violations: report.violations,
    // Snapshotting migration debt must never authorize new edges. Keep only
    // explicitly reviewed bridges already recorded in the checked-in policy.
    bridges: fs.existsSync(allowlistPath)
      ? readAllowlist(allowlistPath).bridges
      : [],
  });

  fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
  fs.writeFileSync(
    allowlistPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  return {
    ...report,
    allowlistPath,
  };
};

const diffViolations = ({ currentViolations, allowlistViolations }) => {
  const currentByKey = new Map(
    currentViolations.map(violation => [violationKey(violation), violation]),
  );
  const allowlistByKey = new Map(
    allowlistViolations.map(violation => [violationKey(violation), violation]),
  );

  return {
    added: sortViolationRecords(
      [...currentByKey.entries()]
        .filter(([key]) => !allowlistByKey.has(key))
        .map(([, violation]) => violation),
    ),
    removed: sortViolationRecords(
      [...allowlistByKey.entries()]
        .filter(([key]) => !currentByKey.has(key))
        .map(([, violation]) => violation),
    ),
  };
};

const checkForkImportBoundary = ({
  rootDir = process.cwd(),
  baseRef = DEFAULT_BASE_REF,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  denylist = DEFAULT_DENYLIST,
  files,
  headRef,
} = {}) => {
  const allowlist = readAllowlist(allowlistPath, { rootDir, headRef });
  const current = scanUpstreamOwnedForkImports({
    rootDir,
    baseRef,
    denylist,
    files,
    headRef,
  });
  const recordedBase = resolveCommitSha({ rootDir, ref: allowlist.baseRef });
  if (!recordedBase || recordedBase !== current.baseRef) {
    throw new Error(
      'Import allowlist ownership base does not match the measured base.',
    );
  }
  const recordedUpstream = resolveCommitSha({
    rootDir,
    ref: allowlist.upstreamRef,
  });
  if (!recordedUpstream || recordedUpstream !== current.upstreamRef)
    throw new Error(
      'Import allowlist reviewed upstream provenance does not match the measured source.',
    );
  const bridges = allowlist.bridges;
  if (bridges.length > 0) {
    const ledger = headRef
      ? runGit({ rootDir, args: ['show', `${headRef}:FORK-DIVERGENCE.md`] })
          .stdout
      : fs.readFileSync(path.join(rootDir, 'FORK-DIVERGENCE.md'), 'utf8');
    const evidence = parseLedgerEvidenceRows(ledger);
    for (const bridge of bridges) {
      if (
        !evidence.some(
          row =>
            row.path === bridge.file &&
            row.owner === bridge.owner &&
            row.disposition
              .split('+')
              .map(value => value.trim())
              .includes('inline-patch') &&
            row.problems.length === 0,
        )
      ) {
        throw new Error(
          `Import bridge requires inline-patch ledger ownership: ${bridge.file}`,
        );
      }
    }
  }
  const accepted = [];
  current.violations = current.violations.filter(violation => {
    if (!violation.targets?.length) return true;
    const matching = bridges.filter(
      bridge =>
        bridge.file === violation.file &&
        bridge.specifier === violation.specifier &&
        violation.targets.includes(bridge.target),
    );
    if (
      !violation.targets.every(target =>
        matching.some(bridge => bridge.target === target),
      )
    )
      return true;
    accepted.push(...matching);
    return false;
  });
  const diff = diffViolations({
    currentViolations: current.violations,
    allowlistViolations: allowlist.violations,
  });

  return {
    baseRef: current.baseRef,
    upstreamRef: current.upstreamRef,
    headRef: current.headRef,
    allowlistPath,
    scannedFiles: current.scannedFiles,
    currentViolations: current.violations,
    allowlistViolations: allowlist.violations,
    added: diff.added,
    removed: diff.removed,
    reviewedBridges: accepted,
    ok: current.violations.length === 0,
  };
};

const formatViolation = violation => {
  const markers = violation.markers?.length
    ? ` [${violation.markers.join(', ')}]`
    : '';

  return `- ${violation.file} -> ${violation.specifier}${markers}`;
};

const formatBoundaryReport = report => {
  const lines = [
    `[ultramodern-boundary] checked ${String(
      report.scannedFiles,
    )} upstream-owned packages/**/src files at ${report.baseRef}; target=${report.headRef ?? 'worktree'}`,
    `[ultramodern-boundary] current=${String(
      report.currentViolations.length,
    )} allowlist=${String(report.allowlistViolations.length)} added=${String(
      report.added.length,
    )} removed=${String(report.removed.length)}`,
  ];

  if (report.currentViolations.length > 0) {
    lines.push(
      '',
      'Current upstream-owned imports of fork-only code (allowances do not permit edges):',
      ...report.currentViolations.map(formatViolation),
    );
  }
  if (report.reviewedBridges?.length > 0)
    lines.push(
      '',
      `Reviewed compatibility bridges: ${report.reviewedBridges.length} exact edges.`,
    );

  if (report.removed.length > 0) {
    lines.push(
      '',
      'Allowlist entries no longer observed; shrink the snapshot when migrating:',
      ...report.removed.map(formatViolation),
    );
  }

  if (report.currentViolations.length === 0) {
    lines.push('', 'No current upstream-owned imports of fork-only code.');
  }

  return lines.join('\n');
};

module.exports = {
  ALLOWLIST_SCHEMA_VERSION,
  DEFAULT_ALLOWLIST_PATH,
  DEFAULT_BASE_REF,
  DEFAULT_DENYLIST,
  SOURCE_FILE_PATTERN,
  checkForkImportBoundary,
  createAllowlistSnapshot,
  diffViolations,
  findDenylistMatches,
  hasOnlyNativeRequestBindings,
  formatBoundaryReport,
  formatViolation,
  listPackageSourceFiles,
  listUpstreamOwnedPackageSourceFiles,
  isNativeCreateRequestPackage,
  readAllowlist,
  scanUpstreamOwnedForkImports,
  writeAllowlist,
};
