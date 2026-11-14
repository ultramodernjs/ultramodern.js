import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typescriptVersion } from 'tsrs';
import { API } from 'tsrs/sync';
import {
  checkOctaneProject,
  formatOctaneDiagnostic,
  runOctaneTypecheck,
} from '../dist/esm-node/typecheck.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

function withProject(files, run, config = {}) {
  const root = fs.mkdtempSync(
    path.join(packageRoot, '.octane-typecheck-test-'),
  );
  try {
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'preserve',
          moduleResolution: 'Bundler',
          jsx: 'preserve',
          jsxImportSource: 'octane',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          allowImportingTsExtensions: true,
        },
        include: ['./**/*.tsrx'],
        ...config,
      }),
    );
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}

const component =
  'export const Native = (props: { title: string }) => <div>{props.title}</div>;\n';

test('native TS7 accepts imported Octane component props without writing projections', () => {
  const main =
    "import { Native } from './Component.tsrx';\nexport const App = () => <Native title='valid' />;\n";
  withProject({ 'Component.tsrx': component, 'main.tsrx': main }, root => {
    const before = fs.readdirSync(root);
    const result = checkOctaneProject({ project: 'tsconfig.json', cwd: root });
    assert.equal(result.compilerVersion, typescriptVersion);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.files.includes(path.join(root, 'Component.tsrx')));
    assert.ok(result.files.includes(path.join(root, 'main.tsrx')));
    assert.ok(
      result.files.some(file => file.endsWith('/octane/dist/jsx-runtime.d.ts')),
    );
    assert.deepEqual(fs.readdirSync(root), before);
    assert.equal(fs.readFileSync(path.join(root, 'main.tsrx'), 'utf8'), main);
  });
});

test('native TS7 rejects imported component props at the authored UTF16 location', () => {
  const main =
    "import { Native } from './Component.tsrx';\n// 🐈 a non-BMP source prefix\nexport const App = () => <Native title={42} />;\n";
  withProject({ 'Component.tsrx': component, 'main.tsrx': main }, root => {
    const result = checkOctaneProject({ project: 'tsconfig.json', cwd: root });
    assert.equal(result.diagnostics.length, 1);
    const diagnostic = result.diagnostics[0];
    assert.equal(diagnostic.origin, 'typescript');
    assert.equal(diagnostic.code, 2322);
    assert.equal(diagnostic.fileName, path.join(root, 'main.tsrx'));
    assert.equal(main.slice(diagnostic.pos, diagnostic.end), 'title');
    assert.equal(diagnostic.line, 3);
    assert.equal(diagnostic.column, main.split('\n')[2].indexOf('title') + 1);
    assert.match(
      formatOctaneDiagnostic(diagnostic, root),
      /^main\.tsrx\(3,\d+\): error TS2322:/u,
    );
    const related = diagnostic.relatedInformation?.find(
      info => info.fileName === path.join(root, 'Component.tsrx'),
    );
    assert.ok(related);
    assert.equal(component.slice(related.pos, related.end), 'title');
  });
});

test('native TS7 checks explicit TSRX files in inherited JSONC configs', () => {
  const invalid = "export const count: number = 'invalid';\n";
  withProject({ 'main.tsrx': invalid }, root => {
    fs.writeFileSync(
      path.join(root, 'base.json'),
      '{ // authored JSONC\n "files": ["./main.tsrx"],\n "compilerOptions": {"strict": true},\n}\n',
    );
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      '{"extends":"./base.json", "compilerOptions":{"noEmit":true}, "include":[]}',
    );
    const result = checkOctaneProject({ project: 'tsconfig.json', cwd: root });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 2322);
    assert.equal(result.diagnostics[0].fileName, path.join(root, 'main.tsrx'));
  });
});

test('Octane parse failures stay authored compiler errors', () => {
  withProject(
    { 'main.tsrx': 'export const Broken = () => <div></span>;' },
    root => {
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.ok(
        result.diagnostics.some(
          diagnostic =>
            diagnostic.origin === 'octane' && diagnostic.category === 'error',
        ),
      );
      assert.ok(
        result.diagnostics.every(
          diagnostic => diagnostic.fileName === path.join(root, 'main.tsrx'),
        ),
      );
      assert.ok(
        result.diagnostics.some(diagnostic =>
          diagnostic.text.includes('Unexpected closing tag'),
        ),
      );
    },
  );
});

test('native discovery preserves authored TSX includes and exclusions', () => {
  const files = {
    'src/native.tsrx': "export const count: number = 'native-error';",
    'src/plain.tsx': "export const count: number = 'plain-error';",
  };
  withProject(
    files,
    root => {
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 2322);
      assert.equal(
        result.diagnostics[0].fileName,
        path.join(root, 'src/native.tsrx'),
      );
    },
    { include: ['./src/**/*'], exclude: ['./src/**/*.tsx'] },
  );
  withProject(
    files,
    root => {
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 2322);
      assert.equal(
        result.diagnostics[0].fileName,
        path.join(root, 'src/plain.tsx'),
      );
      assert.ok(!result.files.includes(path.join(root, 'src/native.tsrx')));
    },
    { include: ['./src/**/*.tsx'] },
  );
});

test('physical TSRX-suffixed TSX files remain ordinary authored TSX', () => {
  for (const [source, expectedErrors] of [
    ['export const count: number = 1;', 0],
    ["export const count: number = 'ordinary-tsx-error';", 1],
  ]) {
    withProject(
      { 'plain.tsrx.tsx': source },
      root => {
        const result = checkOctaneProject({
          project: 'tsconfig.json',
          cwd: root,
        });
        const file = path.join(root, 'plain.tsrx.tsx');
        assert.ok(result.files.includes(file));
        assert.equal(result.diagnostics.length, expectedErrors);
        if (expectedErrors) {
          assert.equal(result.diagnostics[0].code, 2322);
          assert.equal(result.diagnostics[0].fileName, file);
          assert.equal(result.diagnostics[0].origin, 'typescript');
        }
        assert.equal(fs.readFileSync(file, 'utf8'), source);
      },
      { include: ['./**/*.tsx'] },
    );
  }
});

test('imported JSON objects and arrays keep their authored types and contents', t => {
  const object =
    '{\n  "files": ["./authored.tsrx"],\n  "include": ["./**/*.tsrx"],\n  "exclude": ["./excluded.tsrx"],\n  "count": 1\n}\n';
  const array = '[{"files":["./authored.tsrx"],"count":2}]\n';
  const valid =
    "import object from './object.json';\nimport array from './array.json';\nexport const name: string = object.files[0];\nexport const count: number = object.count;\nexport const arrayName = (index: number): string => array[index]?.files[0] ?? '';\nexport const arrayCount = (index: number): number => array[index]?.count ?? 0;\n";
  for (const [source, expectedErrors] of [
    [valid, 0],
    [`${valid}export const invalid: number = object.files[0];\n`, 1],
  ]) {
    withProject(
      { 'main.tsrx': source, 'object.json': object, 'array.json': array },
      root => {
        const configFile = path.join(root, 'tsconfig.json');
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        config.compilerOptions.resolveJsonModule = true;
        fs.writeFileSync(configFile, JSON.stringify(config));
        const checkedJSON = new Map();
        const createSnapshot = Object.getOwnPropertyDescriptor(
          API.prototype,
          'createSnapshot',
        ).get;
        const observer = t.mock.getter(
          API.prototype,
          'createSnapshot',
          function () {
            const create = createSnapshot.call(this);
            return options => {
              const snapshot = create(options);
              const program = snapshot.getConfiguredProject(
                options.openProjects[0],
              )?.program;
              for (const name of ['object.json', 'array.json']) {
                const source = program?.getSourceFile(path.join(root, name));
                if (source) checkedJSON.set(name, source.text);
              }
              return snapshot;
            };
          },
        );
        let result;
        try {
          result = checkOctaneProject({
            project: 'tsconfig.json',
            cwd: root,
          });
        } finally {
          observer.mock.restore();
        }
        assert.equal(result.diagnostics.length, expectedErrors);
        if (expectedErrors) {
          assert.equal(result.diagnostics[0].code, 2322);
          assert.equal(
            result.diagnostics[0].fileName,
            path.join(root, 'main.tsrx'),
          );
        }
        for (const [name, authored] of [
          ['object.json', object],
          ['array.json', array],
        ]) {
          assert.ok(result.files.includes(path.join(root, name)));
          assert.equal(checkedJSON.get(name), authored);
          assert.equal(
            fs.readFileSync(path.join(root, name), 'utf8'),
            authored,
          );
        }
      },
    );
  }
});

test('physical TSRX projection collisions reject the actual project and CLI', () => {
  withProject(
    {
      'main.tsrx': 'export const count: number = 1;',
      'main.tsrx.tsx': "export const count: string = 'physical-tsx';",
    },
    root => {
      assert.throws(
        () => checkOctaneProject({ project: 'tsconfig.json', cwd: root }),
        /collision.*main\.tsrx\.tsx/iu,
      );
      let output = '';
      assert.equal(
        runOctaneTypecheck(['--project', 'tsconfig.json'], {
          cwd: root,
          stdout: text => {
            output += text;
          },
          stderr: text => {
            output += text;
          },
        }),
        1,
      );
      assert.match(output, /collision.*main\.tsrx\.tsx/iu);
      assert.equal(
        fs.readFileSync(path.join(root, 'main.tsrx.tsx'), 'utf8'),
        "export const count: string = 'physical-tsx';",
      );
    },
  );
});

test('native config discovery follows referenced projects and their inherited configs', () => {
  for (const [assignment, expectedErrors] of [
    ['export const selected: number = count;', 0],
    ['export const selected: string = count;', 1],
  ]) {
    withProject(
      {
        'main.tsrx': `import { count } from './reference/value.tsrx';\n${assignment}\n`,
        'reference/value.tsrx': 'export const count: number = 1;',
        'reference/tsconfig.json': JSON.stringify({
          extends: './base.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            noEmit: false,
            types: [],
          },
        }),
        'reference/base.json': JSON.stringify({
          files: ['./value.tsrx'],
          include: [],
        }),
      },
      root => {
        const result = checkOctaneProject({
          project: 'tsconfig.json',
          cwd: root,
        });
        assert.equal(result.diagnostics.length, expectedErrors);
        if (expectedErrors) {
          assert.equal(result.diagnostics[0].code, 2322);
          assert.equal(
            result.diagnostics[0].fileName,
            path.join(root, 'main.tsrx'),
          );
        }
        assert.ok(
          result.files.includes(path.join(root, 'reference/value.tsrx')),
        );
      },
      {
        files: ['./main.tsrx'],
        include: [],
        references: [{ path: './reference' }],
      },
    );
  }
});

test('referenced projects preserve authored TSX glob membership in native programs', t => {
  for (const [selectors, selected, ignored, selectedSource, ignoredSource] of [
    [
      { include: ['./*.tsx'] },
      'Plain.tsx',
      'Ignored.tsrx',
      'export const count: number = 1;',
      'export const Broken = () => <div></span>;',
    ],
    [
      { include: ['./*'], exclude: ['./*.tsx'] },
      'Native.tsrx',
      'Ignored.tsx',
      'export const count: number = 1;',
      "export const count: number = 'excluded-tsx-error';",
    ],
  ]) {
    for (const [type, expectedErrors] of [
      ['number', 0],
      ['string', 1],
    ]) {
      withProject(
        {
          'main.tsrx': `import { count } from './reference/${selected}';\nexport const selected: ${type} = count;\n`,
          [`reference/${selected}`]: selectedSource,
          [`reference/${ignored}`]: ignoredSource,
          'reference/base.json': JSON.stringify({
            ...selectors,
            compilerOptions: {
              composite: true,
              declaration: true,
              noEmit: false,
              module: 'preserve',
              moduleResolution: 'Bundler',
              strict: true,
              types: [],
            },
          }),
          'reference/tsconfig.json': '{"extends":"./base.json"}',
        },
        root => {
          let referencedFiles;
          let referencedDiagnostics;
          const referenceFile = path.join(root, 'reference/tsconfig.json');
          const createSnapshot = Object.getOwnPropertyDescriptor(
            API.prototype,
            'createSnapshot',
          ).get;
          const observer = t.mock.getter(
            API.prototype,
            'createSnapshot',
            function () {
              const create = createSnapshot.call(this);
              return options => {
                const snapshot = create({
                  ...options,
                  openProjects: [...options.openProjects, referenceFile],
                });
                const reference = snapshot.getConfiguredProject(referenceFile);
                assert.ok(
                  reference,
                  'The native snapshot must load the actual referenced project',
                );
                referencedFiles = reference.program.getSourceFileNames();
                referencedDiagnostics = [
                  ...reference.program.getConfigFileParsingDiagnostics(),
                  ...reference.program.getProgramDiagnostics(),
                  ...reference.program.getGlobalDiagnostics(),
                  ...reference.program.getSyntacticDiagnostics(),
                  ...reference.program.getBindDiagnostics(),
                  ...reference.program.getSemanticDiagnostics(),
                ];
                return snapshot;
              };
            },
          );
          let result;
          try {
            result = checkOctaneProject({
              project: 'tsconfig.json',
              cwd: root,
            });
          } finally {
            observer.mock.restore();
          }
          assert.deepEqual(referencedDiagnostics, []);
          assert.equal(result.diagnostics.length, expectedErrors);
          if (expectedErrors) {
            assert.equal(result.diagnostics[0].code, 2322);
            assert.equal(
              result.diagnostics[0].fileName,
              path.join(root, 'main.tsrx'),
            );
          }
          const selectedFile = path.join(root, 'reference', selected);
          const ignoredFile = path.join(root, 'reference', ignored);
          assert.ok(
            referencedFiles.includes(
              selected.endsWith('.tsrx') ? `${selectedFile}.tsx` : selectedFile,
            ),
          );
          assert.ok(
            !referencedFiles.includes(
              ignored.endsWith('.tsrx') ? `${ignoredFile}.tsx` : ignoredFile,
            ),
          );
          assert.equal(fs.readFileSync(ignoredFile, 'utf8'), ignoredSource);
        },
        {
          files: ['./main.tsrx'],
          include: [],
          references: [{ path: './reference' }],
        },
      );
    }
  }
});

test('config discovery does not follow references excluded from extends inheritance', () => {
  withProject(
    {
      'main.tsrx': 'export const count: number = 1;',
      'base.json': JSON.stringify({
        references: [{ path: './unused-reference' }],
      }),
      'unused-reference/tsconfig.json': JSON.stringify({
        files: ['./collision.tsrx'],
        include: [],
      }),
      'unused-reference/collision.tsrx': 'export const count: number = 1;',
      'unused-reference/collision.tsrx.tsx':
        'export const count: string = "unused";',
    },
    root => {
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.deepEqual(result.diagnostics, []);
      assert.ok(result.files.includes(path.join(root, 'main.tsrx')));
      assert.ok(!result.files.some(file => file.includes('unused-reference')));
    },
    { extends: './base.json', files: ['./main.tsrx'], include: [] },
  );
});

test('native discovery respects inherited directory includes and directory exclusions', () => {
  withProject(
    {
      'src/checked.tsrx': "export const count: number = 'check-this';",
      'src/excluded/ignored.tsrx':
        "export const count: number = 'exclude-this';",
      'outside/ignored.tsrx': "export const count: number = 'outside-include';",
    },
    root => {
      fs.mkdirSync(path.join(root, 'config'));
      fs.writeFileSync(
        path.join(root, 'config/base.json'),
        JSON.stringify({
          include: ['../src'],
          exclude: ['../src/excluded'],
        }),
      );
      const compilerOptions = JSON.parse(
        fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
      ).compilerOptions;
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './config/base.json', compilerOptions }),
      );
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 2322);
      assert.equal(
        result.diagnostics[0].fileName,
        path.join(root, 'src/checked.tsrx'),
      );
      assert.ok(
        !result.files.some(
          file =>
            file.startsWith(path.join(root, 'src/excluded')) ||
            file.startsWith(path.join(root, 'outside')),
        ),
      );
    },
  );
});

test('custom project checks its selected roots beside a broader tsconfig', () => {
  withProject(
    {
      'selected.tsrx': 'export const valid = 1;',
      'unselected.tsrx': 'export const Broken = () => <div></span>;',
    },
    root => {
      const compilerOptions = JSON.parse(
        fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
      ).compilerOptions;
      fs.writeFileSync(
        path.join(root, 'custom.json'),
        JSON.stringify({
          compilerOptions,
          files: ['./selected.tsrx'],
          include: [],
        }),
      );
      const result = checkOctaneProject({ project: 'custom.json', cwd: root });
      assert.deepEqual(result.diagnostics, []);
      assert.ok(result.files.includes(path.join(root, 'selected.tsrx')));
      assert.ok(!result.files.includes(path.join(root, 'unselected.tsrx')));
    },
  );
});

test('BOM JSONC and dangling symlinks do not hide authored type errors', () => {
  withProject(
    { 'z.tsrx': "export const count: number = 'must-check';" },
    root => {
      fs.symlinkSync(path.join(root, 'absent'), path.join(root, 'a-link'));
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        '\uFEFF{\n// authored config\n"files": ["./z.tsrx"],\n"compilerOptions": {"strict":true,"types":[]},\n}\n',
      );
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 2322);
      assert.equal(result.diagnostics[0].fileName, path.join(root, 'z.tsrx'));
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        '{"include":["./**/*.tsrx"],"compilerOptions":{"types":[]}}',
      );
      assert.equal(
        checkOctaneProject({ project: 'tsconfig.json', cwd: root })
          .diagnostics[0].code,
        2322,
      );
    },
  );
});

test('native config diagnostics retain authored JSONC positions after projection', () => {
  withProject({ 'main.tsrx': 'export const valid = 1;' }, root => {
    const config =
      '{\n  "files": ["./main.tsrx"], "compilerOptions": {\n    "target": "invalid-target", "types": []\n  }\n}\n';
    fs.writeFileSync(path.join(root, 'tsconfig.json'), config);
    const result = checkOctaneProject({ project: 'tsconfig.json', cwd: root });
    const diagnostic = result.diagnostics.find(
      diagnostic => diagnostic.code === 6046,
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.fileName, path.join(root, 'tsconfig.json'));
    assert.equal(diagnostic.line, 3);
    assert.ok(
      config.slice(diagnostic.pos, diagnostic.end).includes('invalid-target'),
    );
  });
});

test('CLI checks actual programs and rejects unsupported or check-suppressing flags', () => {
  withProject(
    { 'main.tsrx': "export const count: number = 'invalid';" },
    root => {
      let output = '';
      const io = {
        cwd: root,
        stdout: text => {
          output += text;
        },
        stderr: text => {
          output += text;
        },
      };
      assert.equal(
        runOctaneTypecheck(
          [
            '--project',
            'tsconfig.json',
            '--noEmit',
            '--strict',
            '--pretty',
            'false',
          ],
          io,
        ),
        1,
      );
      assert.match(output, /main\.tsrx\(1,\d+\): error TS2322/u);
      output = '';
      assert.equal(runOctaneTypecheck(['--watch'], io), 1);
      assert.match(output, /Unsupported Octane typecheck option --watch/u);
      output = '';
      assert.equal(runOctaneTypecheck(['--skipLibCheck'], io), 1);
      assert.match(output, /incompatible with full Octane typechecking/u);
    },
  );
});

// These tests must exercise the native --api path. Do not replace a missing
// Effect diagnostic with CLI scraping or a synthesized projection diagnostic.
for (const severity of ['error', 'warning']) {
  test(`Effect tsrs reports authored floatingEffect as ${severity} through the real API`, t => {
    const source =
      "import * as Effect from 'effect/Effect';\n/* 🐈 */ Effect.succeed(42);\nexport const App = () => <div>Native</div>;\n";
    withProject({ 'main.tsrx': source }, root => {
      const configFile = path.join(root, 'tsconfig.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.compilerOptions.plugins = [
        {
          name: '@effect/language-service',
          diagnostics: true,
          diagnosticSeverity: { floatingEffect: severity },
        },
      ];
      fs.writeFileSync(configFile, JSON.stringify(config));
      const before = fs.readdirSync(root);
      let nativeDiagnostic;
      const createSnapshot = Object.getOwnPropertyDescriptor(
        API.prototype,
        'createSnapshot',
      ).get;
      const observer = t.mock.getter(
        API.prototype,
        'createSnapshot',
        function () {
          const create = createSnapshot.call(this);
          return options => {
            const snapshot = create(options);
            nativeDiagnostic = snapshot
              .getConfiguredProject(options.openProjects[0])
              ?.program.getSemanticDiagnostics()
              .find(info => info.code === 377001);
            assert.ok(
              nativeDiagnostic,
              'The actual native getSemanticDiagnostics must return floatingEffect (377001)',
            );
            return snapshot;
          };
        },
      );
      const write = t.mock.method(fs, 'writeFileSync', () => {
        assert.fail('Octane typechecking must not write host files');
      });
      const mkdir = t.mock.method(fs, 'mkdirSync', () => {
        assert.fail('Octane typechecking must not create host directories');
      });
      try {
        const result = checkOctaneProject({
          project: 'tsconfig.json',
          cwd: root,
        });
        const diagnostic = result.diagnostics.find(
          info => info.code === 377001,
        );
        assert.ok(
          diagnostic,
          `Real Effect tsrs semantic diagnostics must include floatingEffect (377001): ${JSON.stringify(result.diagnostics)}`,
        );
        assert.equal(diagnostic.origin, 'typescript');
        assert.equal(diagnostic.category, severity);
        assert.equal(diagnostic.fileName, path.join(root, 'main.tsrx'));
        assert.equal(diagnostic.line, 2);
        assert.equal(
          diagnostic.column,
          source.split('\n')[1].indexOf('Effect') + 1,
        );
        assert.ok(
          source
            .slice(diagnostic.pos, diagnostic.end)
            .includes('Effect.succeed'),
        );
        assert.equal(diagnostic.source, nativeDiagnostic.source);
        assert.equal(typeof diagnostic.source, 'string');
        assert.ok(diagnostic.source.length > 0);
        assert.ok(
          formatOctaneDiagnostic(diagnostic, root).includes(
            `${severity} ${diagnostic.source}377001:`,
          ),
        );
        let output = '';
        const status = runOctaneTypecheck(['--project', 'tsconfig.json'], {
          cwd: root,
          stdout: text => {
            output += text;
          },
          stderr: text => {
            output += text;
          },
        });
        assert.equal(status, severity === 'error' ? 1 : 0, output);
        assert.match(output, /main\.tsrx\(2,\d+\):/u);
        assert.ok(output.includes(`${severity} ${diagnostic.source}377001:`));
        assert.doesNotMatch(output, /\.tsrx\.tsx|\.octane-typecheck-/u);
        assert.deepEqual(fs.readdirSync(root), before);
        assert.equal(
          fs.readFileSync(path.join(root, 'main.tsrx'), 'utf8'),
          source,
        );
        assert.equal(
          fs.readFileSync(configFile, 'utf8'),
          JSON.stringify(config),
        );
      } finally {
        observer.mock.restore();
        write.mock.restore();
        mkdir.mock.restore();
      }
    });
  });
}

test('real Effect API does not report floatingEffect for an assigned Effect', () => {
  withProject(
    {
      'main.tsrx':
        "import * as Effect from 'effect/Effect';\nexport const selected = Effect.succeed(42);\nexport const App = () => <div>Native</div>;\n",
    },
    root => {
      const configFile = path.join(root, 'tsconfig.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.compilerOptions.plugins = [
        {
          name: '@effect/language-service',
          diagnostics: true,
          diagnosticSeverity: { floatingEffect: 'error' },
        },
      ];
      fs.writeFileSync(configFile, JSON.stringify(config));
      const result = checkOctaneProject({
        project: 'tsconfig.json',
        cwd: root,
      });
      assert.deepEqual(result.diagnostics, []);
      assert.ok(result.files.includes(path.join(root, 'main.tsrx')));
    },
  );
});

test('diagnostic formatting keeps custom native sources and related information', () => {
  const diagnostic = {
    fileName: '/app/main.tsrx',
    pos: 0,
    end: 1,
    line: 1,
    column: 1,
    code: 377001,
    source: 'effect',
    category: 'warning',
    origin: 'typescript',
    text: 'Floating Effect',
    relatedInformation: [
      {
        fileName: '/app/Component.tsrx',
        pos: 0,
        end: 1,
        line: 1,
        column: 1,
        code: 2322,
        category: 'message',
        origin: 'typescript',
        text: 'Authored reference',
      },
    ],
  };
  assert.equal(
    formatOctaneDiagnostic(diagnostic, '/app'),
    'main.tsrx(1,1): warning effect377001: Floating Effect\n  Component.tsrx(1,1): message TS2322: Authored reference',
  );
});
