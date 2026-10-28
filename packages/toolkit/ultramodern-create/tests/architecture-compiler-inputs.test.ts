import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { assertCompilerArchitecture } from '../src/ultramodern-workspace/validation/architecture';
import { createWorkspaceValidationContract } from '../src/ultramodern-workspace/workspace-validation-contract';

const require = createRequire(import.meta.url);

function fixture(renderer: 'react' | 'solid' | 'octane' = 'solid') {
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'um-compiler-inputs-'),
  );
  const contract = createWorkspaceValidationContract(
    'compiler-inputs',
    false,
    [],
  );
  contract.apps[0].renderer = renderer;
  const appPath = contract.apps[0].path;
  const write = (relativePath: string, source: string) => {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  write(
    'package.json',
    JSON.stringify({ name: 'compiler-inputs', type: 'module' }),
  );
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { allowJs: true, jsx: 'preserve' } }),
  );
  write(`${appPath}/src/index.ts`, 'export const authored = true;');
  const compilerPath = path.join(root, 'node_modules/@typescript/native');
  fs.mkdirSync(path.dirname(compilerPath), { recursive: true });
  fs.symlinkSync(
    path.dirname(require.resolve('typescript/package.json')),
    compilerPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return {
    root,
    appPath,
    contract,
    write,
    validate: () => assertCompilerArchitecture(root, contract),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const generatedDirectories = [
  'dist',
  'dist-cloudflare',
  'build',
  '.output',
  '.modern',
  '.modern-js',
  '.modernjs',
  '.mf',
];

for (const renderer of ['solid', 'octane'] as const) {
  test(`${renderer} application validation ignores package-root build output`, () => {
    const workspace = fixture(renderer);
    try {
      assert.doesNotThrow(workspace.validate);
      for (const directory of generatedDirectories) {
        const output = workspace.write(
          `${workspace.appPath}/${directory}/nested/bundle.js`,
          "import React from 'react'; export default React;",
        );
        assert.doesNotThrow(workspace.validate, directory);
        fs.rmSync(output);
      }
    } finally {
      workspace.cleanup();
    }
  });
}

for (const renderer of ['solid', 'octane'] as const) {
  test(`${renderer} authored source is checked recursively even in output-named source folders`, () => {
    const workspace = fixture(renderer);
    try {
      for (const directory of ['feature/nested', ...generatedDirectories]) {
        const source = workspace.write(
          `${workspace.appPath}/src/${directory}/foreign.ts`,
          "import 'react';",
        );
        assert.throws(
          workspace.validate,
          /renderer source profile.*Application shell-super-app imports foreign renderer module react.*src\//u,
          directory,
        );
        fs.rmSync(source);
      }
      // Authored code outside src and root configuration files are still inputs.
      for (const relativePath of [
        'shared/nested/foreign.ts',
        'modern.config.ts',
      ]) {
        const source = workspace.write(
          `${workspace.appPath}/${relativePath}`,
          "import 'react';",
        );
        assert.throws(
          workspace.validate,
          /renderer source profile/u,
          relativePath,
        );
        fs.rmSync(source);
      }
    } finally {
      workspace.cleanup();
    }
  });

  test(`${renderer} symlinked application retains its authored-source ownership`, () => {
    const workspace = fixture(renderer);
    try {
      const appDirectory = path.join(workspace.root, workspace.appPath);
      const packageDirectory = path.join(workspace.root, 'linked-package');
      fs.renameSync(appDirectory, packageDirectory);
      fs.symlinkSync(
        packageDirectory,
        appDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      workspace.write(
        `${workspace.appPath}/node_modules/vendor/index.js`,
        "import 'react';",
      );
      workspace.write(`${workspace.appPath}/dist/bundle.js`, "import 'react';");
      assert.doesNotThrow(workspace.validate);
      workspace.write(
        `${workspace.appPath}/src/nested/foreign.ts`,
        "import 'react';",
      );
      assert.throws(
        workspace.validate,
        /renderer source profile.*Application shell-super-app imports foreign renderer module react.*apps\/shell-super-app\/src\/nested\/foreign.ts:1:1/u,
      );
    } finally {
      workspace.cleanup();
    }
  });
}

test('all supported source extensions remain renderer evidence', () => {
  const workspace = fixture();
  try {
    for (const extension of [
      'cjs',
      'cts',
      'js',
      'jsx',
      'mjs',
      'mts',
      'ts',
      'tsx',
    ]) {
      const source = workspace.write(
        `${workspace.appPath}/src/nested/foreign.${extension}`,
        "import 'react';",
      );
      assert.throws(workspace.validate, /renderer source profile/u, extension);
      fs.rmSync(source);
    }
  } finally {
    workspace.cleanup();
  }
});

test('compiler inputs preserve existing thin-shell and routing diagnostics', () => {
  const workspace = fixture('react');
  try {
    assert.doesNotThrow(workspace.validate);
    const cases: Array<[string, RegExp]> = [
      [
        "import { raw } from '@compiler-inputs/catalog/src/private';",
        /structural thin-shell workspace-package-source-import/u,
      ],
      [
        "import '../../../../verticals/catalog/src/private';",
        /structural thin-shell vertical-directory-side-effect-import/u,
      ],
      [
        'export const env = process.env.API_URL;',
        /framework config API direct-process-env-access/u,
      ],
      [
        "export const navigate = () => window.location.assign('/other');",
        /shell routing window-location-navigation/u,
      ],
      [
        "export const load = () => loadRemote('catalog/Widget');",
        /module federation native loading/u,
      ],
    ];
    for (const [source, diagnostic] of cases) {
      const file = workspace.write(
        `${workspace.appPath}/src/routes/nested/invalid.ts`,
        source,
      );
      assert.throws(workspace.validate, diagnostic, source);
      fs.rmSync(file);
    }
    workspace.write(
      `${workspace.appPath}/module-federation.config.ts`,
      'export default createModuleFederationConfig({ bridge: { enableBridgeRouter: true } });',
    );
    assert.throws(workspace.validate, /module federation bridge capability/u);
  } finally {
    workspace.cleanup();
  }
});

test('compiler inputs preserve the federated host implementation boundary', () => {
  const workspace = fixture('react');
  try {
    workspace.contract.federatedCompositionPolicy.hosts.push({
      id: 'shell-super-app',
      srcDir: `${workspace.appPath}/src`,
      remotes: [
        {
          id: 'catalog',
          directory: 'verticals/catalog',
          packageName: '@compiler-inputs/catalog',
        },
      ],
    });
    assert.doesNotThrow(workspace.validate);
    workspace.write(
      `${workspace.appPath}/src/nested/invalid.ts`,
      "import '@compiler-inputs/catalog';",
    );
    assert.throws(
      workspace.validate,
      /federated composition remote-runtime-package-import/u,
    );
  } finally {
    workspace.cleanup();
  }
});

test('installed dependency code is not attributed to the native application renderer', () => {
  const workspace = fixture();
  try {
    assert.doesNotThrow(workspace.validate);
    workspace.write(
      `${workspace.appPath}/node_modules/vendor/index.js`,
      "import React from 'react'; export default React;",
    );
    assert.doesNotThrow(workspace.validate);
  } finally {
    workspace.cleanup();
  }
});
