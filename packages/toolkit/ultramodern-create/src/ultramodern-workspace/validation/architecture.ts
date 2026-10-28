import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as ts from '@typescript/native/unstable/ast';
import type { API, Snapshot } from '@typescript/native/unstable/sync';
import { hasNativeAppGeneration } from '../renderer-generations';
import {
  getRendererGenerationProfile,
  isApplicationRenderer,
} from '../renderer-profile';
import { assert, sameJson, selfCheckFailure } from './assertions';
import {
  createNativeShellRuntimeEvidence,
  isBuildTargetAccess,
} from './native-shell-runtime';
import { isForeignRendererPackage } from './renderer';
import type { JsonRecord, ValidationContract } from './types';

export function assertCompilerArchitecture(
  root: string,
  workspaceValidationContract: ValidationContract,
): void {
  const fullStackVerticals = workspaceValidationContract.apps.filter(
    app => app.kind !== 'shell',
  );
  const tailwindEnabled = workspaceValidationContract.tailwindEnabled;
  const compactConfigPath = 'topology/reference-topology.json';
  const readJson = (relativePath: string): JsonRecord =>
    JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf-8'));
  // Compiler evidence belongs to the consumer's declared toolchain. Resolve only
  // from its package root; npm invocation environment and repository paths cannot
  // silently substitute another compiler.
  const workspaceRequire = createRequire(path.join(root, 'package.json'));
  let typescript!: typeof import('@typescript/native/unstable/ast');
  let typescriptApi:
    | typeof import('@typescript/native/unstable/sync')
    | undefined;
  try {
    typescript = workspaceRequire('@typescript/native/unstable/ast');
    typescriptApi = workspaceRequire('@typescript/native/unstable/sync');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND')
      throw error;
  }
  let compilerSnapshot: Snapshot | undefined;
  let compiler: API | undefined;
  try {
    const sourceExtensions = new Set([
      '.cjs',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.mts',
      '.ts',
      '.tsx',
    ]);
    const appDirectories = new Set(
      workspaceValidationContract.apps.map(app => path.join(root, app.path)),
    );
    // Build artifacts are not authored application source. Match these only at
    // package roots: src/build or src/dist can still contain application code.
    const generatedDirectories = new Set([
      'dist',
      'dist-cloudflare',
      'build',
      '.output',
      '.modern',
      '.modern-js',
      '.modernjs',
      '.mf',
    ]);
    const collectCompilerInputs = (relativeDirectory: string) => {
      const absoluteDirectory = path.join(root, relativeDirectory);
      if (!fs.existsSync(absoluteDirectory)) {
        return [];
      }
      const files = [];
      const queue = [absoluteDirectory];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const absoluteEntry = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (
              entry.name === 'node_modules' ||
              (appDirectories.has(current) &&
                generatedDirectories.has(entry.name))
            )
              continue;
            queue.push(absoluteEntry);
          } else if (sourceExtensions.has(path.extname(entry.name))) {
            files.push(absoluteEntry);
          }
        }
      }
      return files.toSorted();
    };
    const initializeCompilerSnapshot = (absolutePaths: Iterable<string>) => {
      if (typescript === undefined || typescriptApi === undefined) {
        return;
      }
      compiler = new typescriptApi.API({ cwd: root });
      compilerSnapshot = compiler.updateSnapshot({
        openFiles: [...absolutePaths],
      });
    };
    const compilerInput = (absolutePath: string) => {
      const project = compilerSnapshot?.getDefaultProjectForFile(absolutePath);
      const sourceFile = project?.program.getSourceFile(absolutePath);
      assert(
        project !== undefined && sourceFile !== undefined,
        `Native TypeScript compiler could not parse ${path.relative(root, absolutePath)}`,
      );
      return { checker: project.checker, sourceFile };
    };
    const parseCompilerInput = (absolutePath: string) =>
      compilerInput(absolutePath).sourceFile;
    const nodeName = (node: ts.Node | undefined) => {
      if (!node) return undefined;
      if (
        typescript.isIdentifier(node) ||
        typescript.isPrivateIdentifier(node) ||
        typescript.isStringLiteralLikeNode(node) ||
        typescript.isNumericLiteral(node)
      ) {
        return node.text;
      }
      return undefined;
    };
    const propertyAccessPath = (node: ts.Node): string[] | undefined => {
      if (typescript.isIdentifier(node)) {
        return [node.text];
      }
      if (typescript.isPropertyAccessExpression(node)) {
        const left = propertyAccessPath(node.expression);
        return left === undefined ? undefined : [...left, node.name.text];
      }
      if (
        typescript.isElementAccessExpression(node) &&
        typescript.isStringLiteralLikeNode(node.argumentExpression)
      ) {
        const left = propertyAccessPath(node.expression);
        return left === undefined
          ? undefined
          : [...left, node.argumentExpression.text];
      }
      return undefined;
    };
    function compilerFailure(
      sourceFile: ts.SourceFile,
      node: ts.Node,
      contract: string,
      diagnostic: string,
      fixArea: string,
    ): never {
      const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const relativePath = path
        .relative(root, sourceFile.fileName)
        .split(path.sep)
        .join('/');
      throw new Error(
        selfCheckFailure(
          contract,
          `${diagnostic} Compiler evidence: ${relativePath}:${position.line + 1}:${position.character + 1}`,
          fixArea,
        ),
      );
    }
    const runtimeModuleReferences = (sourceFile: ts.SourceFile) => {
      const references: Array<{
        kind: string;
        node: ts.Node;
        specifier: string;
      }> = [];
      const record = (
        node: ts.Node,
        specifier: string,
        kind: string,
        typeOnly = false,
      ) => {
        if (!typeOnly) {
          references.push({ kind, node, specifier });
        }
      };
      const visit = (node: ts.Node): void => {
        if (
          typescript.isImportDeclaration(node) &&
          typescript.isStringLiteralLikeNode(node.moduleSpecifier)
        ) {
          const importClause = node.importClause;
          const namedBindings = importClause?.namedBindings;
          const namedBindingsAreTypeOnly =
            namedBindings !== undefined &&
            typescript.isNamedImports(namedBindings) &&
            namedBindings.elements.length > 0 &&
            namedBindings.elements.every(element => element.isTypeOnly);
          record(
            node,
            node.moduleSpecifier.text,
            importClause === undefined ? 'side-effect-import' : 'static-import',
            importClause?.phaseModifier === typescript.SyntaxKind.TypeKeyword ||
              (importClause?.name === undefined && namedBindingsAreTypeOnly),
          );
        } else if (
          typescript.isExportDeclaration(node) &&
          node.moduleSpecifier !== undefined &&
          typescript.isStringLiteralLikeNode(node.moduleSpecifier)
        ) {
          record(
            node,
            node.moduleSpecifier.text,
            'static-import',
            node.isTypeOnly,
          );
        } else if (
          typescript.isCallExpression(node) &&
          node.arguments.length > 0 &&
          typescript.isStringLiteralLikeNode(node.arguments[0])
        ) {
          if (node.expression.kind === typescript.SyntaxKind.ImportKeyword) {
            record(node, node.arguments[0].text, 'dynamic-import');
          } else if (
            typescript.isIdentifier(node.expression) &&
            node.expression.text === 'require'
          ) {
            record(node, node.arguments[0].text, 'require');
          }
        }
        node.forEachChild(visit);
      };
      visit(sourceFile);
      return references;
    };
    const importDiagnosticId = (prefix: string, kind: string) => {
      switch (kind) {
        case 'side-effect-import':
          return `${prefix}-side-effect-import`;
        case 'dynamic-import':
          return `${prefix}-dynamic-import`;
        case 'require':
          return `${prefix}-require`;
        default:
          return prefix === 'vertical-directory'
            ? 'vertical-directory-deep-import'
            : 'workspace-package-source-import';
      }
    };
    const isWorkspaceSourceSpecifier = (specifier: string) => {
      const segments = specifier.split('/');
      return (
        segments.length > 3 &&
        segments[0].startsWith('@') &&
        segments[2] === 'src'
      );
    };
    const resolvesInsideVerticalDirectory = (
      sourceFile: ts.SourceFile,
      specifier: string,
    ) => {
      if (!specifier.startsWith('.')) {
        return false;
      }
      const specifierSegments = specifier.replaceAll('\\', '/').split('/');
      if (
        specifierSegments.some(
          (segment, index) =>
            segment === 'verticals' &&
            specifierSegments[index + 1] !== undefined,
        )
      ) {
        return true;
      }
      const absoluteTarget = path.resolve(
        path.dirname(sourceFile.fileName),
        specifier,
      );
      const verticalRoot = path.join(root, 'verticals') + path.sep;
      if (!absoluteTarget.startsWith(verticalRoot)) {
        return false;
      }
      const relativeSegments = path
        .relative(verticalRoot, absoluteTarget)
        .split(path.sep);
      return relativeSegments.length > 1;
    };
    const jsxTagName = (tagName: ts.JsxTagNameExpression) =>
      typescript.isIdentifier(tagName) ? tagName.text : undefined;
    const jsxAttribute = (attributes: ts.JsxAttributes, name: string) =>
      attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          typescript.isJsxAttribute(property) &&
          nodeName(property.name) === name,
      );
    const isBooleanLiteral = (node: ts.Node | undefined, value: boolean) =>
      node?.kind ===
      (value
        ? typescript.SyntaxKind.TrueKeyword
        : typescript.SyntaxKind.FalseKeyword);
    const isCallNamed = (
      node: ts.Node | undefined,
      names: Set<string>,
    ): node is ts.CallExpression => {
      if (node === undefined || !typescript.isCallExpression(node)) {
        return false;
      }
      const accessPath = propertyAccessPath(node.expression);
      return accessPath !== undefined && names.has(accessPath.at(-1)!);
    };
    // The called name whatever the receiver is, so `getInstance()!.loadRemote()`
    // is recognized as well as `host.loadRemote()`.
    const calleeName = (node: ts.CallExpression) => {
      let callee: ts.Node = node.expression;
      while (
        typescript.isParenthesizedExpression(callee) ||
        typescript.isNonNullExpression(callee) ||
        typescript.isAsExpression(callee)
      )
        callee = callee.expression;
      if (typescript.isIdentifier(callee)) return callee.text;
      if (typescript.isPropertyAccessExpression(callee))
        return callee.name.text;
      return undefined;
    };
    const objectLiteralProperty = (
      objectLiteral: ts.ObjectLiteralExpression,
      name: string,
    ) =>
      objectLiteral.properties.find(
        (property): property is ts.PropertyAssignment =>
          typescript.isPropertyAssignment(property) &&
          nodeName(property.name) === name,
      );
    const moduleFederationConfigArgument = (sourceFile: ts.SourceFile) => {
      let argument: ts.ObjectLiteralExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (argument !== undefined) {
          return;
        }
        if (
          typescript.isCallExpression(node) &&
          typescript.isIdentifier(node.expression) &&
          node.expression.text === 'createModuleFederationConfig' &&
          node.arguments.length === 1 &&
          typescript.isObjectLiteralExpression(node.arguments[0])
        ) {
          argument = node.arguments[0];
          return;
        }
        node.forEachChild(visit);
      };
      visit(sourceFile);
      return argument;
    };
    const appDeclaresReactRouter = (appPath: string) => {
      const relativePath = `${appPath}/package.json`;
      if (!fs.existsSync(path.join(root, relativePath))) {
        return false;
      }
      const packageJson = readJson(relativePath);
      return ['react-router', 'react-router-dom'].some(dependency =>
        ['dependencies', 'devDependencies'].some(field =>
          Object.hasOwn(packageJson[field] ?? {}, dependency),
        ),
      );
    };
    // TanStack Router is the frontend router of every generated workspace, and
    // `@module-federation/rspack` decides the bridge router purely from this flag
    // and `@module-federation/bridge-react` — it never inspects react-router. The
    // flag therefore has to mirror the app's own manifest: `false` (the router-free
    // bridge-react base entry) unless the app declares React Router itself.
    const bridgeRouterFixArea =
      'declare bridge.enableBridgeRouter: false, or true only in an app that declares react-router or react-router-dom';
    const assertBridgeRouterCapability = (
      sourceFile: ts.SourceFile,
      appPath: string,
    ) => {
      const contract = 'module federation bridge capability';
      const configArgument = moduleFederationConfigArgument(sourceFile);
      if (configArgument === undefined) {
        compilerFailure(
          sourceFile,
          sourceFile,
          contract,
          'Generated Module Federation must pass a literal config object to createModuleFederationConfig.',
          bridgeRouterFixArea,
        );
      }
      const bridge = objectLiteralProperty(configArgument, 'bridge');
      const declaration =
        bridge !== undefined &&
        typescript.isObjectLiteralExpression(bridge.initializer)
          ? objectLiteralProperty(bridge.initializer, 'enableBridgeRouter')
          : undefined;
      if (declaration === undefined) {
        compilerFailure(
          sourceFile,
          bridge ?? configArgument,
          contract,
          'Generated Module Federation must declare bridge.enableBridgeRouter in its config object.',
          bridgeRouterFixArea,
        );
      }
      if (isBooleanLiteral(declaration.initializer, false)) {
        return;
      }
      if (!isBooleanLiteral(declaration.initializer, true)) {
        compilerFailure(
          sourceFile,
          declaration,
          contract,
          'Generated Module Federation must declare bridge.enableBridgeRouter as a boolean literal.',
          bridgeRouterFixArea,
        );
      }
      if (!appDeclaresReactRouter(appPath)) {
        compilerFailure(
          sourceFile,
          declaration,
          contract,
          `Generated Module Federation enables the React bridge router while ${appPath}/package.json declares neither react-router nor react-router-dom.`,
          bridgeRouterFixArea,
        );
      }
    };
    const checkArchitecture = () => {
      const structuralPolicy =
        workspaceValidationContract.structuralShellPolicy;
      assert(
        structuralPolicy?.schemaVersion === 1,
        'Structural thin-shell compiler policy must use schemaVersion 1',
      );
      const compositionPolicy =
        workspaceValidationContract.federatedCompositionPolicy;
      assert(
        compositionPolicy?.schemaVersion === 1,
        'Federated composition compiler policy must use schemaVersion 1',
      );
      const compilerInputs = new Set([
        ...(structuralPolicy.shells ?? []).flatMap((shell: JsonRecord) =>
          collectCompilerInputs(shell.srcDir),
        ),
        ...(compositionPolicy.hosts ?? []).flatMap(host =>
          collectCompilerInputs(host.srcDir),
        ),
        ...workspaceValidationContract.apps.flatMap(app =>
          collectCompilerInputs(app.path),
        ),
      ]);
      initializeCompilerSnapshot(compilerInputs);
      if (compilerSnapshot !== undefined) {
        for (const absolutePath of compilerInputs) {
          const selectedApp = workspaceValidationContract.apps.find(app =>
            absolutePath.startsWith(path.join(root, app.path) + path.sep),
          );
          if (!selectedApp?.renderer || selectedApp.renderer === 'react')
            continue;
          const sourceFile = parseCompilerInput(absolutePath);
          for (const reference of runtimeModuleReferences(sourceFile)) {
            if (
              isForeignRendererPackage(
                reference.specifier,
                selectedApp.renderer,
              )
            ) {
              compilerFailure(
                sourceFile,
                reference.node,
                'renderer source profile',
                `Application ${selectedApp.id} imports foreign renderer module ${reference.specifier}.`,
                'use the selected renderer native runtime and router',
              );
            }
          }
        }
      }
      for (const shell of structuralPolicy.shells ?? []) {
        for (const forbidden of structuralPolicy.forbiddenPathClasses ?? []) {
          // The platform shell can host its own authentication and BFF routes.
          if (
            shell.id === 'shell-super-app' &&
            forbidden.path !== 'backend-federation.config.ts'
          ) {
            continue;
          }
          assert(
            !fs.existsSync(path.join(root, shell.packageDir, forbidden.path)),
            selfCheckFailure(
              `structural thin-shell ${forbidden.id}`,
              `${forbidden.diagnostic} Forbidden artifact ${shell.packageDir}/${forbidden.path} exists`,
              `remove forbidden thin-shell artifact ${shell.packageDir}/${forbidden.path}`,
            ),
          );
        }
        if (compilerSnapshot === undefined) {
          continue;
        }
        for (const absolutePath of collectCompilerInputs(shell.srcDir)) {
          const sourceFile = parseCompilerInput(absolutePath);
          for (const reference of runtimeModuleReferences(sourceFile)) {
            if (
              resolvesInsideVerticalDirectory(sourceFile, reference.specifier)
            ) {
              const id = importDiagnosticId(
                'vertical-directory',
                reference.kind,
              );
              compilerFailure(
                sourceFile,
                reference.node,
                `structural thin-shell ${id}`,
                'A thin Shell must consume only published vertical surfaces, never a vertical implementation directory.',
                'consume only published surfaces from the thin shell',
              );
            }
            if (isWorkspaceSourceSpecifier(reference.specifier)) {
              const id = importDiagnosticId(
                'workspace-package',
                reference.kind,
              );
              compilerFailure(
                sourceFile,
                reference.node,
                `structural thin-shell ${id}`,
                'A thin Shell must consume only package exports, never another package raw src directory.',
                'consume only published surfaces from the thin shell',
              );
            }
          }
        }
      }

      if (compilerSnapshot === undefined) {
        const packageJson = readJson('package.json');
        assert(
          typeof packageJson.devDependencies?.['@typescript/native'] ===
            'string',
          'Generated workspaces must declare the native TypeScript compiler used by architecture evidence',
        );
        assert(
          packageJson.scripts?.check
            ?.split('&&')
            .some((stage: string) => stage.trim() === 'pnpm typecheck'),
          'Generated workspace check must execute compiler evidence before contract validation',
        );
        return;
      }

      for (const host of compositionPolicy.hosts ?? []) {
        for (const absolutePath of collectCompilerInputs(host.srcDir)) {
          const sourceFile = parseCompilerInput(absolutePath);
          if (sourceFile.isDeclarationFile) {
            continue;
          }
          const remoteImplementation = (specifier: string) =>
            (host.remotes ?? []).find(remote => {
              if (specifier === remote.packageName) {
                return true;
              }
              if (specifier.startsWith(`${remote.packageName}/`)) {
                const subpath = specifier.slice(remote.packageName.length + 1);
                return subpath !== 'api' && !subpath.startsWith('api/');
              }
              if (!specifier.startsWith('.')) {
                return false;
              }
              const absoluteTarget = path.resolve(
                path.dirname(sourceFile.fileName),
                specifier,
              );
              const remoteDirectory = path.join(root, remote.directory);
              return (
                absoluteTarget === remoteDirectory ||
                absoluteTarget.startsWith(remoteDirectory + path.sep)
              );
            });
          for (const reference of runtimeModuleReferences(sourceFile)) {
            const remote = remoteImplementation(reference.specifier);
            if (remote !== undefined) {
              compilerFailure(
                sourceFile,
                reference.node,
                'federated composition remote-runtime-package-import',
                `Host ${host.id} imports the ${remote.id} render implementation through ${reference.specifier}.`,
                'use import type for contracts or compose the implementation through Module Federation',
              );
            }
          }

          const hydrationStateSetters = new Set();
          const visit = (node: ts.Node): void => {
            if (
              typescript.isVariableDeclaration(node) &&
              typescript.isArrayBindingPattern(node.name) &&
              node.name.elements.length >= 2 &&
              isCallNamed(node.initializer, new Set(['useState'])) &&
              isBooleanLiteral(node.initializer.arguments[0], false)
            ) {
              const stateName = nodeName(
                node.name.elements[0].name,
              )?.toLowerCase();
              const setterName = nodeName(node.name.elements[1].name);
              if (
                (stateName === 'hydrated' || stateName === 'ishydrated') &&
                setterName !== undefined
              ) {
                hydrationStateSetters.add(setterName);
              }
            }
            if (
              (typescript.isVariableDeclaration(node) ||
                typescript.isFunctionDeclaration(node)) &&
              nodeName(node.name) === 'createHydratedRemote'
            ) {
              compilerFailure(
                sourceFile,
                node,
                'federated composition hydrated-remote-factory',
                'Federated hosts must use the distributed SSR boundary directly; hydration-time remote factories are forbidden.',
                'compose remote rendering through framework Module Federation primitives',
              );
            }
            if (
              (typescript.isPropertyAssignment(node) ||
                typescript.isJsxAttribute(node)) &&
              (nodeName(node.name) === 'loading' ||
                nodeName(node.name) === 'fallback')
            ) {
              const value = typescript.isPropertyAssignment(node)
                ? node.initializer
                : node.initializer !== undefined &&
                    typescript.isJsxExpression(node.initializer)
                  ? node.initializer.expression
                  : undefined;
              if (
                value !== undefined &&
                (typescript.isJsxElement(value) ||
                  typescript.isJsxSelfClosingElement(value))
              ) {
                const tagName = typescript.isJsxElement(value)
                  ? jsxTagName(value.openingElement.tagName)
                  : jsxTagName(value.tagName);
                if (
                  tagName === 'ServerComponent' ||
                  tagName === 'LocalComponent'
                ) {
                  compilerFailure(
                    sourceFile,
                    node,
                    'federated composition local-loading-copy',
                    'Federated hosts must not render a local component copy while loading a remote implementation.',
                    'use an explicit unavailable-state component instead of a local implementation copy',
                  );
                }
              }
            }
            node.forEachChild(visit);
          };
          visit(sourceFile);
          if (hydrationStateSetters.size > 0) {
            const findHydrationSetter = (node: ts.Node): void => {
              if (
                typescript.isCallExpression(node) &&
                typescript.isIdentifier(node.expression) &&
                hydrationStateSetters.has(node.expression.text) &&
                isBooleanLiteral(node.arguments[0], true)
              ) {
                compilerFailure(
                  sourceFile,
                  node,
                  'federated composition hydration-flag',
                  'Federated hosts must hydrate the server DOM directly; hydrated-state component switching is forbidden.',
                  'compose remote rendering through framework Module Federation primitives',
                );
              }
              node.forEachChild(findHydrationSetter);
            };
            findHydrationSetter(sourceFile);
          }
        }
      }

      const shellRouteDirectories = (structuralPolicy.shells ?? []).map(
        (shell: JsonRecord) => `${shell.packageDir}/src/routes`,
      );
      const appPaths: string[] = workspaceValidationContract.apps.map(
        app => app.path,
      );
      const configFiles = appPaths.flatMap(appPath => [
        `${appPath}/modern.config.ts`,
        `${appPath}/module-federation.config.ts`,
      ]);
      const moduleFederationConfigAppPaths = new Map(
        appPaths
          .map(
            appPath =>
              [
                path.join(root, `${appPath}/module-federation.config.ts`),
                appPath,
              ] as const,
          )
          .filter((entry: JsonRecord) => fs.existsSync(entry[0])),
      );
      const nativeModuleFederationApps = new Map(
        workspaceValidationContract.apps.flatMap(app => {
          if (
            !isApplicationRenderer(app.renderer) ||
            !hasNativeAppGeneration(app.renderer)
          )
            return [];
          return [
            [app.path, getRendererGenerationProfile(app.renderer)] as const,
          ];
        }),
      );
      const checkedFiles = new Set([
        ...shellRouteDirectories.flatMap(collectCompilerInputs),
        ...configFiles
          .map(relativePath => path.join(root, relativePath))
          .filter(absolutePath => fs.existsSync(absolutePath)),
      ]);
      for (const absolutePath of checkedFiles) {
        const { checker, sourceFile } = compilerInput(absolutePath);
        const isShellRoute = shellRouteDirectories.some(relativeDirectory => {
          const absoluteDirectory = path.join(root, relativeDirectory);
          return absolutePath.startsWith(absoluteDirectory + path.sep);
        });
        // Shell routes are bundled application source, where the framework
        // defines the build target; config files run in Node and have none.
        const shellRuntime = isShellRoute
          ? createNativeShellRuntimeEvidence(
              typescript,
              typescriptApi!,
              checker,
              sourceFile,
            )
          : undefined;
        const moduleFederationAppPath =
          moduleFederationConfigAppPaths.get(absolutePath);
        const nativeFederation =
          moduleFederationAppPath === undefined
            ? undefined
            : nativeModuleFederationApps.get(moduleFederationAppPath);
        const tailwindFactories = new Set<string>();
        const presetFactories = new Set<string>();
        const nativeRemoteLoaders = new Set<string>();
        const nativeBridgeFactories = new Set<string>();
        const nativeLoaderCalls = new Set<ts.Node>();
        for (const statement of sourceFile.statements) {
          if (
            !typescript.isImportDeclaration(statement) ||
            !typescript.isStringLiteralLikeNode(statement.moduleSpecifier) ||
            statement.importClause?.phaseModifier ===
              typescript.SyntaxKind.TypeKeyword
          )
            continue;
          const bindings = statement.importClause?.namedBindings;
          if (bindings === undefined || !typescript.isNamedImports(bindings))
            continue;
          for (const binding of bindings.elements) {
            if (binding.isTypeOnly) continue;
            const imported = (binding.propertyName ?? binding.name).text;
            if (
              statement.moduleSpecifier.text ===
                '@module-federation/modern-js-v3/runtime' &&
              imported === 'loadRemote'
            )
              nativeRemoteLoaders.add(binding.name.text);
            if (
              statement.moduleSpecifier.text ===
                '@module-federation/modern-js-v3/react' &&
              imported === 'createLazyComponent'
            )
              nativeBridgeFactories.add(binding.name.text);

            if (
              statement.moduleSpecifier.text ===
                '@rsbuild/plugin-tailwindcss' &&
              imported === 'pluginTailwindcss'
            )
              tailwindFactories.add(binding.name.text);
            if (
              statement.moduleSpecifier.text ===
                '@modern-js/ultramodern-app-tools' &&
              ['presetUltramodern', 'presetUltramodernWorkspace'].includes(
                imported,
              )
            )
              presetFactories.add(binding.name.text);
          }
        }
        const manualLoadingCallees = new Set([
          'hydrateRoot',
          'loadRemote',
          'loadShare',
          ...nativeRemoteLoaders,
        ]);
        const modernConfigApp = workspaceValidationContract.apps.find(
          app => absolutePath === path.join(root, app.path, 'modern.config.ts'),
        );
        let insideDefaultExport = false;
        const visit = (node: ts.Node): void => {
          if (
            isCallNamed(node, nativeBridgeFactories) &&
            typescript.isIdentifier(node.expression)
          ) {
            const options = node.arguments[0];
            if (
              options !== undefined &&
              typescript.isObjectLiteralExpression(options)
            ) {
              const loader = objectLiteralProperty(
                options,
                'loader',
              )?.initializer;
              if (
                loader !== undefined &&
                typescript.isArrowFunction(loader) &&
                loader.parameters.length === 0
              ) {
                let body: ts.Node = loader.body;
                while (
                  typescript.isAsExpression(body) ||
                  typescript.isParenthesizedExpression(body)
                )
                  body = body.expression;
                if (
                  isCallNamed(body, nativeRemoteLoaders) &&
                  typescript.isIdentifier(body.expression)
                )
                  nativeLoaderCalls.add(body);
              }
            }
          }
          const previousDefaultExport = insideDefaultExport;
          if (typescript.isExportAssignment(node) && !node.isExportEquals) {
            insideDefaultExport = true;
          }
          if (
            insideDefaultExport &&
            modernConfigApp !== undefined &&
            isCallNamed(node, presetFactories) &&
            node.arguments[0] !== undefined &&
            typescript.isObjectLiteralExpression(node.arguments[0])
          ) {
            const builderPlugins = objectLiteralProperty(
              node.arguments[0],
              'builderPlugins',
            );
            const usesTailwind =
              builderPlugins !== undefined &&
              typescript.isArrayLiteralExpression(builderPlugins.initializer) &&
              builderPlugins.initializer.elements.some(plugin =>
                isCallNamed(plugin, tailwindFactories),
              );
            const emitsUi =
              modernConfigApp.kind === 'shell' ||
              fullStackVerticals.some(
                vertical =>
                  vertical.id === modernConfigApp.id && vertical.emitsUi,
              );
            if (usesTailwind !== (tailwindEnabled && emitsUi)) {
              compilerFailure(
                sourceFile,
                builderPlugins ?? node,
                `${compactConfigPath} policy.features.tailwind`,
                `Tailwind feature flag is ${tailwindEnabled}, but ${modernConfigApp.id} exported config ${usesTailwind ? 'enables' : 'does not enable'} the Tailwind builder plugin.`,
                'keep the Tailwind feature flag and active app builder configuration consistent',
              );
            }
          }
          if (
            typescript.isImportDeclaration(node) &&
            typescript.isStringLiteralLikeNode(node.moduleSpecifier) &&
            node.moduleSpecifier.text === 'node:child_process'
          ) {
            compilerFailure(
              sourceFile,
              node,
              'framework config API node-child-process-access',
              'Generated config must not invoke node:child_process directly.',
              'use the framework config environment API',
            );
          }
          const accessPath = propertyAccessPath(node);
          if (sameJson(accessPath, ['process', 'env'])) {
            compilerFailure(
              sourceFile,
              node,
              'framework config API direct-process-env-access',
              isShellRoute
                ? 'Shell routes must not read process.env.'
                : 'Generated config must use the framework config environment API instead of process.env.',
              isShellRoute
                ? 'branch on import.meta.env.MODERN_TARGET for the build target'
                : 'use getBuildConfigEnvironment',
            );
          }
          if (!isShellRoute && isBuildTargetAccess(typescript, node)) {
            compilerFailure(
              sourceFile,
              node,
              'framework config API build-target-outside-bundle',
              'Config runs in Node, where the framework defines no import.meta.env.MODERN_TARGET.',
              'use getBuildConfigEnvironment',
            );
          }
          if (
            typescript.isIdentifier(node) &&
            node.text === 'ULTRAMODERN_ZEPHYR'
          ) {
            compilerFailure(
              sourceFile,
              node,
              'zephyr gating ultramodern-zephyr-environment-gate',
              'Generated Zephyr integration must not be gated through ULTRAMODERN_ZEPHYR.',
              'use Zephyr native deploy-token behavior',
            );
          }
          if (
            typescript.isPropertyAssignment(node) ||
            typescript.isShorthandPropertyAssignment(node)
          ) {
            const property = nodeName(node.name);
            if (
              // Inside a Module Federation config the flag is required evidence
              // checked positionally after this walk; anywhere else it is a
              // deviation, whatever it is set to.
              (property === 'enableBridgeRouter' &&
                (moduleFederationAppPath === undefined ||
                  nativeFederation !== undefined)) ||
              (property === 'disableDynamicRemoteTypeHints' &&
                typescript.isPropertyAssignment(node) &&
                isBooleanLiteral(node.initializer, true)) ||
              property === 'treeShakingSharedExcludePlugins'
            ) {
              compilerFailure(
                sourceFile,
                node,
                'module federation bridge capability',
                `Generated Module Federation carries forbidden option ${property}.`,
                'use framework-owned Module Federation defaults',
              );
            }
          }
          if (isShellRoute) {
            if (
              typescript.isJsxOpeningElement(node) &&
              jsxTagName(node.tagName) === 'a' &&
              jsxAttribute(node.attributes, 'onClick') !== undefined
            ) {
              compilerFailure(
                sourceFile,
                node,
                'shell routing synthetic-anchor-click-interception',
                'Shell routing must not intercept anchor clicks synthetically.',
                'use the router Link primitive',
              );
            }
            if (
              typescript.isCallExpression(node) &&
              manualLoadingCallees.has(calleeName(node) ?? '') &&
              !nativeLoaderCalls.has(node) &&
              !shellRuntime?.isBrowserFederationMemberLoad(node)
            ) {
              compilerFailure(
                sourceFile,
                node,
                'module federation native loading',
                'Shell routing must use framework Module Federation loading primitives.',
                'remove manual hydration or remote-loading wrappers',
              );
            }
            if (
              (typescript.isBinaryExpression(node) &&
                node.operatorToken.kind === typescript.SyntaxKind.EqualsToken &&
                propertyAccessPath(node.left)?.slice(0, 2).join('.') ===
                  'window.location') ||
              (typescript.isCallExpression(node) &&
                propertyAccessPath(node.expression)?.slice(0, 2).join('.') ===
                  'window.location')
            ) {
              compilerFailure(
                sourceFile,
                node,
                'shell routing window-location-navigation',
                'Shell routing must use router navigation instead of window.location.',
                'use the router navigation primitive',
              );
            }
          }
          node.forEachChild(visit);
          insideDefaultExport = previousDefaultExport;
        };
        visit(sourceFile);
        if (moduleFederationAppPath !== undefined) {
          if (nativeFederation) {
            if (!nativeFederation.capabilities.federation) {
              compilerFailure(
                sourceFile,
                sourceFile,
                'native module federation capability',
                `Application ${moduleFederationAppPath} has no admitted native Module Federation template.`,
                'use the selected renderer admitted Module Federation capability',
              );
            }
            if (
              !sourceFile.statements.some(
                statement =>
                  typescript.isExportAssignment(statement) &&
                  !statement.isExportEquals &&
                  typescript.isObjectLiteralExpression(statement.expression),
              )
            ) {
              compilerFailure(
                sourceFile,
                sourceFile,
                'native module federation config',
                'Generated native Module Federation must export a literal configuration object.',
                'use the selected renderer native Module Federation template',
              );
            }
          } else {
            assertBridgeRouterCapability(sourceFile, moduleFederationAppPath);
          }
        }
      }
    };
    checkArchitecture();
  } finally {
    compiler?.close();
  }
}
