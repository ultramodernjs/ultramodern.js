import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as proto from 'tsrs/proto';

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL(
    '../../packages/solutions/app-tools-extensions/src/native-server-compiler.ts',
    import.meta.url,
  ),
  'utf8',
);
const literal = /const inspectConfig = (`[\s\S]*?`);/u.exec(source)?.[1];
assert.ok(literal);
// Run the actual child-process serializer with a protocol response, not a
// native compiler. Hosted consumer tests cover the real API and DTS process.
const script = vm
  .runInNewContext(literal)
  .replace(/^\s*import .*?;\n/gmu, '')
  .replace(
    'const { API, formatDiagnostics } = await import(pathToFileURL(apiPath).href);',
    'const { API, formatDiagnostics } = mock;',
  )
  .replace(
    'const enums = await import(pathToFileURL(protoPath).href);',
    'const enums = proto;',
  );
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('native config projection retains inherited policy and emits only CLI options', async () => {
  const root = resolve('fixture-app');
  const configFile = join(root, 'config/tsconfig.json');
  let output = '';
  let closed = false;
  class API {
    parseConfigFile() {
      return {
        errors: [],
        fileNames: [join(root, 'api/index.ts')],
        options: {
          target: proto.ScriptTarget.ESNext,
          module: proto.ModuleKind.NodeNext,
          moduleResolution: proto.ModuleResolutionKind.NodeNext,
          jsx: proto.JsxEmit.ReactJSX,
          lib: ['lib.esnext.d.ts'],
          configFilePath: configFile,
          pathsBasePath: join(root, 'config/preset'),
          paths: { '@shared/*': ['../../shared/*'] },
          plugins: [{ name: '@effect/language-service' }],
        },
        // A child config does not repeat inherited plugin options.
        raw: { extends: './preset/base.json' },
      };
    }
    close() {
      closed = true;
    }
  }
  await new AsyncFunction(
    'process',
    'mock',
    'proto',
    'readFileSync',
    'resolve',
    script,
  )(
    {
      argv: [
        'node',
        'api',
        'proto',
        require.resolve('tsrs/schemas/tsconfig.schema.json'),
        'compiler',
        configFile,
      ],
      stdout: {
        write: text => {
          output += text;
        },
      },
    },
    {
      API,
      formatDiagnostics() {
        throw new Error('Unexpected config error');
      },
    },
    proto,
    readFileSync,
    resolve,
  );
  assert.deepEqual(JSON.parse(output), {
    extends: configFile,
    compilerOptions: {
      target: 'esnext',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      jsx: 'react-jsx',
      lib: ['esnext'],
      paths: { '@shared/*': [join(root, 'shared/*')] },
    },
    files: [join(root, 'api/index.ts')],
  });
  assert.ok(closed);
});
