import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../create/src/template';
import { shellApp } from '../src/ultramodern-workspace/descriptors';
import {
  createAppPackage,
  createRootPackageJson,
} from '../src/ultramodern-workspace/package-json';
import { ULTRAMODERN_WORKSPACE_POLICY } from '../src/ultramodern-workspace/policy';
import type { ResolvedPackageSource } from '../src/ultramodern-workspace/types';
import {
  BOOTSTRAP_RELEASE_AGE_EXCEPTIONS,
  CLOUDFLARE_WORKERS_TYPES_VERSION,
  MINIFLARE_VERSION,
  WORKERD_VERSION,
} from '../src/ultramodern-workspace/versions';

const source: ResolvedPackageSource = {
  strategy: 'workspace',
  modernPackageVersion: '3.8.3',
};

test('workspace manifest producers emit the reviewed toolchain and dependency cohort', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-pin-contract-'));
  try {
    const writeManifest = (name: string, value: unknown) => {
      const filename = path.join(root, name);
      fs.writeFileSync(filename, JSON.stringify(value));
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    };
    const workspace = writeManifest(
      'package.json',
      createRootPackageJson('cohort', source),
    );
    const app = writeManifest(
      'app.json',
      createAppPackage('cohort', shellApp, source, true),
    );
    assert.equal(workspace.packageManager, 'pnpm@12.21.0');
    assert.equal(app.engines.node, '>=26.13.1');
    for (const manifest of [workspace, app]) {
      assert.equal(manifest.devDependencies['@effect/tsgo'], '0.69.0');
      assert.equal(manifest.devDependencies.tsrs, '0.25.0-ts7.1.0-beta');
      assert.equal(manifest.devDependencies.typescript, '7.0.2');
      assert.equal(manifest.devDependencies['@types/node'], '26.6.6');
      assert.equal(manifest.devDependencies.wrangler, '4.162.0');
      assert.equal(Object.hasOwn(manifest.devDependencies, 'workerd'), false);
      assert.equal(
        Object.hasOwn(manifest.dependencies ?? {}, 'workerd'),
        false,
      );
      assert.equal(
        manifest.dependencies?.effect ?? manifest.devDependencies.effect,
        '4.1.4',
      );
    }
    assert.equal(workspace.devDependencies.miniflare, '5.20261113.0-beta');
    assert.equal(workspace.devDependencies.oxlint, '1.93.0');
    assert.equal(workspace.devDependencies.oxfmt, '0.78.0');
    assert.equal(
      workspace.devDependencies.ultracite,
      'npm:@bleedingdev/ultracite@8.2.2',
    );
    assert.equal(app.dependencies['@tanstack/react-router'], '1.170.46');
    assert.equal(app.dependencies.i18next, '27.1.2');
    assert.equal(app.dependencies.react, '19.3.1');
    assert.equal(app.dependencies['react-dom'], '19.3.1');
    assert.equal(app.devDependencies.tailwindcss, '^4.3.5');
    assert.equal(app.devDependencies['@rsbuild/plugin-tailwindcss'], '^2.0.3');
    assert.equal(app.devDependencies['zephyr-rspack-plugin'], '1.8.0');
    assert.equal(workspace.devDependencies['zephyr-agent'], '1.8.0');
    assert.equal(app.dependencies['@modern-js/runtime'], 'workspace:*');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(
  (['app', 'mcp-apps'] as const).flatMap(template =>
    [false, true].flatMap(mf =>
      [false, true].map(isSubproject => ({ template, mf, isSubproject })),
    ),
  ),
)(
  'native create template renders $template mf=$mf subproject=$isSubproject',
  options => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-native-template-'));
    try {
      createProject(root, {
        ...options,
        packageName: 'cohort-app',
        version: '3.8.3',
        noAgentsMd: true,
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
      );
      assert.equal(manifest.engines.node, '>=26.13.1');
      assert.equal(manifest.dependencies.react, '^19.3.1');
      assert.equal(manifest.dependencies['react-dom'], '^19.3.1');
      assert.equal(manifest.devDependencies.typescript, '7.0.2');
      assert.equal(manifest.devDependencies['@types/node'], '^26.6.6');
      assert.equal(manifest.devDependencies['@types/react'], '^19.3.0');
      assert.equal(manifest.devDependencies['@types/react-dom'], '^19.3.0');
      assert.equal(
        manifest.devDependencies.rstack,
        options.isSubproject ? undefined : '0.9.1',
      );
      if (options.mf) {
        assert.equal(
          manifest.dependencies['@module-federation/enhanced'],
          '2.9.3',
        );
        assert.equal(
          manifest.devDependencies['@module-federation/modern-js-v3'],
          '2.9.3',
        );
      }
      if (options.template === 'mcp-apps') {
        assert.equal(
          manifest.dependencies['@modelcontextprotocol/server'],
          '2.4.0',
        );
        assert.equal(
          manifest.dependencies['@modelcontextprotocol/ext-apps'],
          '2.0.4',
        );
        assert.equal(manifest.dependencies.zod, '^4.6.7');
      }
      if (!options.isSubproject) {
        assert.equal(
          fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(),
          '26.13.1',
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('Cloudflare metadata records the nested Miniflare runtime without overriding its owner', () => {
  assert.equal(MINIFLARE_VERSION, '5.20261113.0-beta');
  assert.equal(WORKERD_VERSION, '1.20261113.1');
  assert.equal(CLOUDFLARE_WORKERS_TYPES_VERSION, '5.20261115.1');
  assert.equal(
    Object.hasOwn(ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides, 'workerd'),
    false,
  );
});

test('generated dependency policy applies current fixes only within each reviewed major', () => {
  const overrides = ULTRAMODERN_WORKSPACE_POLICY.pnpm.overrides;
  for (const [selector, target] of Object.entries({
    'axios@>=1.0.0 <1.21.1': '1.21.1',
    'brace-expansion@>=5.0.0 <5.0.13': '5.0.13',
    'tar@>=7.0.0 <7.5.23': '7.5.23',
    'undici@>=8.0.0 <8.12.4': '8.12.4',
    'seroval@>=1.0.0 <1.8.1': '1.8.1',
    'seroval-plugins@>=1.0.0 <1.8.0': '1.8.0',
    'qs@>=6.0.0 <6.17.1': '6.17.1',
    'smol-toml@>=1.0.0 <1.9.1': '1.9.1',
    'dompurify@>=3.0.0 <3.4.18': '3.4.18',
    'serialize-javascript@>=7.0.0 <7.1.4': '7.1.4',
    'ws@>=8.0.0 <8.23.0': '8.23.0',
    'isomorphic-ws@5.0.0>ws:peer': '*',
    'follow-redirects@>=1.0.0 <1.16.3': '1.16.3',
    'postcss-selector-parser@>=7.0.0 <7.2.1': '7.2.1',
    'react-router@>=8.0.0 <8.5.1': '8.5.1',
  })) {
    assert.equal(
      Object.entries(overrides).find(([key]) => key === selector)?.[1],
      target,
    );
  }
  assert.equal(overrides['undici@>=7.0.0 <7.30.1'], '7.30.1');
  assert.equal(
    overrides['braces@>=3.0.0 <3.0.4'],
    'npm:@bleedingdev/braces@3.0.4',
  );
  assert.equal(overrides['body-parser@>=2.0.0 <2.4.0'], '2.4.0');
});

test('compiler bootstrap exemptions include Windows ARM64 without broadening release policy', () => {
  assert.equal(BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.length, 19);
  assert(
    BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.includes(
      '@tsrs/win32-arm64@0.25.0-ts7.1.0-beta',
    ),
  );
  assert(
    BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.includes(
      '@effect/tsgo-win32-arm64@0.69.0',
    ),
  );
  assert(BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.includes('effect@4.1.4'));
  assert(
    BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.includes('@effect/opentelemetry@4.1.4'),
  );
  assert(
    BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.every(
      selector => !/[*>^]/u.test(selector),
    ),
  );
  assert(
    !BOOTSTRAP_RELEASE_AGE_EXCEPTIONS.some(selector =>
      /0\.21\.0|0\.67\.0|4\.0\.7/u.test(selector),
    ),
  );
});
