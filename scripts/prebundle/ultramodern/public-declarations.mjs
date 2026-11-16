import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { types as babelTypes, parseSync } from '@babel/core';

function declarationFiles(root) {
  return readdirSync(root, { recursive: true })
    .filter(file => file.endsWith('.d.ts'))
    .map(file => join(root, file));
}

function rewrite(file, transform) {
  const before = readFileSync(file, 'utf8');
  const after = transform(before);
  if (before !== after) writeFileSync(file, after);
}

function modulePath(file, target) {
  const path = relative(dirname(file), target).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

// A plugin's configuration aliases do not need its compiler class or private
// implementation declarations. Copy the reachable aliases from the installed
// version so supported options stay in sync without importing Webpack's API.
function emitOptionDeclarations(
  packageRoot,
  target,
  roots,
  footer,
  overrides = {},
) {
  const source = readFileSync(join(packageRoot, 'types/index.d.ts'), 'utf8');
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    // Ambient namespaces can re-export aliases declared in their enclosing
    // module. Babel's JS export-binding check does not model that TS scope.
    parserOpts: {
      allowUndeclaredExports: true,
      plugins: [['typescript', { dts: true }]],
    },
  });
  const aliases = new Map(
    ast.program.body
      .filter(node => node.type === 'TSTypeAliasDeclaration')
      .map(node => [node.id.name, node]),
  );
  const selected = new Set();
  function visit(name) {
    if (selected.has(name)) return;
    const alias = aliases.get(name);
    if (!alias)
      throw new Error(`Missing declaration input ${name} in ${packageRoot}`);
    selected.add(name);
    if (Object.hasOwn(overrides, name)) return;
    babelTypes.traverseFast(alias.typeAnnotation, node => {
      if (
        node.type === 'TSTypeReference' &&
        node.typeName.type === 'Identifier' &&
        aliases.has(node.typeName.name)
      )
        visit(node.typeName.name);
    });
  }
  roots.forEach(visit);
  mkdirSync(target, { recursive: true });
  const declarations = [...selected].map(name => {
    if (Object.hasOwn(overrides, name))
      return `type ${name} = ${overrides[name]};`;
    const node = aliases.get(name);
    return source.slice(node.start, node.end);
  });
  writeFileSync(
    join(target, 'index.d.ts'),
    `${declarations.join('\n')}\n${footer}\n`,
  );
  cpSync(join(packageRoot, 'LICENSE'), join(target, 'LICENSE'));
}

/** Keep Builder's optional Sass configuration graph on the actual Rspack/Sass implementation. */
export function emitBuilderDeclarations(types, resolvePackage) {
  const css = join(types, 'css-minimizer');
  const cssPlugin = packageResolver(
    resolvePackage('@rsbuild/plugin-css-minimizer'),
  )('css-minimizer-webpack-plugin');
  emitOptionDeclarations(
    cssPlugin,
    css,
    [
      'BasePluginOptions',
      'DefinedDefaultMinimizerAndOptions',
      'CssNanoOptionsExtended',
    ],
    "export type PluginCssMinimizerOptions = { pluginOptions?: import('@rsbuild/core').ConfigChain<BasePluginOptions & DefinedDefaultMinimizerAndOptions<CssNanoOptionsExtended>> };",
  );
  const plugin = resolvePackage('@rsbuild/plugin-sass');
  const target = join(types, 'sass');
  mkdirSync(target, { recursive: true });
  cpSync(join(plugin, 'dist/types.d.ts'), join(target, 'index.d.ts'));
  cpSync(
    join(plugin, 'compiled/sass-loader/index.d.ts'),
    join(target, 'loader.d.ts'),
  );
  cpSync(join(plugin, 'LICENSE'), join(target, 'LICENSE'));
  rewrite(join(target, 'index.d.ts'), text =>
    text.replace('../compiled/sass-loader/index.js', './loader.js'),
  );
  rewrite(join(target, 'loader.d.ts'), text =>
    text
      .replace(
        "import * as Sass from 'sass';",
        "import * as Sass from 'sass-embedded';",
      )
      .replace(
        "import Webpack from 'webpack';",
        "import type { Rspack } from '@rsbuild/core';",
      )
      .replaceAll('Webpack.loader.LoaderContext', 'Rspack.LoaderContext'),
  );
  for (const file of declarationFiles(types)) {
    if (file.startsWith(`${target}/`)) continue;
    rewrite(file, text =>
      text
        .replace(
          /import type \{ SvgDefaultExport \} from ['"]@rsbuild\/plugin-svgr['"];?/g,
          "type SvgDefaultExport = 'component' | 'url';",
        )
        .replace(
          /(['"])@rsbuild\/plugin-sass\1/g,
          (_, quote) =>
            `${quote}${modulePath(file, join(target, 'index.js'))}${quote}`,
        )
        .replace(
          /(['"])@rsbuild\/plugin-css-minimizer\1/g,
          (_, quote) =>
            `${quote}${modulePath(file, join(css, 'index.js'))}${quote}`,
        ),
    );
  }
}

export function emitAppToolsExtensionsDeclarations(types, resolvePackage) {
  const target = join(types, 'precompress');
  emitOptionDeclarations(
    resolvePackage('compression-webpack-plugin'),
    target,
    ['BasePluginOptions', 'DefinedDefaultAlgorithmAndOptions', 'ZlibOptions'],
    'export type CompressionPluginOptions = BasePluginOptions<ZlibOptions> & DefinedDefaultAlgorithmAndOptions<ZlibOptions>;',
    { PathData: "import('@rsbuild/core').Rspack.PathData" },
  );
  rewrite(join(types, 'build-config/precompress/types.d.ts'), text =>
    text.replace(
      /import type CompressionPlugin from ['"]compression-webpack-plugin['"];\s*type CompressionPluginOptions = NonNullable<ConstructorParameters<typeof CompressionPlugin>\[0\]>;/,
      "import type { CompressionPluginOptions } from '../../precompress/index.js';",
    ),
  );
  emitSvgrDeclarations(types, resolvePackage);
}

function moduleSpecifiers(source) {
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: [['typescript', { dts: true }]] },
  });
  const specifiers = [];
  babelTypes.traverseFast(ast.program, node => {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration' ||
        node.type === 'TSImportType') &&
      node.source
    )
      specifiers.push(node.source);
  });
  return specifiers.sort((a, b) => a.start - b.start);
}

// Copy one declaration file and the relative declarations it reaches, mapping
// bare specifiers through `rename` (a function of the copied file's target).
function vendorDeclarations(packageRoot, entry, target, rename) {
  const pending = [entry];
  const copied = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (copied.has(file)) continue;
    copied.add(file);
    const output = join(target, file);
    const source = readFileSync(join(packageRoot, file), 'utf8');
    let text = source;
    for (const literal of moduleSpecifiers(source).reverse()) {
      const specifier = literal.value;
      let replacement = specifier;
      if (specifier.startsWith('.')) {
        const base = join(dirname(file), specifier);
        const reached = [
          `${base}.d.ts`,
          base.replace(/\.js$/, '.d.ts'),
          join(base, 'index.d.ts'),
        ].find(
          candidate =>
            candidate.endsWith('.d.ts') &&
            existsSync(join(packageRoot, candidate)),
        );
        if (!reached)
          throw new Error(`Cannot vendor ${specifier} from ${file}`);
        pending.push(reached);
      } else replacement = rename(output, specifier);
      text = `${text.slice(0, literal.start)}'${replacement}'${text.slice(literal.end)}`;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
  }
  cpSync(join(packageRoot, 'LICENSE'), join(target, 'LICENSE'));
}

// SVGR's published option declarations import packages it does not declare
// (`@babel/template`, `svgo`, `prettier`) or that ship no types (Babel 7's
// `@babel/core`), so every consumer binds whatever its installation hoists,
// such as Babel 8. Publish the option graph self-contained instead: each
// specifier maps to the declarations of the package SVGR runs with (Babel 7
// through its DefinitelyTyped types, SVGO from @svgr/plugin-svgo). Only the
// Rsbuild peer stays external; any other import fails the build.
export function emitSvgrDeclarations(types, resolvePackage) {
  const target = join(types, 'svgr');
  const plugin = resolvePackage('@rsbuild/plugin-svgr');
  const fromPlugin = packageResolver(plugin);
  const core = fromPlugin('@svgr/core');
  const preset = packageResolver(core)('@svgr/babel-preset');
  const babel = resolvePackage('@types/babel__core');
  const fromBabel = packageResolver(babel);
  const sources = {
    '@rsbuild/plugin-svgr': [plugin, 'dist/index.d.ts'],
    '@svgr/core': [core, 'dist/index.d.ts'],
    '@svgr/babel-preset': [preset, 'dist/index.d.ts'],
    '@svgr/babel-plugin-transform-svg-component': [
      packageResolver(preset)('@svgr/babel-plugin-transform-svg-component'),
      'dist/index.d.ts',
    ],
    svgo: [
      packageResolver(fromPlugin('@svgr/plugin-svgo'))('svgo'),
      'lib/svgo.d.ts',
    ],
    prettier: [resolvePackage('prettier'), 'index.d.ts'],
    '@babel/core': [babel, 'index.d.ts'],
    '@babel/generator': [fromBabel('@types/babel__generator'), 'index.d.ts'],
    '@babel/template': [fromBabel('@types/babel__template'), 'index.d.ts'],
    '@babel/traverse': [fromBabel('@types/babel__traverse'), 'index.d.ts'],
    '@babel/parser': [fromBabel('@babel/parser'), 'typings/babel-parser.d.ts'],
    '@babel/types': [fromBabel('@babel/types'), 'lib/index.d.ts'],
  };
  rmSync(target, { recursive: true, force: true });
  const rename = (file, specifier) => {
    if (specifier === '@rsbuild/core') return specifier;
    if (!Object.hasOwn(sources, specifier))
      throw new Error(`Undeclared SVGR declaration dependency ${specifier}`);
    const [, entry] = sources[specifier];
    return modulePath(
      file,
      join(target, specifier, entry.replace(/\.d\.ts$/, '.js')),
    );
  };
  for (const [name, [root, entry]] of Object.entries(sources))
    vendorDeclarations(root, entry, join(target, name), rename);
  const entry = join(types, 'svgr.d.ts');
  rewrite(entry, text =>
    text.replace(
      /(['"])@rsbuild\/plugin-svgr\1/g,
      (_, quote) =>
        `${quote}${modulePath(entry, join(target, '@rsbuild/plugin-svgr/dist/index.js'))}${quote}`,
    ),
  );
  for (const file of [entry, ...declarationFiles(target)])
    for (const { value } of moduleSpecifiers(readFileSync(file, 'utf8')))
      if (!value.startsWith('.') && value !== '@rsbuild/core')
        throw new Error(`${file} still imports ${value}`);
}

// Node's package directory lookup, which also finds types-only packages.
function packageResolver(packageRoot) {
  const require = createRequire(join(packageRoot, 'package.json'));
  return name => {
    for (const modules of require.resolve.paths(name) ?? []) {
      const root = join(modules, name);
      if (existsSync(join(root, 'package.json'))) return realpathSync(root);
    }
    throw new Error(`Cannot locate declaration dependency ${name}`);
  };
}

export function publicDeclarationsPlugin(kind) {
  return {
    name: `ultramodern:${kind}-public-declarations`,
    setup(api) {
      api.onAfterBuild(() => {
        const root = api.context.rootPath;
        const resolver = packageResolver(root);
        if (kind === 'builder')
          emitBuilderDeclarations(resolve(root, 'dist/types'), resolver);
        else if (kind === 'app-tools-extensions')
          emitAppToolsExtensionsDeclarations(
            resolve(root, 'dist/types'),
            resolver,
          );
        else throw new Error(`Unknown declaration producer: ${kind}`);
      });
    },
  };
}
