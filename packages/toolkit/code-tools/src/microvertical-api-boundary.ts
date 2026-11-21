import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import {
  camelCaseStem,
  type MicroVerticalApiBaselineExpectation,
  microVerticalApiBaselineViolation,
  pascalCaseStem,
} from './microvertical-api-baseline';
import {
  baselinePackage,
  resolveBaselinePackageDirectory,
} from './microvertical-api-owner';
import {
  createModuleGraph,
  type GraphValue,
  type ModuleGraph,
  type ResolvedBinding,
  type SourceModule,
} from './module-graph';
import {
  consumerParserPlugins,
  SourceSyntaxError,
  unwrapExpression,
} from './source-analysis';
import {
  createEffectApiImportResolver,
  strictEffectRuntimeTopologyViolation,
} from './strict-effect-runtime';

export type {
  MicroVerticalApiBaselineExpectation,
  MicroVerticalTopologyEntry,
} from './microvertical-api-baseline';
export {
  configuredMicroVerticalApiStem,
  microVerticalApiBaselineViolation,
} from './microvertical-api-baseline';
export type {
  GraphValue,
  ModuleGraph,
  ModuleGraphHop,
  ResolvedBinding,
  SourceModule,
} from './module-graph';
export { createModuleGraph } from './module-graph';

export interface MicroVerticalConfiguredApp {
  readonly path: string;
  readonly id?: string;
  /** `shell` or `vertical`; selects the rules the app is checked against. */
  readonly kind: string;
  readonly package?: string;
  readonly surfaceProfile?: string;
  readonly deliveryUnitKind?: string;
  readonly api?: {
    readonly stem?: string;
    readonly prefix?: string;
    readonly protocol?: 'rest' | 'rpc';
    readonly operationPaths?: Readonly<Record<string, string>>;
    readonly additionalPaths?: Readonly<Record<string, string>>;
  };
}
export interface MicroVerticalApiSourceRuleContext {
  /** Workspace-relative path of `module`. */
  readonly file: string;
  readonly module: SourceModule;
  /** One graph per source file, shared by every rule for that file. */
  readonly graph: ModuleGraph;
}
/** A consumer-owned source rule; each returned message is a violation. */
export type MicroVerticalApiSourceRule = (
  context: MicroVerticalApiSourceRuleContext,
) => readonly string[];
export interface MicroVerticalApiCheckOptions {
  readonly workspaceRoot: string;
  readonly configuredApps?: readonly MicroVerticalConfiguredApp[];
  /** Exact installed owner constraint; otherwise resolve each contract’s native owner. */
  readonly baselinePackageDirectory?: string;
  /** Rules run once per workspace TypeScript/JavaScript source file. */
  readonly sourceRules?: readonly MicroVerticalApiSourceRule[];
}
export interface MicroVerticalApiCheckResult {
  readonly diagnostics: readonly string[];
  readonly toolErrors: readonly string[];
  readonly topologyFilesAnalyzed: number;
}
const ignored = new Set([
  '.git',
  '.modern',
  '.modernjs',
  '.output',
  'coverage',
  'dist',
  'node_modules',
  'repos',
]);
const MAX_CLOSURE_DEPTH = 128;
const MAX_CLOSURE_MODULES = 2048;
/** Alias hops and builder nesting followed when proving an HttpApi. */
const MAX_API_HOPS = 128;
/** Builder calls visited when proving one client's HttpApi arguments. */
const MAX_API_VISITS = 2048;
/** Modules whose `identity` makes `api.pipe(identity)` the same API. */
const identitySources = ['effect', 'effect/Function'];
const normalize = (file: string) =>
  file.split(path.sep).join('/').replace(/^\.\//u, '');
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const unconstrainedSchemaMembers = new Set([
  'Any',
  'Unknown',
  'UnknownFromJsonString',
]);
/**
 * The unconstrained `Schema` member a value-space node reads. Type positions
 * (`typeof Schema.Unknown.Type`) parse as `TSQualifiedName`, never as these.
 */
const runtimeSchemaMember = (node: t.Node): string | undefined => {
  let member: string | undefined;
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    t.isIdentifier(node.object, { name: 'Schema' })
  ) {
    const { property } = node;
    member = !node.computed
      ? t.isIdentifier(property)
        ? property.name
        : undefined
      : t.isStringLiteral(property)
        ? property.value
        : t.isTemplateLiteral(property) && property.expressions.length === 0
          ? (property.quasis[0]?.value.cooked ?? undefined)
          : undefined;
  } else if (
    t.isJSXMemberExpression(node) &&
    t.isJSXIdentifier(node.object, { name: 'Schema' })
  ) {
    member = node.property.name;
  } else if (
    t.isTSImportEqualsDeclaration(node) &&
    node.importKind !== 'type'
  ) {
    // `import Loose = Schema.Any` is a value alias of the member.
    let reference: t.Node = node.moduleReference;
    while (t.isTSQualifiedName(reference) && !t.isIdentifier(reference.left))
      reference = reference.left;
    member =
      t.isTSQualifiedName(reference) &&
      t.isIdentifier(reference.left, { name: 'Schema' })
        ? reference.right.name
        : undefined;
  }
  return member !== undefined && unconstrainedSchemaMembers.has(member)
    ? member
    : undefined;
};
const apiApp = (app: MicroVerticalConfiguredApp) =>
  app.kind === 'vertical' &&
  app.surfaceProfile !== 'ui-only' &&
  app.deliveryUnitKind !== 'horizontal-remote';

interface ReferenceTopologyApp {
  readonly id?: string;
  readonly kind?: string;
  readonly path?: string;
  readonly package?: string;
  readonly surfaceProfile?: string;
  readonly deliveryUnitKind?: string;
  readonly api?: {
    readonly stem?: string;
    readonly protocol?: 'rest' | 'rpc';
    readonly bff?: { readonly prefix?: string };
    readonly readiness?: { readonly endpoint?: string };
  };
}

interface ReferenceTopology {
  readonly shell?: ReferenceTopologyApp;
  readonly shells?: readonly ReferenceTopologyApp[];
  readonly verticals?: readonly ReferenceTopologyApp[];
}

function configuredApps(
  root: string,
  supplied?: readonly MicroVerticalConfiguredApp[],
): readonly MicroVerticalConfiguredApp[] {
  const topology: ReferenceTopology | undefined = supplied
    ? undefined
    : JSON.parse(
        fs.readFileSync(
          path.join(root, 'topology/reference-topology.json'),
          'utf8',
        ),
      );
  if (
    topology &&
    (!topology.shell ||
      !Array.isArray(topology.verticals) ||
      (topology.shells !== undefined && !Array.isArray(topology.shells)))
  )
    throw new Error(
      'topology/reference-topology.json: shell and verticals must be present',
    );
  const entries = topology?.shell
    ? [
        topology.shell,
        ...(topology.shells ?? []),
        ...(topology.verticals ?? []),
      ]
    : undefined;
  const source: readonly MicroVerticalConfiguredApp[] | undefined =
    supplied ??
    entries?.map(entry => {
      if (
        !entry ||
        typeof entry.path !== 'string' ||
        !entry.path ||
        path.isAbsolute(entry.path) ||
        entry.path.split(/[\\/]/u).includes('..')
      )
        throw new Error(
          'topology/reference-topology.json: each app must have an explicit workspace path',
        );
      const packageFile = path.join(root, entry.path, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (
        typeof manifest.name !== 'string' ||
        !manifest.name ||
        (entry.package !== undefined && entry.package !== manifest.name)
      )
        throw new Error(
          `${entry.path}/package.json: package name must match topology`,
        );
      const api = entry.api;
      const stem =
        api?.stem ??
        api?.readiness?.endpoint?.match(
          /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/readiness$/u,
        )?.[1];
      return {
        id: entry.id,
        kind: entry.kind as string,
        path: entry.path,
        package: manifest.name,
        surfaceProfile: entry.surfaceProfile,
        deliveryUnitKind: entry.deliveryUnitKind,
        ...(api === undefined
          ? {}
          : {
              api: {
                stem,
                prefix: api.bff?.prefix,
                protocol: api.protocol,
              },
            }),
      };
    });
  if (!Array.isArray(source))
    throw new Error(
      'topology/reference-topology.json: shell and verticals must describe apps',
    );
  const paths = new Set<string>();
  for (const app of source) {
    if (
      !app ||
      typeof app !== 'object' ||
      typeof app.path !== 'string' ||
      !app.path ||
      path.isAbsolute(app.path) ||
      app.path.split(/[\\/]/u).includes('..')
    )
      throw new Error(
        'topology/reference-topology.json: each app must have a relative workspace path',
      );
    const key = normalize(app.path);
    if (paths.has(key))
      throw new Error(
        `topology/reference-topology.json: duplicate app path ${key}`,
      );
    paths.add(key);
    for (const name of [
      'id',
      'kind',
      'package',
      'surfaceProfile',
      'deliveryUnitKind',
    ] as const)
      if (app[name] !== undefined && typeof app[name] !== 'string')
        throw new Error(`${key}: ${name} must be a string`);
    const allowedFields = {
      kind: ['shell', 'vertical'],
      surfaceProfile: ['full-stack', 'api-only', 'ui-only'],
      deliveryUnitKind: ['microvertical', 'horizontal-remote'],
    } as const;
    for (const field of Object.keys(
      allowedFields,
    ) as (keyof typeof allowedFields)[]) {
      const value = app[field];
      if (
        (value !== undefined || field === 'kind') &&
        (typeof value !== 'string' ||
          !(allowedFields[field] as readonly string[]).includes(value))
      )
        throw new Error(`${key}: invalid ${field}`);
    }
    if (app.api !== undefined) {
      if (!app.api || typeof app.api !== 'object' || Array.isArray(app.api))
        throw new Error(`${key}: api must be an object`);
      if (
        app.api.protocol !== undefined &&
        !['rest', 'rpc'].includes(app.api.protocol)
      )
        throw new Error(`${key}: api.protocol must be rest or rpc`);
      if (
        app.api.stem !== undefined &&
        (typeof app.api.stem !== 'string' ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(app.api.stem))
      )
        throw new Error(`${key}: invalid api.stem`);
      if (
        app.api.prefix !== undefined &&
        (typeof app.api.prefix !== 'string' ||
          !/^\/[^\s?#]*$/u.test(app.api.prefix))
      )
        throw new Error(`${key}: invalid api.prefix`);
      for (const field of ['additionalPaths', 'operationPaths'] as const) {
        const value = app.api[field];
        if (
          value !== undefined &&
          (!value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.values(value).some(entry => typeof entry !== 'string'))
        )
          throw new Error(`${key}: api.${field} must map names to paths`);
      }
    }
  }
  return source;
}

function check(
  options: MicroVerticalApiCheckOptions,
  topology: boolean,
): MicroVerticalApiCheckResult {
  const diagnostics: string[] = [];
  const toolErrors: string[] = [];
  let topologyFilesAnalyzed = 0;
  const root = path.resolve(options.workspaceRoot);
  const absolute = (file: string) => path.join(root, file);
  const exists = (file: string) => fs.existsSync(absolute(file));
  const read = (file: string) => fs.readFileSync(absolute(file), 'utf8');
  const assert = (value: unknown, message: string) => {
    if (!value) diagnostics.push(message);
  };
  const noPath = (file: string, reason: string) =>
    assert(!exists(file), `${file}: ${reason}`);
  const guarded = (file: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      toolErrors.push(`${file}: ${errorMessage(error)}`);
    }
  };
  try {
    const apps = configuredApps(root, options.configuredApps);
    const workspace = fs.realpathSync(root);
    /** Workspace-relative path of a real file, so symlinked spellings agree. */
    const realRelative = (file: string) =>
      normalize(path.relative(workspace, fs.realpathSync(absolute(file))));
    const inside = (directory: string, real: string) =>
      real.startsWith(`${directory}${path.sep}`);
    const byPath = new Map(apps.map(app => [normalize(app.path), app]));
    const directories = (base: string) =>
      exists(base)
        ? fs
            .readdirSync(absolute(base), { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !ignored.has(entry.name))
            .map(entry => `${base}/${entry.name}`)
        : [];
    const walk = (directory: string): string[] =>
      exists(directory)
        ? fs
            .readdirSync(absolute(directory), { withFileTypes: true })
            .flatMap(entry => {
              if (
                ignored.has(entry.name) ||
                (entry.name === 'dist-cloudflare' && byPath.has(directory))
              )
                return [];
              const file = `${directory}/${entry.name}`;
              return entry.isDirectory()
                ? walk(file)
                : entry.isFile()
                  ? [file]
                  : [];
            })
        : [];
    const parsed = new Map<string, t.File | undefined>();
    const parseFile = (file: string): t.File | undefined => {
      if (parsed.has(file)) return parsed.get(file);
      if (fs.statSync(absolute(file)).size > 1_000_000)
        throw new Error('consumer source exceeds 1 MB analysis budget');
      try {
        const ast = parse(read(file), {
          sourceType: 'module',
          sourceFilename: file,
          plugins: consumerParserPlugins(file),
        });
        parsed.set(file, ast);
        return ast;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'BABEL_PARSER_SYNTAX_ERROR'
        ) {
          diagnostics.push(
            `${file}: invalid source syntax (${errorMessage(error)})`,
          );
          parsed.set(file, undefined);
          return undefined;
        }
        throw error;
      }
    };
    /**
     * Real workspace-relative target of a relative specifier, with TS
     * extension rules. Two spellings of one file resolve to one path.
     */
    const resolveRelative = (
      fromFile: string,
      specifier: string,
    ): string | undefined => {
      if (!/^\.\.?\//u.test(specifier)) return undefined;
      const base = path.posix
        .join(path.posix.dirname(fromFile), specifier)
        .replace(/\.(?:[cm]?[jt]sx?)$/u, '');
      const candidate = [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ].find(file => exists(file));
      return candidate === undefined ? undefined : realRelative(candidate);
    };
    /** Follow identifier and member aliases to the binding they finally name. */
    const graphBinding = (
      graph: ModuleGraph,
      module: SourceModule,
      expression: t.Node,
      seen = new Set<t.Node>(),
    ): ResolvedBinding | undefined => {
      if (seen.has(expression) || seen.size >= 128) return undefined;
      seen.add(expression);
      const binding =
        t.isIdentifier(expression) || t.isMemberExpression(expression)
          ? graph.resolveReference(module, expression)
          : undefined;
      return binding?.kind === 'declaration' &&
        (t.isIdentifier(binding.expression) ||
          t.isMemberExpression(binding.expression))
        ? graphBinding(graph, binding.module, binding.expression, seen)
        : binding;
    };
    const clientExportFile = (
      appPath: string,
      exported: unknown,
    ): string | undefined => {
      if (
        typeof exported !== 'string' ||
        !exported.startsWith('./') ||
        exported.split(/[\\/]/u).includes('..') ||
        !/\.[cm]?[jt]sx?$/u.test(exported)
      )
        return undefined;
      const appDirectory = absolute(appPath);
      const candidate = path.resolve(appDirectory, exported);
      try {
        const workspace = fs.realpathSync(root);
        const owner = fs.realpathSync(appDirectory);
        const real = fs.realpathSync(candidate);
        if (
          !owner.startsWith(`${workspace}${path.sep}`) ||
          !real.startsWith(`${owner}${path.sep}`) ||
          !fs.statSync(real).isFile()
        )
          return undefined;
      } catch {
        return undefined;
      }
      return normalize(path.relative(root, candidate));
    };
    /**
     * A module plus everything it pulls in at runtime through relative
     * imports, re-exports, `import()` and `require()`. A consumer may split
     * one governed surface across sibling modules; the surface is still the
     * union of what they import and call. The closure fails closed: an
     * unresolved or computed dependency, a dependency outside the owning app,
     * or a closure beyond the analysis budget is a tool error, never a
     * smaller surface. Type-only imports and re-exports are not followed.
     */
    const composedModules = (file: string, appPath: string): string[] => {
      const owner = fs.realpathSync(absolute(appPath));
      if (!inside(owner, fs.realpathSync(absolute(file))))
        throw new Error(`consumer module closure escapes its owner: ${file}`);
      const entry = realRelative(file);
      const discovered = new Set([entry]);
      const queue = [{ file: entry, depth: 0 }];
      let graph: ModuleGraph | undefined;
      for (const { file: current, depth } of queue) {
        const ast = parseFile(current);
        if (!ast) continue;
        const sources: string[] = [];
        let callsRequire = false;
        for (const statement of ast.program.body)
          if (
            (t.isImportDeclaration(statement) &&
              statement.importKind !== 'type' &&
              statement.importKind !== 'typeof') ||
            ((t.isExportNamedDeclaration(statement) ||
              t.isExportAllDeclaration(statement)) &&
              statement.exportKind !== 'type' &&
              statement.source)
          )
            sources.push(statement.source!.value);
        t.traverseFast(ast, node => {
          if (t.isImportExpression(node)) {
            if (!t.isStringLiteral(node.source))
              throw new Error(
                `consumer module closure has nonliteral runtime dependency: ${current}`,
              );
            sources.push(node.source.value);
          }
          if (
            (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
            t.isIdentifier(unwrapExpression(node.callee, true), {
              name: 'require',
            })
          )
            callsRequire = true;
        });
        if (callsRequire) {
          // Only the global `require` loads a module; a local binding named
          // `require` is an ordinary function.
          graph ??= createModuleGraph();
          const module = graph.module(absolute(current));
          t.traverseFast(module.file, node => {
            if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
              return;
            const callee = unwrapExpression(node.callee, true);
            if (
              !t.isIdentifier(callee, { name: 'require' }) ||
              !graph!.isUnboundReference(module, callee)
            )
              return;
            const [argument] = node.arguments;
            if (node.arguments.length !== 1 || !t.isStringLiteral(argument))
              throw new Error(
                `consumer module closure has nonliteral runtime dependency: ${current}`,
              );
            sources.push(argument.value);
          });
        }
        for (const source of sources) {
          if (!/^\.\.?\//u.test(source)) continue;
          const resolved = resolveRelative(current, source);
          if (resolved === undefined)
            throw new Error(
              `consumer module closure has unresolved relative dependency: ${current} -> ${source}`,
            );
          if (!inside(owner, path.join(workspace, resolved)))
            throw new Error(
              `consumer module closure escapes its owner: ${current} -> ${source}`,
            );
          if (discovered.has(resolved)) continue;
          if (depth + 1 >= MAX_CLOSURE_DEPTH)
            throw new Error(
              `consumer module closure exceeds ${MAX_CLOSURE_DEPTH} import-depth analysis budget`,
            );
          if (discovered.size >= MAX_CLOSURE_MODULES)
            throw new Error(
              `consumer module closure exceeds ${MAX_CLOSURE_MODULES}-module analysis budget`,
            );
          discovered.add(resolved);
          queue.push({ file: resolved, depth: depth + 1 });
        }
      }
      return queue.map(item => item.file);
    };
    /**
     * Prove that every native client factory call in a client's composed
     * closure is handed this app's own contract. An RPC client must receive
     * the exported `<Stem>RpcGroup`. An HttpApi client must receive an API
     * built with `HttpApi.make` inside the contract package: the exported
     * `<stem>Api` or an API it composes through `addHttpApi`, possibly
     * through aliases and identity pipes.
     */
    const foreignClientConstructions = (
      client: string,
      appPath: string,
      contract: string,
      stem: string,
      rpc: boolean,
    ): string[] => {
      const graph = createModuleGraph();
      const contractModule = graph.module(absolute(contract));
      const factory = rpc ? 'makeEffectRpcClient' : 'makeEffectHttpApiClient';
      const ownExport = graph.resolve(
        contractModule,
        rpc ? `${pascalCaseStem(stem)}RpcGroup` : `${camelCaseStem(stem)}Api`,
        'export',
      );
      const isIdentity = (value: GraphValue) =>
        value.kind === 'external' &&
        identitySources.includes(value.specifier) &&
        value.name === 'identity' &&
        value.members.length === 0;
      /** `value.pipe(identity)`: the same API under another expression. */
      const identityPipe = (module: SourceModule, node: t.Node) => {
        if (
          !t.isCallExpression(node) ||
          !t.isMemberExpression(node.callee) ||
          node.callee.computed ||
          !t.isIdentifier(node.callee.property, { name: 'pipe' }) ||
          node.arguments.length !== 1
        )
          return false;
        const values = graph.evaluate(module, node.arguments[0]);
        return values.length > 0 && values.every(isIdentity);
      };
      const withoutIdentity = (module: SourceModule, value: t.Node): t.Node => {
        let node = unwrapExpression(value, true);
        for (let pipes = 0; identityPipe(module, node); pipes += 1) {
          if (pipes >= MAX_API_HOPS) return value;
          node = unwrapExpression(
            ((node as t.CallExpression).callee as t.MemberExpression).object,
            true,
          );
        }
        return node;
      };
      type Declaration = Extract<ResolvedBinding, { kind: 'declaration' }>;
      /** Follow aliases and identity pipes to the expression that builds an API. */
      const normalizedApi = (initial: Declaration): Declaration | undefined => {
        let binding = initial;
        const seen = new Set<t.Node>();
        for (let hops = 0; hops < MAX_API_HOPS; hops += 1) {
          const expression = withoutIdentity(
            binding.module,
            binding.expression,
          );
          if (seen.has(expression)) return undefined;
          seen.add(expression);
          if (!t.isIdentifier(expression) && !t.isMemberExpression(expression))
            return { ...binding, expression: expression as t.Expression };
          const next = graphBinding(graph, binding.module, expression);
          if (next?.kind !== 'declaration') return undefined;
          binding = next;
        }
        return undefined;
      };
      const apiBinding = (module: SourceModule, value: t.Node) => {
        const binding = graphBinding(
          graph,
          module,
          withoutIdentity(module, value),
        );
        return binding?.kind === 'declaration'
          ? normalizedApi(binding)
          : undefined;
      };
      const ownedApis = new Map<string, Set<t.Node>>();
      const own = (binding: Declaration) => {
        const identities = ownedApis.get(binding.module.path) ?? new Set();
        identities.add(binding.expression);
        ownedApis.set(binding.module.path, identities);
      };
      const proven = new Set<t.Node>();
      const active = new Set<t.Node>();
      let visits = 0;
      /** Whether `expression` is an `HttpApi.make('Name')` builder chain. */
      const builtApi = (module: SourceModule, expression: t.Node): boolean => {
        const initial = withoutIdentity(module, expression);
        if (active.has(initial) || active.size >= MAX_API_HOPS) return false;
        active.add(initial);
        try {
          const children: t.Node[] = [];
          for (let node = initial; ; ) {
            if (++visits > MAX_API_VISITS) return false;
            if (t.isIdentifier(node) || t.isMemberExpression(node)) {
              const receiver = apiBinding(module, node);
              if (!receiver || !builtApi(receiver.module, receiver.expression))
                return false;
              break;
            }
            if (!t.isCallExpression(node)) return false;
            const callee = graph.evaluate(module, node.callee);
            if (
              callee.length > 0 &&
              callee.every(
                value =>
                  value.kind === 'external' &&
                  httpApiSources.includes(value.specifier) &&
                  value.name === 'HttpApi' &&
                  value.members.length === 1 &&
                  value.members[0] === 'make',
              )
            ) {
              if (
                node.arguments.length !== 1 ||
                !t.isStringLiteral(node.arguments[0])
              )
                return false;
              break;
            }
            if (
              !t.isMemberExpression(node.callee) ||
              node.callee.computed ||
              !t.isIdentifier(node.callee.property)
            )
              return false;
            const method = node.callee.property.name;
            const count = node.arguments.length;
            const [first] = node.arguments;
            if (method === 'addHttpApi' && count === 1) children.push(first);
            else if (
              !(
                (method === 'add' && count > 0) ||
                (method === 'annotate' && count === 2) ||
                (['annotateMerge', 'middleware'].includes(method) &&
                  count === 1) ||
                (method === 'prefix' &&
                  count === 1 &&
                  t.isStringLiteral(first) &&
                  first.value.startsWith('/'))
              )
            )
              return false;
            node = withoutIdentity(module, node.callee.object);
          }
          return children.every(child => {
            const binding = apiBinding(module, child);
            return binding !== undefined && collectApi(binding);
          });
        } finally {
          active.delete(initial);
        }
      };
      /** Prove `binding` and own it when it lives in the contract package. */
      const collectApi = (binding: Declaration): boolean => {
        if (proven.has(binding.expression)) return true;
        if (!builtApi(binding.module, binding.expression)) return false;
        proven.add(binding.expression);
        if (binding.module.boundary === contractModule.boundary) own(binding);
        return true;
      };
      if (!rpc && ownExport?.kind === 'declaration') {
        const root = normalizedApi(ownExport);
        if (root && collectApi(root)) own(root);
        else ownedApis.clear();
      }
      /**
       * A module that mutates anything may also mutate an API alias, so each
       * `const alias = api.pipe(...)` of the client's API must be an identity
       * pipe the graph still resolves.
       */
      const immutablePipeAliases = (
        module: SourceModule,
        target: Declaration,
      ) => {
        if (module.mutations.length === 0) return true;
        let valid = true;
        t.traverseFast(module.file, node => {
          if (
            !t.isVariableDeclarator(node) ||
            !t.isIdentifier(node.id) ||
            !node.init
          )
            return;
          let initializer = unwrapExpression(node.init, true);
          let identityOnly = true;
          let piped = false;
          while (
            t.isCallExpression(initializer) &&
            t.isMemberExpression(initializer.callee) &&
            !initializer.callee.computed &&
            t.isIdentifier(initializer.callee.property, { name: 'pipe' })
          ) {
            piped = true;
            identityOnly &&= identityPipe(module, initializer);
            initializer = unwrapExpression(initializer.callee.object, true);
          }
          if (!piped) return;
          const receiver = apiBinding(module, initializer);
          if (
            receiver?.module.path !== target.module.path ||
            receiver.expression !== target.expression
          )
            return;
          if (
            !identityOnly ||
            graph.resolveReference(module, node.id)?.kind !== 'declaration'
          )
            valid = false;
        });
        return valid;
      };
      const ownedBy = (module: SourceModule, argument: t.Node | undefined) => {
        if (!argument) return false;
        if (rpc) {
          const binding = graphBinding(graph, module, argument);
          return (
            binding?.kind === 'declaration' &&
            ownExport?.kind === 'declaration' &&
            binding.module.path === ownExport.module.path &&
            binding.expression === ownExport.expression
          );
        }
        const binding = apiBinding(module, argument);
        return (
          binding !== undefined &&
          !!ownedApis.get(binding.module.path)?.has(binding.expression) &&
          immutablePipeAliases(module, binding)
        );
      };
      const violations = new Set<string>();
      for (const source of composedModules(client, appPath)) {
        const module = graph.module(absolute(source));
        t.traverseFast(module.file, node => {
          if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
            return;
          const native = graph
            .evaluate(module, node.callee)
            .some(
              value =>
                value.kind === 'external' &&
                value.specifier === effect &&
                value.name === factory,
            );
          if (native && !ownedBy(module, node.arguments[0]))
            violations.add(
              `${source}: must construct the client from its own API contract`,
            );
        });
      }
      return [...violations];
    };
    const moduleShape = (
      file: string,
      imports: readonly (readonly [string, readonly string[]])[],
      calls: readonly string[],
      patterns: readonly (readonly [RegExp, string])[] = [],
      defaultExport?: string,
      composedAppPath?: string,
    ) => {
      if (!exists(file)) return;
      const ast = parseFile(file);
      if (!ast) return;
      // Source-shape rules (`patterns`, `defaultExport`) stay on this file;
      // only imports and calls may be satisfied by a composed module.
      const shapeFiles = composedAppPath
        ? composedModules(file, composedAppPath)
        : [file];
      const body = shapeFiles.flatMap(
        shapeFile => parseFile(shapeFile)?.program.body ?? [],
      );
      for (const [specifier, names] of imports) {
        // A relative specifier names a file, not a string: `../../shared/api`
        // and `../../shared/api.ts` are the same module, and a sibling reaches
        // it by its own path.
        const target = resolveRelative(file, specifier);
        const matchesSpecifier = (item: t.ImportDeclaration, from: string) =>
          target === undefined
            ? item.source.value === specifier
            : resolveRelative(from, item.source.value) === target;
        const imported = shapeFiles.flatMap(shapeFile =>
          (parseFile(shapeFile)?.program.body ?? []).filter(
            item =>
              t.isImportDeclaration(item) &&
              item.importKind !== 'type' &&
              matchesSpecifier(item, shapeFile),
          ),
        );
        assert(imported.length, `${file}: must import from ${specifier}`);
        for (const name of names)
          assert(
            imported.some(
              item =>
                t.isImportDeclaration(item) &&
                item.specifiers.some(
                  value =>
                    t.isImportSpecifier(value) &&
                    value.importKind !== 'type' &&
                    t.isIdentifier(value.imported, { name }) &&
                    t.isIdentifier(value.local, { name }),
                ),
            ),
            `${file}: must import ${name} from ${specifier}`,
          );
      }
      const found = new Set<string>();
      const collectCalls = (node: t.Node) => {
        if (!t.isCallExpression(node)) return;
        if (t.isIdentifier(node.callee)) found.add(node.callee.name);
        if (
          t.isMemberExpression(node.callee) &&
          !node.callee.computed &&
          t.isIdentifier(node.callee.object) &&
          t.isIdentifier(node.callee.property)
        )
          found.add(`${node.callee.object.name}.${node.callee.property.name}`);
      };
      for (const shapeFile of shapeFiles) {
        const shapeAst = parseFile(shapeFile);
        if (shapeAst) t.traverseFast(shapeAst, collectCalls);
      }
      for (const call of calls)
        assert(found.has(call), `${file}: must call ${call}(...)`);
      const source = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
      for (const [pattern, reason] of patterns)
        assert(pattern.test(source), `${file}: ${reason}`);
      if (defaultExport)
        assert(
          body.some(
            item =>
              t.isExportDefaultDeclaration(item) &&
              t.isIdentifier(item.declaration, { name: defaultExport }),
          ),
          `${file}: must default-export ${defaultExport}`,
        );
    };
    const effect = '@modern-js/bff-effect/effect-client';
    const httpApiSources = [effect, 'effect/http-api'];
    const clientFactories = new Set([
      'makeEffectHttpApiClient',
      'makeEffectRpcClient',
    ]);
    const appDirectories = [
      ...new Set([
        ...directories('apps'),
        ...directories('verticals'),
        ...byPath.keys(),
      ]),
    ];
    for (const appPath of appDirectories)
      for (const suffix of [
        'api/effect',
        'api/lambda',
        'shared/effect',
        'src/effect',
      ])
        noPath(
          `${appPath}/${suffix}`,
          'legacy nested Effect paths are forbidden; use api/index.ts, shared/api.ts and src/api/*',
        );
    const sourceFiles = [
      ...new Set(
        ['apps', 'verticals', 'packages', ...byPath.keys()].flatMap(walk),
      ),
    ].filter(file => /\.(?:[cm]?[jt]sx?|json|md)$/u.test(file));
    for (const file of sourceFiles)
      guarded(file, () => {
        const source = read(file);
        const patterns: [RegExp, string][] = [
          [
            /@modern-js\/plugin-bff\/(?:server|hono-server)(?![\w-])/u,
            'use Effect HttpApi instead of Hono helpers',
          ],
          [
            /\bruntimeFramework\s*(?::|=)\s*['"]hono['"]/u,
            'must use the Effect runtime',
          ],
          [
            /\bstrictEffectApproach\s*(?::|=)\s*false\b/u,
            'must keep strictEffectApproach enabled',
          ],
        ];
        if (/\/api\//u.test(file))
          patterns.push(
            [
              /\bnew\s+Response\s*\(|\bResponse\.json\s*\(/u,
              'must not hand-build Response objects',
            ],
            [
              /\b(?:request|req)\.(?:json|text|formData|arrayBuffer)\s*\(/u,
              'must use endpoint payload/query/params schemas instead of parsing request bodies',
            ],
            [
              /\bexport\s+const\s+handler\b|\bexport\s+default\s+async\b/u,
              'must not export raw request handlers',
            ],
            [
              /\bcreateHandler\s*[:=]\s*(?!defineEffectBff\b)/u,
              'must use defineEffectBff instead of unbranded handler factories',
            ],
          );
        for (const [pattern, reason] of patterns)
          assert(!pattern.test(source), `${file}: ${reason}`);
        if (/\/api\//u.test(file) && /\.[cm]?[jt]sx?$/u.test(file)) {
          const ast = parseFile(file);
          let unconstrained = false;
          if (ast)
            t.traverseFast(ast, node => {
              unconstrained ||= runtimeSchemaMember(node) !== undefined;
            });
          assert(
            !unconstrained,
            `${file}: must use concrete request, response and error schemas`,
          );
        }
        if (topology && /\/api\/index\.ts$/u.test(file)) {
          topologyFilesAnalyzed += 1;
          const violation = strictEffectRuntimeTopologyViolation(
            source,
            createEffectApiImportResolver(absolute(file)),
          );
          if (violation) diagnostics.push(`${file}: ${violation}`);
        }
      });
    for (const appPath of appDirectories)
      guarded(appPath, () => {
        const app = byPath.get(appPath);
        const emits = app
          ? apiApp(app) || (app.kind !== 'vertical' && app.api !== undefined)
          : appPath.startsWith('verticals/') ||
            exists(`${appPath}/api/index.ts`) ||
            exists(`${appPath}/shared/api.ts`);
        if (!emits) {
          if (app?.kind === 'vertical') {
            assert(
              app.api === undefined,
              `${appPath}: UI/horizontal unit must not declare an API`,
            );
            for (const suffix of [
              'api/index.ts',
              'api/effect-api.ts',
              'shared/api.ts',
              'shared/rpc.ts',
              'src/api',
            ])
              noPath(`${appPath}/${suffix}`, 'unit has no API surface');
          }
          return;
        }
        if (app?.kind === 'vertical')
          assert(
            app.api !== undefined,
            `${appPath}: vertical must declare its Effect API in topology/reference-topology.json`,
          );
        const stem = app?.api?.stem ?? path.posix.basename(appPath);
        const rpc = app?.api?.protocol === 'rpc';
        const contract = `${appPath}/shared/${rpc ? 'rpc' : 'api'}.ts`;
        const entry = `${appPath}/api/index.ts`;
        for (const file of [entry, contract])
          assert(exists(file), `${file}: required API surface is missing`);
        const packageFile = `${appPath}/package.json`;
        assert(
          exists(packageFile),
          `${packageFile}: required API package is missing`,
        );
        if (!exists(packageFile)) return;
        const manifest = JSON.parse(read(packageFile));
        assert(
          manifest.exports?.['./api'] === `./shared/${rpc ? 'rpc' : 'api'}.ts`,
          `${packageFile}: invalid ./api export`,
        );
        const clientKey = `./api/${rpc ? 'rpc-client' : 'client'}`;
        const client = clientExportFile(appPath, manifest.exports?.[clientKey]);
        assert(
          client !== undefined,
          `${packageFile}: invalid API client export`,
        );
        assert(
          manifest.exports?.[`./api/${rpc ? 'client' : 'rpc-client'}`] ===
            undefined,
          `${packageFile}: forbidden opposite protocol client export`,
        );
        noPath(
          `${appPath}/shared/${rpc ? 'api' : 'rpc'}.ts`,
          `must not emit a ${rpc ? 'REST' : 'RPC'} contract`,
        );
        if (rpc) {
          moduleShape(
            entry,
            [
              [
                '@modern-js/bff-effect/effect-edge',
                ['defineEffectBff', 'Effect', 'HttpApi', 'Layer'],
              ],
              ['../shared/rpc.ts', []],
            ],
            ['defineEffectBff', 'HttpApi.make'],
            [
              [
                /\bconst\s+\w+RpcLayer\s*=\s*\w+RpcGroup\s*\.\s*toLayer\s*\(/u,
                'must implement RpcGroup.toLayer(...)',
              ],
              [
                /\brpc\s*:\s*\{[\s\S]*?\bgroup\s*:[\s\S]*?\blayer\s*:[\s\S]*?\bpath\s*:[\s\S]*?\bserialization\s*:/u,
                'must register RPC group, layer, path and serialization',
              ],
            ],
            'apiRuntime',
          );
          moduleShape(
            contract,
            [
              ['effect/rpc', ['Rpc', 'RpcGroup']],
              [effect, ['Schema']],
            ],
            ['RpcGroup.make', 'Rpc.make', 'Schema.Struct'],
          );
        } else if (exists(contract)) {
          // Each app's native resolver selects its own installed peer context.
          // An explicit owner remains an exact identity constraint.
          const owner =
            options.baselinePackageDirectory ??
            resolveBaselinePackageDirectory(absolute(contract));
          const apiPrefix = app?.api?.prefix ?? `/${stem}-api`;
          const basePath = `${apiPrefix}/${stem}`;
          const expectation: MicroVerticalApiBaselineExpectation = {
            operationPaths: app?.api?.operationPaths,
            additionalPaths: app?.api?.additionalPaths ?? {},
            apiPrefix,
            basePath,
            effectClientPackage: effect,
            ownerId: app?.id ?? path.posix.basename(appPath),
            readinessPath: `${basePath}/readiness`,
            baselinePackage,
            baselinePackageDirectory: owner,
          };
          const violation = microVerticalApiBaselineViolation(
            stem,
            absolute(contract),
            expectation,
          );
          if (violation) diagnostics.push(`${contract}: ${violation}`);
        }
        if (client) {
          const relativeContract = path.posix.relative(
            path.posix.dirname(client),
            contract,
          );
          moduleShape(
            client,
            [
              [
                effect,
                [
                  'Effect',
                  rpc ? 'makeEffectRpcClient' : 'makeEffectHttpApiClient',
                ],
              ],
              [
                relativeContract.startsWith('.')
                  ? relativeContract
                  : `./${relativeContract}`,
                [],
              ],
            ],
            [rpc ? 'makeEffectRpcClient' : 'makeEffectHttpApiClient'],
            [],
            undefined,
            appPath,
          );
          if (exists(contract))
            diagnostics.push(
              ...foreignClientConstructions(
                client,
                appPath,
                contract,
                stem,
                rpc,
              ),
            );
        }
        moduleShape(
          `${appPath}/api/effect-api.ts`,
          [],
          [],
          [
            [
              /\bbackendFederationContract\b/u,
              'must export backendFederationContract metadata',
            ],
            [
              /role:\s*['"]microvertical-server['"]/u,
              'must describe the MicroVertical server role',
            ],
            [
              /strictEffectApproach:\s*true/u,
              'must preserve strict Effect backend execution',
            ],
            [
              /contractVersion:\s*['"]microvertical-server-effect-v1['"]/u,
              'must preserve the server contract version',
            ],
            [
              /export\s*\{\s*default\s*,\s*default\s+as\s+runtime\s*\}\s+from\s+['"]\.\/index\.ts['"]/u,
              'must re-export the runtime as default and runtime',
            ],
            [
              /^(?![\s\S]*\b(request|handler)\s*:\s*async\s*\()/u,
              'must not expose raw request handlers',
            ],
          ],
        );
        moduleShape(
          `${appPath}/modern.config.ts`,
          [],
          [],
          [
            [
              /runtimeFramework:\s*['"]effect['"]/u,
              'must use bff.runtimeFramework: effect',
            ],
            [/entry:\s*['"]\.\/api\/index['"]/u, 'must use ./api/index'],
            [
              /strictEffectApproach:\s*true/u,
              'must enable strictEffectApproach',
            ],
          ],
        );
      });
    const sourceRules = options.sourceRules ?? [];
    for (const file of sourceRules.length ? sourceFiles : [])
      if (/\.[cm]?[jt]sx?$/u.test(file))
        guarded(file, () => {
          // A fresh graph per file keeps memory bounded by one file's closure.
          const graph = createModuleGraph();
          let module: SourceModule;
          try {
            module = graph.module(absolute(file));
          } catch (error) {
            if (!(error instanceof SourceSyntaxError)) throw error;
            diagnostics.push(
              `${file}: source rules need parseable source (${error.message})`,
            );
            return;
          }
          for (const rule of sourceRules) {
            const messages: unknown = rule({ file, module, graph });
            if (
              !Array.isArray(messages) ||
              !messages.every(message => typeof message === 'string')
            )
              throw new Error(
                `rule ${rule.name || 'anonymous'} must return an array of violation messages (return [] when the file passes)`,
              );
            for (const message of messages)
              diagnostics.push(`${file}: ${message}`);
          }
        });
    /**
     * A Shell composes other owners' UI, never their API clients. It must not
     * publish a client registry, and no value its public source exports may
     * be, contain, return or re-export a client built from another owner's
     * API contract.
     */
    const checkShellExports = (shellPath: string) => {
      const packageFile = `${shellPath}/package.json`;
      const manifest = JSON.parse(read(packageFile));
      noPath(
        `${shellPath}/src/api/vertical-clients.ts`,
        'Shell client registries are forbidden; import each owner client directly',
      );
      assert(
        !Object.hasOwn(manifest.exports ?? {}, './api/clients'),
        `${packageFile}: Shell ./api/clients exports are forbidden`,
      );
      const owner = fs.realpathSync(absolute(shellPath));
      const invalidExport = () =>
        assert(false, `${packageFile}: invalid Shell public source export`);
      const targets = (exported: unknown): string[] =>
        typeof exported === 'string'
          ? [exported]
          : exported && typeof exported === 'object'
            ? Object.values(exported).flatMap(targets)
            : [];
      const filesUnder = (
        directory: string,
        seen = new Set<string>(),
      ): string[] => {
        const real = fs.realpathSync(absolute(directory));
        if (real !== owner && !inside(owner, real)) {
          invalidExport();
          return [];
        }
        if (seen.has(real)) return [];
        seen.add(real);
        return fs
          .readdirSync(absolute(directory), { withFileTypes: true })
          .flatMap(entry => {
            if (ignored.has(entry.name)) return [];
            const file = `${directory}/${entry.name}`;
            const stat = fs.statSync(absolute(file));
            return stat.isDirectory()
              ? filesUnder(file, seen)
              : stat.isFile()
                ? [file]
                : [];
          });
      };
      const exportedFiles = (target: string): string[] => {
        if (!target.includes('*')) return [`${shellPath}/${target.slice(2)}`];
        const prefix = target.slice(0, target.indexOf('*'));
        const pattern = new RegExp(
          `^${target
            .split('*')
            .map(part => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
            .join('.*')}$`,
          'u',
        );
        return filesUnder(
          `${shellPath}/${prefix.slice(2, prefix.lastIndexOf('/'))}`,
        ).filter(file =>
          pattern.test(`./${path.posix.relative(shellPath, file)}`),
        );
      };
      const ownClientPrefix = `${manifest.name}/api/`;
      const foreignSpecifier = (specifier: string) =>
        /\/api\/(?:rpc-)?client$/u.test(specifier) &&
        !specifier.startsWith(ownClientPrefix);
      for (const target of targets(manifest.exports)) {
        if (!/\.[cm]?[jt]sx?$/u.test(target)) continue;
        if (!target.startsWith('./') || target.split(/[\\/]/u).includes('..')) {
          invalidExport();
          continue;
        }
        for (const candidate of exportedFiles(target)) {
          const file = clientExportFile(
            shellPath,
            `./${path.posix.relative(shellPath, candidate)}`,
          );
          if (!file) {
            invalidExport();
            continue;
          }
          assert(
            !exposesForeignClient(file, owner, foreignSpecifier),
            `${file}: Shell public exports must not expose another owner's API client`,
          );
        }
      }
    };
    /** Whether any value module `entry` exports reaches a foreign API client. */
    const exposesForeignClient = (
      entry: string,
      owner: string,
      foreignSpecifier: (specifier: string) => boolean,
    ): boolean => {
      const graph = createModuleGraph();
      const seenValues = new Set<t.Node>();
      const seenExports = new Map<string, Set<string>>();
      const workspacePath = (module: SourceModule) =>
        normalize(path.relative(workspace, module.path));
      const resolveSource = (from: string, specifier: string) =>
        resolveRelative(from, specifier) ?? ownerClients.get(specifier);
      const returnExpressions = (node: t.Node): t.Node[] => {
        if (t.isReturnStatement(node))
          return node.argument ? [node.argument] : [];
        if (t.isFunction(node)) return [];
        return (t.VISITOR_KEYS[node.type] ?? []).flatMap(key => {
          const value: unknown = Reflect.get(node, key);
          return (Array.isArray(value) ? value : [value]).flatMap(child =>
            t.isNode(child) ? returnExpressions(child) : [],
          );
        });
      };
      const nestedValues = (node: t.Node): t.Node[] => {
        if (t.isObjectExpression(node))
          return node.properties.flatMap(property =>
            t.isObjectProperty(property)
              ? [property.value]
              : t.isObjectMethod(property)
                ? returnExpressions(property.body)
                : t.isSpreadElement(property)
                  ? [property.argument]
                  : [],
          );
        if (t.isArrayExpression(node))
          return node.elements.filter(element => element !== null);
        if (t.isFunction(node))
          return t.isBlockStatement(node.body)
            ? returnExpressions(node.body)
            : [node.body];
        return [];
      };
      const foreignValue = (
        value: ReturnType<ModuleGraph['evaluate']>[number],
        from: SourceModule,
      ): boolean => {
        if (value.kind === 'external') {
          const source = resolveSource(workspacePath(from), value.specifier);
          if (!source) return foreignSpecifier(value.specifier);
          return value.name === '*'
            ? inspect(source)
            : exportedValue(source, value.name);
        }
        if (
          value.kind === 'unresolved' &&
          t.isImportDeclaration(value.node) &&
          value.node.specifiers.some(specifier =>
            t.isImportNamespaceSpecifier(specifier),
          )
        ) {
          const specifier = value.node.source.value;
          const source = resolveSource(workspacePath(value.module), specifier);
          return source ? inspect(source) : foreignSpecifier(specifier);
        }
        if (value.kind !== 'node' || seenValues.has(value.node)) return false;
        seenValues.add(value.node);
        const { node, module } = value;
        if (
          (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
          graph
            .evaluate(module, node.callee)
            .some(
              callee =>
                callee.kind === 'external' &&
                callee.specifier === effect &&
                clientFactories.has(callee.name),
            )
        ) {
          const [argument] = node.arguments;
          const binding = argument
            ? graphBinding(graph, module, argument)
            : undefined;
          if (
            module.boundary !== owner ||
            binding?.kind !== 'declaration' ||
            binding.module.boundary !== owner
          )
            return true;
        }
        return nestedValues(node).some(expression =>
          graph
            .evaluate(module, expression)
            .some(nested => foreignValue(nested, module)),
        );
      };
      const exportName = (node: t.Identifier | t.StringLiteral) =>
        t.isIdentifier(node) ? node.name : node.value;
      const names = (source: string, visited = new Set<string>()): string[] => {
        if (visited.has(source)) return [];
        visited.add(source);
        return graph
          .module(absolute(source))
          .file.program.body.flatMap(statement => {
            if (t.isExportDefaultDeclaration(statement)) return ['default'];
            if (
              (!t.isExportNamedDeclaration(statement) &&
                !t.isExportAllDeclaration(statement)) ||
              statement.exportKind === 'type'
            )
              return [];
            if (t.isExportAllDeclaration(statement)) {
              const target = resolveSource(source, statement.source.value);
              return target
                ? names(target, visited).filter(name => name !== 'default')
                : [];
            }
            return statement.declaration
              ? Object.keys(t.getOuterBindingIdentifiers(statement.declaration))
              : statement.specifiers.flatMap(specifier =>
                  t.isExportSpecifier(specifier) &&
                  specifier.exportKind === 'type'
                    ? []
                    : [exportName(specifier.exported)],
                );
          });
      };
      const exportedValue = (source: string, name: string): boolean => {
        const visited = seenExports.get(source) ?? new Set<string>();
        if (visited.has(name)) return false;
        visited.add(name);
        seenExports.set(source, visited);
        const module = graph.module(absolute(source));
        const evaluates = (from: SourceModule, node: t.Node) =>
          graph.evaluate(from, node).some(value => foreignValue(value, from));
        const binding = graph.resolve(module, name, 'export');
        if (binding?.kind === 'external')
          return foreignValue({ ...binding, members: [] }, module);
        if (binding?.kind === 'declaration')
          return evaluates(binding.module, binding.expression);
        for (const statement of module.file.program.body) {
          if (t.isExportDefaultDeclaration(statement) && name === 'default')
            return evaluates(module, statement.declaration);
          if (
            !t.isExportNamedDeclaration(statement) ||
            statement.exportKind === 'type'
          )
            continue;
          if (
            t.isFunctionDeclaration(statement.declaration) &&
            statement.declaration.id?.name === name
          )
            return evaluates(module, statement.declaration);
          const specifier = statement.specifiers.find(
            item => exportName(item.exported) === name,
          );
          if (!specifier) continue;
          if (t.isExportSpecifier(specifier) && specifier.exportKind === 'type')
            return false;
          if (!statement.source)
            return t.isExportSpecifier(specifier)
              ? evaluates(module, specifier.local)
              : false;
          const target = resolveSource(source, statement.source.value);
          if (!target) return foreignSpecifier(statement.source.value);
          if (t.isExportNamespaceSpecifier(specifier)) return inspect(target);
          if (t.isExportSpecifier(specifier))
            return exportedValue(target, exportName(specifier.local));
        }
        return module.file.program.body.some(statement => {
          if (
            !t.isExportAllDeclaration(statement) ||
            statement.exportKind === 'type'
          )
            return false;
          const target = resolveSource(source, statement.source.value);
          return (
            !!target &&
            names(target).includes(name) &&
            exportedValue(target, name)
          );
        });
      };
      const inspect = (source: string): boolean =>
        [...new Set(names(source))].some(name => exportedValue(source, name));
      return inspect(entry);
    };
    // Public client entry points by specifier, so a Shell re-export of
    // another owner's `<package>/api/client` is followed into that owner.
    const ownerClients = new Map<string, string>();
    for (const app of apps)
      if (exists(`${app.path}/package.json`)) {
        const manifest = JSON.parse(read(`${app.path}/package.json`));
        for (const key of ['./api/client', './api/rpc-client'] as const) {
          const file = clientExportFile(app.path, manifest.exports?.[key]);
          if (file) ownerClients.set(`${manifest.name}${key.slice(1)}`, file);
        }
      }
    for (const shell of apps.filter(app => app.kind === 'shell'))
      guarded(shell.path, () => checkShellExports(normalize(shell.path)));
    if (exists('topology/reference-topology.json'))
      guarded('topology/reference-topology.json', () => {
        for (const vertical of JSON.parse(
          read('topology/reference-topology.json'),
        ).verticals ?? []) {
          if (vertical.api?.runtime === 'effect') {
            assert(
              vertical.api.bff?.strictEffectApproach === true,
              `${vertical.id}: topology must mark strictEffectApproach true`,
            );
            assert(
              typeof vertical.api.serverEntry === 'string' &&
                vertical.api.serverEntry.endsWith('/api/index.ts'),
              `${vertical.id}: topology must use api/index.ts`,
            );
          }
          assert(
            !vertical.api?.effect,
            `${vertical.id}: topology must describe API directly, not api.effect`,
          );
        }
      });
  } catch (error) {
    toolErrors.push(errorMessage(error));
  }
  return { diagnostics, toolErrors, topologyFilesAnalyzed };
}

/** Full standalone check: source runtime topology is analyzed once per entry. */
export const checkMicroVerticalApiBoundaries = (
  options: MicroVerticalApiCheckOptions,
): MicroVerticalApiCheckResult => check(options, true);
/** Consumer files/export/owner checks; caller must separately run runtime topology analysis. */
export const checkMicroVerticalApiConsumerFiles = (
  options: MicroVerticalApiCheckOptions,
): MicroVerticalApiCheckResult => check(options, false);
