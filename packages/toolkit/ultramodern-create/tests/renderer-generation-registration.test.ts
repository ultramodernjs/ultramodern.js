import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as actualModule from 'node:module' with { rstest: 'importActual' };
import os from 'node:os';
import path from 'node:path';
import type {
  NativeRendererAdapter,
  RendererAppSourceOptions,
  RendererBuildProfile,
} from '@modern-js/renderer-core/adapter';
import {
  registeredRenderers,
  resolveCandidateRendererProfile,
  resolveRendererRouterFrameworks,
} from '@modern-js/ultramodern-app-tools';
import { shellApp } from '../src/ultramodern-workspace/descriptors';
import {
  getRendererGenerationProfile,
  isApplicationRenderer,
} from '../src/ultramodern-workspace/renderer-profile';
import type { WorkspaceApp } from '../src/ultramodern-workspace/types';
import { writeApp } from '../src/ultramodern-workspace/write-app';
import { snapshotWorkspace } from './helpers/workspace-kit';

const paper = rstest.hoisted(() => {
  const candidate = {
    renderer: 'octane',
    status: 'preview',
    protocolVersion: 1,
    minimumNode: '26.12.0',
    hmr: {
      editedBoundary: 'may-reset',
      unaffectedComponents: 'preserved',
      document: 'preserved',
      roots: 'single',
      cleanup: 'exactly-once',
    },
    compiler: { name: '@paper/compiler', version: '4.2.1' },
    hydration: { name: 'paper-runtime', version: '4.2.3' },
    router: {
      name: '@modern-js/renderer-paper/router',
      version: '1.2.4',
      coreName: '@paper/router-core',
      coreVersion: '5.1.0',
    },
    sourceExtensions: ['.tsx'],
    jsxImportSource: 'paper-runtime',
    dependencies: {
      'paper-runtime': '4.2.3',
      '@paper/router-core': '5.1.0',
    },
    capabilities: {
      worker: false,
      moduleFederation: false,
      rsc: false,
      ssg: false,
      i18n: false,
      svgComponent: false,
    },
  } satisfies RendererBuildProfile;
  const unusedNativeRuntime = () => {
    throw new Error('Cold generation must not evaluate native runtime hooks.');
  };
  const sourceOptions: RendererAppSourceOptions[] = [];
  const adapter: NativeRendererAdapter = {
    name: 'octane',
    kind: 'native',
    profile: candidate,
    routerFrameworks: ['paper'],
    runtime: {
      package: 'paper-runtime',
      bootstrap: '@modern-js/renderer-paper',
      entryClient: '@modern-js/renderer-paper/entry-client',
      entryServer: '@modern-js/renderer-paper/entry-server',
      router: '@modern-js/renderer-paper/router',
      manifest: '@modern-js/renderer-paper/manifest',
    },
    worker: { nativeDocuments: true, rsc: false },
    compiler: unusedNativeRuntime,
    artifacts: {
      clientManifestFile: unusedNativeRuntime,
      validateClientManifest: async () => unusedNativeRuntime(),
      isMutableDevelopmentAsset: unusedNativeRuntime,
    },
    create: {
      dependencies: selected => ({
        frameworkDependencies: [
          '@modern-js/renderer-core',
          '@modern-js/renderer-paper',
        ],
        dependencies: { ...selected.dependencies },
        devDependencies: {
          [selected.compiler.name]: selected.compiler.version,
        },
        typecheckCommand: 'paper-check --project tsconfig.json',
        tsconfig: {
          paper: { compiler: 'paper/compiler', platform: 'web' },
        },
      }),
      generateAppSources(options) {
        sourceOptions.push(options);
        return {
          sourceExtension: options.sourceExtension,
          jsxImportSource: options.jsxImportSource,
          artifacts: [
            {
              path: 'src/routes/layout.tsx',
              content: `import { Outlet } from '@modern-js/renderer-paper/router';

export default function Layout() {
  return <main data-renderer="paper"><Outlet /></main>;
}
`,
            },
            {
              path: 'src/routes/page.tsx',
              content: `import { createAtom } from 'paper-runtime';

export default function Page() {
  const count = createAtom(0);
  return <button onClick={() => count.update(value => value + 1)}>${options.title}: {count.read()}</button>;
}
`,
            },
          ],
        };
      },
    },
  };
  return { candidate, adapter, sourceOptions };
});

// Install a foreign renderer in the Octane package's adapter slot; generation
// must follow the adapter's profile and create support alone.
rstest.mock('node:module', () => {
  const createRequire: typeof actualModule.createRequire = anchor => {
    const require = actualModule.createRequire(anchor);
    return Object.assign(
      (id: string) =>
        id === '@modern-js/renderer-octane/plugin'
          ? { rendererAdapter: paper.adapter }
          : require(id),
      require,
    ) as NodeJS.Require;
  };
  return {
    ...actualModule,
    createRequire,
    default: { ...actualModule, createRequire },
  };
});

test('a foreign renderer adapter uses the public SDK resolver and common writer', () => {
  const renderer = 'octane';
  assert.deepEqual(registeredRenderers, ['react', 'solid', 'octane']);
  assert.deepEqual(resolveCandidateRendererProfile(renderer), paper.candidate);
  assert.deepEqual(resolveRendererRouterFrameworks(renderer), ['paper']);
  assert.ok(isApplicationRenderer(renderer));
  const profile = getRendererGenerationProfile(renderer);
  assert.equal(profile.renderer, 'octane');
  assert.equal(profile.profile.renderer, 'octane');
  assert.deepEqual(profile.profile.compiler, {
    name: '@paper/compiler',
    version: '4.2.1',
  });
  assert.deepEqual(profile.profile.hydration, {
    name: 'paper-runtime',
    version: '4.2.3',
  });
  assert.deepEqual(profile.profile.router, {
    name: '@modern-js/renderer-paper/router',
    version: '1.2.4',
    coreName: '@paper/router-core',
    coreVersion: '5.1.0',
  });
  assert.equal(profile.sourceExtension, '.tsx');
  assert.equal(profile.jsxImportSource, 'paper-runtime');
  assert.deepEqual(profile.routerFrameworks, ['paper']);

  const tempRoot = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'um-generation-registration-',
    ),
  );
  const targetDir = path.join(tempRoot, 'workspace');
  const app: WorkspaceApp = {
    ...shellApp,
    renderer,
    displayName: 'Paper Shell',
    rendererProfile: profile.profile,
    rendererCapabilities: profile.capabilities,
  };
  try {
    writeApp(
      targetDir,
      'paper-workspace',
      app,
      { strategy: 'workspace', modernPackageVersion: '3.8.3' },
      false,
    );
    const files = snapshotWorkspace(targetDir);
    const directory = app.directory;
    const manifest = JSON.parse(files[`${directory}/package.json`]!);
    const tsconfig = JSON.parse(files[`${directory}/tsconfig.json`]!);
    assert.equal(
      manifest.dependencies['@modern-js/renderer-paper'],
      'workspace:*',
    );
    assert.equal(
      manifest.dependencies['@modern-js/renderer-core'],
      'workspace:*',
    );
    assert.equal(manifest.dependencies['paper-runtime'], '4.2.3');
    assert.equal(manifest.dependencies['@paper/router-core'], '5.1.0');
    assert.equal(manifest.devDependencies['@paper/compiler'], '4.2.1');
    assert.equal(
      manifest.scripts.typecheck,
      'paper-check --project tsconfig.json',
    );
    assert.equal(manifest.engines.node, '>=26.13.1');
    assert.equal(tsconfig.compilerOptions.jsx, 'preserve');
    assert.equal(tsconfig.compilerOptions.jsxImportSource, 'paper-runtime');
    assert.deepEqual(tsconfig.compilerOptions.types, []);
    assert.deepEqual(tsconfig.paper, {
      compiler: 'paper/compiler',
      platform: 'web',
    });
    assert.equal(
      files[`${directory}/src/modern-app-env.d.ts`],
      `/// <reference types="@modern-js/ultramodern-app-tools/types" />
/// <reference types="paper-runtime" />
`,
    );
    assert.equal(
      files[`${directory}/src/routes/layout.tsx`],
      `import { Outlet } from '@modern-js/renderer-paper/router';

export default function Layout() {
  return <main data-renderer="paper"><Outlet /></main>;
}
`,
    );
    assert.equal(
      files[`${directory}/src/routes/page.tsx`],
      `import { createAtom } from 'paper-runtime';

export default function Page() {
  const count = createAtom(0);
  return <button onClick={() => count.update(value => value + 1)}>Paper Shell: {count.read()}</button>;
}
`,
    );
    assert.match(
      files[`${directory}/modern.config.ts`]!,
      /renderer:\s*["']octane["']/u,
    );
    assert.match(
      files[`${directory}/modern.config.ts`]!,
      /source:\s*\{\s*mainEntryName:\s*'main'\s*\}/u,
    );
    assert.deepEqual(paper.sourceOptions, [
      {
        appId: app.id,
        title: 'Paper Shell',
        entryName: 'main',
        sourceExtension: '.tsx',
        jsxImportSource: 'paper-runtime',
        capabilities: { ssr: true, federation: false },
      },
    ]);
    for (const [relativePath, content] of Object.entries(files)) {
      assert.doesNotMatch(
        content,
        /(?:solid-js|@solidjs\/|@octanejs\/|from 'octane|@modern-js\/renderer-(?:solid|octane))/u,
        relativePath,
      );
    }
  } finally {
    paper.sourceOptions.length = 0;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a misspelled renderer is rejected before the common writer creates output', () => {
  const tempRoot = fs.mkdtempSync(
    path.join(
      process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
      'um-generation-unknown-',
    ),
  );
  const targetDir = path.join(tempRoot, 'workspace');
  const app: WorkspaceApp = { ...shellApp };
  Reflect.set(app, 'renderer', 'paepr');
  try {
    assert.equal(isApplicationRenderer('paepr'), false);
    assert.throws(
      () =>
        writeApp(
          targetDir,
          'paper-workspace',
          app,
          { strategy: 'workspace', modernPackageVersion: '3.8.3' },
          false,
        ),
      /requires a renderer resolved from modern.config/u,
    );
    assert.equal(fs.existsSync(targetDir), false);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    assert.deepEqual(paper.sourceOptions, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
