import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const positive = `import type { CSSProperties, SignalCSSProperties } from 'octane/jsx-runtime';
import type * as React from 'react';
declare const caret: React.CSSProperties['caret'];
declare const style: CSSProperties;
export const fromReact: CSSProperties['caret'] = caret;
export const toReact: React.CSSProperties['caret'] = style.caret;
export const valid = { caret: 'manual', width: 12, 'font-size': 16, backgroundColor: 'red', 'background-color': 'red', cssFloat: 'left', viewTransitionScope: 'all !important' } satisfies CSSProperties;
export const signalStyle = { '--size': 12, 'font-size': 16 } satisfies SignalCSSProperties;
`;
const negatives = [
  ['caret-number', '{ caret: 42 }', 2322],
  ['caret-boolean', '{ caret: false }', 2322],
  ['backgroundColor-number', '{ backgroundColor: 42 }', 2322],
  ['background-color-number', "{ 'background-color': 42 }", 2322],
  ['typo', '{ widht: 42 }', 2561],
];

/**
 * Check the complete packed declaration graph with the consumer's stable TS API.
 * Optional declarationFile mounts a complete owning-source d.ts read-only; CSS
 * directory overrides are solely inputs for the cross-version regression.
 * No package bytes, dependency manifests, or ambient declarations are changed.
 */
export async function qualifyCSSProperties({
  consumer,
  work,
  declarationFile,
  octaneCss,
  reactCss,
}) {
  const request = createRequire(
    path.join(fs.realpathSync(consumer), 'package.json'),
  );
  const octane = fs.realpathSync(path.join(consumer, 'node_modules/octane'));
  const react = path.dirname(request.resolve('@types/react/package.json'));
  const cssRoot = from =>
    path.dirname(
      createRequire(path.join(from, 'package.json')).resolve(
        'csstype/package.json',
      ),
    );
  const direct = fs.realpathSync(octaneCss ?? cssRoot(octane));
  const transitive = fs.realpathSync(reactCss ?? cssRoot(react));
  const version = root =>
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      .version;
  const { API } = await import(
    pathToFileURL(request.resolve('typescript/unstable/sync')).href
  );
  const compilerVersion = version(
    path.dirname(request.resolve('typescript/package.json')),
  );
  const declaration = fs.readFileSync(
    declarationFile ?? path.join(octane, 'dist/jsx-runtime.d.ts'),
    'utf8',
  );
  const fixture = fs.mkdtempSync(path.join(work, 'css-properties-'));
  let api;
  try {
    const virtual = path.join(fixture, 'node_modules');
    const jsx = path.join(virtual, 'octane/dist/jsx-runtime.d.ts');
    const mounts = [
      [path.join(virtual, 'octane/node_modules/csstype'), direct],
      [path.join(virtual, '@types/react/node_modules/csstype'), transitive],
      [path.join(virtual, '@types/react'), react],
      [path.join(virtual, 'csstype'), direct],
      [path.join(virtual, 'octane'), octane],
      [virtual, path.join(consumer, 'node_modules')],
    ].sort(([a], [b]) => b.length - a.length);
    const target = name => {
      for (const [prefix, destination] of mounts)
        if (name === prefix || name.startsWith(`${prefix}/`))
          return destination + name.slice(prefix.length);
      return name;
    };
    const stat = name => {
      try {
        return fs.statSync(target(name));
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return undefined;
      }
    };
    const overlay = {
      fileExists: name => name === jsx || !!stat(name)?.isFile(),
      directoryExists: name =>
        mounts.some(([prefix]) => prefix.startsWith(`${name}/`)) ||
        !!stat(name)?.isDirectory(),
      readFile(name) {
        if (name === jsx) return declaration;
        if (!stat(name)?.isFile()) return null;
        return fs.readFileSync(target(name), 'utf8');
      },
      realpath: name => (name.startsWith(`${virtual}/`) ? name : undefined),
      getAccessibleEntries(name) {
        const files = new Set();
        const directories = new Set();
        if (stat(name)?.isDirectory())
          for (const entry of fs.readdirSync(target(name)))
            (stat(path.join(name, entry))?.isDirectory()
              ? directories
              : files
            ).add(entry);
        for (const [prefix] of mounts)
          if (prefix.startsWith(`${name}/`))
            directories.add(prefix.slice(name.length + 1).split('/')[0]);
        return { files: [...files], directories: [...directories] };
      },
    };
    fs.writeFileSync(path.join(fixture, 'valid.ts'), positive);
    for (const [name, value] of negatives)
      fs.writeFileSync(
        path.join(fixture, `${name}.ts`),
        `import type { CSSProperties } from 'octane/jsx-runtime';\nexport const invalid = ${value} satisfies CSSProperties;\n`,
      );
    const config = path.join(fixture, 'tsconfig.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'preserve',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ['valid.ts', ...negatives.map(([name]) => `${name}.ts`)],
      }),
    );
    api = new API({ cwd: fixture, fs: overlay });
    const program = api
      .updateSnapshot({ openProjects: [config] })
      .getProject(config).program;
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    const loaded = program.getSourceFileNames();
    assert(
      loaded.includes(jsx),
      'Compiler must load the complete Octane declaration',
    );
    const loadedCss = loaded.filter(name =>
      /\/csstype\/index\.d\.ts$/u.test(name),
    );
    for (const root of new Set([direct, transitive]))
      assert(
        loadedCss.some(name => target(name) === path.join(root, 'index.d.ts')),
        `Compiler did not load csstype ${version(root)} from ${root}`,
      );
    const actual = diagnostics
      .map(diagnostic => ({
        file: path.relative(fixture, diagnostic.fileName ?? ''),
        code: diagnostic.code,
      }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.code - b.code);
    const expected = negatives
      .map(([name, , code]) => ({
        file: `${name}.ts`,
        code,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(
      actual,
      expected,
      diagnostics
        .map(
          diagnostic =>
            `${path.relative(fixture, diagnostic.fileName ?? '')}: TS${diagnostic.code}: ${diagnostic.text}`,
        )
        .join('\n'),
    );
    return {
      compilerVersion,
      octaneCss: version(direct),
      reactCss: version(transitive),
      loadedCss: loadedCss.map(name => ({ file: name, source: target(name) })),
      negativeDiagnostics: actual,
    };
  } finally {
    api?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
