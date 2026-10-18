import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  cleanConsumerEnv,
  generatedBrowserEntries,
  installedCompiler,
  nativeClientCall,
  strictBrowserConfig,
} from './generated-consumer.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

async function temporary(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'solid-consumer-contract-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('comments and unbound calls do not qualify a generated browser entry', () => {
  assert.equal(
    nativeClientCall(
      '// startNativeClient({});\nexport const irrelevant = true;',
    ),
    undefined,
  );
  assert.equal(
    nativeClientCall('function startNativeClient() {}\nstartNativeClient({});'),
    undefined,
  );
});

test('requires the actual manifest-selected client and matching immutable identity', async () => {
  await temporary(async directory => {
    const generated = path.join(
      directory,
      'node_modules/.modern-js/solid/index',
    );
    await mkdir(generated, { recursive: true });
    await mkdir(path.join(directory, 'dist'));
    await writeFile(
      path.join(directory, 'dist/renderer-build.json'),
      JSON.stringify({
        schema: 'ultramodern-renderer-build',
        version: 2,
        renderer: 'solid',
        entries: { index: { renderer: 'solid', buildId: 'accepted' } },
      }),
    );
    await assert.rejects(
      generatedBrowserEntries(directory),
      /no generated client/,
    );
    const entry = path.join(generated, 'index.ts');
    await writeFile(
      entry,
      'import { startNativeClient } from "@modern-js/renderer-solid/entry-client";\nstartNativeClient({identity: {renderer:"solid", buildId:"old"}});',
    );
    await assert.rejects(generatedBrowserEntries(directory), /identity differ/);
    await writeFile(
      entry,
      'import { startNativeClient } from "@modern-js/renderer-solid/entry-client";\nstartNativeClient({identity: {renderer:"solid", buildId:"accepted"}});',
    );
    await assert.rejects(
      generatedBrowserEntries(directory),
      /has no application/,
    );
    const application = path.join(generated, 'app.client.ts');
    await writeFile(
      application,
      'export default function App() { return "Solid"; }',
    );
    assert.deepEqual(
      await generatedBrowserEntries(directory),
      [application, entry].sort(),
    );
  });
});

test('removes inherited Node hooks from every consumer command', () => {
  const env = cleanConsumerEnv({
    NODE_OPTIONS: '--import=other-checkout.mjs',
    NODE_PATH: '/other/node_modules',
    KEEP: 'yes',
  });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.KEEP, 'yes');
});

test('executes the installed native compiler through its public bin metadata despite private subpath exports', async () => {
  const requireApp = createRequire(path.join(root, 'package.json'));
  assert.throws(() => requireApp.resolve('typescript/bin/tsc'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  const { stdout } = await execute(
    process.execPath,
    [installedCompiler(root), '--version'],
    { env: cleanConsumerEnv(), timeout: 30_000 },
  );
  assert.match(stdout, /Version 7\.0\.2\b/u);
});

test('the authored Solid build diagnostics compile under strict consumer types', async () => {
  await temporary(async directory => {
    const fixture = path.join(root, 'tests/integration/renderer-solid');
    const fixturePackage = JSON.parse(
      await readFile(path.join(fixture, 'package.json'), 'utf8'),
    );
    const toolingPackage = JSON.parse(
      await readFile(
        path.join(
          root,
          'packages/solutions/ultramodern-app-tools/package.json',
        ),
        'utf8',
      ),
    );
    assert.equal(
      fixturePackage.devDependencies['@rsbuild/core'],
      toolingPackage.dependencies['@rsbuild/core'],
      'The consumer must declare the public Rsbuild types used by its diagnostics',
    );
    const tooling = createRequire(
      path.join(root, 'packages/solutions/ultramodern-app-tools/package.json'),
    );
    const rsbuild = path.dirname(tooling.resolve('@rsbuild/core/package.json'));
    const config = path.join(directory, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: path.join(fixture, 'tsconfig.json'),
        compilerOptions: {
          types: ['node'],
          typeRoots: [path.join(fixture, 'node_modules/@types')],
          paths: { '@rsbuild/core': [path.join(rsbuild, 'dist/index.d.ts')] },
        },
        include: [],
        files: [path.join(fixture, 'modern.config.ts')],
      }),
    );
    await execute(process.execPath, [installedCompiler(root), '-p', config], {
      timeout: 30_000,
    });
  });
});

test('the native compiler enforces browser globals, exact options, indexed access and overrides', async () => {
  await temporary(async directory => {
    const source = path.join(directory, 'browser.ts');
    const environment = path.join(directory, 'environment.ts');
    const config = path.join(directory, 'tsconfig.json');
    await writeFile(
      environment,
      'export {};\n// @ts-expect-error Node globals must stay absent.\nprocess.cwd();\n// @ts-expect-error Node globals must stay absent.\nBuffer.from("node");\n',
    );
    await writeFile(
      config,
      JSON.stringify(strictBrowserConfig([source], environment)),
    );
    const compiler = installedCompiler(root);
    const compile = () =>
      execute(process.execPath, [compiler, '-p', config], { timeout: 30_000 });
    await writeFile(
      source,
      'const element: HTMLElement = document.createElement("main");\nelement.textContent = "Solid browser";\n',
    );
    await compile();
    await writeFile(
      source,
      'const exact: { value?: string } = { value: undefined };\nconst indexed: string = ["first"][1];\nclass Base { method() {} }\nclass Derived extends Base { method() {} }\n',
    );
    await assert.rejects(compile(), error => {
      const output = `${error.stdout}${error.stderr}`;
      assert.match(output, /exactOptionalPropertyTypes/);
      assert.match(output, /string \| undefined/);
      assert.match(output, /override/);
      return true;
    });
    await writeFile(
      source,
      'import { value } from "./imported.ts";\nvoid value;',
    );
    await writeFile(
      path.join(directory, 'imported.ts'),
      'export const value = 1;',
    );
    await assert.rejects(compile(), error => {
      assert.match(
        `${error.stdout}${error.stderr}`,
        /allowImportingTsExtensions/,
      );
      return true;
    });
    await writeFile(
      source,
      'const element = document.createElement("div"); void element;',
    );
    await writeFile(
      environment,
      'export {};\ndeclare global { const process: { cwd(): string }; const Buffer: { from(value: string): unknown }; }\n// @ts-expect-error Must fail if Node globals leak.\nprocess.cwd();\n// @ts-expect-error Must fail if Node globals leak.\nBuffer.from("node");',
    );
    await assert.rejects(compile(), error => {
      assert.match(`${error.stdout}${error.stderr}`, /Unused.*ts-expect-error/);
      return true;
    });
    assert.equal(
      JSON.parse(await readFile(config)).compilerOptions.skipLibCheck,
      false,
    );
  });
});

test('forces overlapping loaders instead of counting sequential requests as isolation', async () => {
  const { createSolidConsumerObserver } = await import(
    './generated-observer.mjs'
  );
  const observer = await createSolidConsumerObserver(AbortSignal.timeout(5000));
  try {
    const ids = [observer.requestId(), observer.requestId()];
    observer.pair(ids);
    let firstReleased = false;
    const first = fetch(
      `${observer.env.SOLID_CONSUMER_OBSERVER_URL}/barrier/${ids[0]}`,
      {
        headers: { authorization: observer.env.SOLID_CONSUMER_OBSERVER_NONCE },
      },
    ).then(response => {
      firstReleased = true;
      return response.text();
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(firstReleased, false);
    const second = fetch(
      `${observer.env.SOLID_CONSUMER_OBSERVER_URL}/barrier/${ids[1]}`,
      {
        headers: { authorization: observer.env.SOLID_CONSUMER_OBSERVER_NONCE },
      },
    ).then(response => response.text());
    assert.deepEqual(await Promise.all([first, second]), [
      'released',
      'released',
    ]);
    assert.equal(
      observer.events.filter(event => event.event === 'overlap').length,
      1,
    );
  } finally {
    await observer.close();
  }
});

test('does not count server-only or empty stats as browser package ownership', async () => {
  const { compilationModules } = await import('./generated-bundle.mjs');
  assert.throws(
    () =>
      compilationModules({
        schema: 1,
        compilations: [
          {
            name: 'server',
            modules: [{ nameForCondition: '/solid-js/dist/server.js' }],
          },
        ],
      }),
    /actual client compilation/,
  );
  assert.throws(
    () =>
      compilationModules({
        schema: 1,
        compilations: [{ name: 'client', modules: [] }],
      }),
    /no module resources/,
  );
});
