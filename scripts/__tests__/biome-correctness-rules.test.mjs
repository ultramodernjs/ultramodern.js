import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(import.meta.url);
const {
  FORK_OWNED_PACKAGE_ROOTS,
} = require('../ultramodern-boundary-check/divergence.js');
const biomeBin = path.join(repoRoot, 'node_modules/.bin/biome');
const biomeConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'biome.json'), 'utf8'),
);

const PROBE_SOURCE = `import { readFile } from 'node:fs';
// @ts-ignore
const unused = 1;
export const value = 2;
`;
const PROBE_RULES = [
  'lint/correctness/noUnusedImports',
  'lint/correctness/noUnusedVariables',
  'lint/suspicious/noTsIgnore',
];

// biome.json resolves GritQL plugins relative to itself, so the probe root
// needs every plugin file the config (or any override) references.
const biomePluginPaths = [
  ...(biomeConfig.plugins ?? []),
  ...biomeConfig.overrides.flatMap(override => override.plugins ?? []),
];

// Lints probe files laid out at repository-relative paths so biome.json
// overrides resolve exactly as they do for `pnpm lint`.
const lintProbes = (relativePaths, source = PROBE_SOURCE) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biome-rules-'));
  try {
    for (const relativePath of ['biome.json', ...biomePluginPaths]) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, relativePath), target);
    }
    for (const relativePath of relativePaths) {
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    const result = spawnSync(
      biomeBin,
      ['lint', '--vcs-enabled=false', '--reporter=github', '.'],
      { cwd: root, encoding: 'utf8' },
    );
    const rulesByFile = new Map(relativePaths.map(file => [file, new Set()]));
    for (const line of `${result.stdout}${result.stderr}`.split('\n')) {
      const match = /title=([^,]+),file=([^,]+),/.exec(line);
      if (match) {
        rulesByFile
          .get(
            path.isAbsolute(match[2])
              ? path.relative(fs.realpathSync(root), match[2])
              : match[2],
          )
          ?.add(match[1]);
      }
    }
    return rulesByFile;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('the code formatter preserves Changeset front matter and generated YAML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biome-format-scope-'));
  try {
    fs.writeFileSync(
      path.join(root, 'biome.json'),
      JSON.stringify({
        $schema: biomeConfig.$schema,
        formatter: biomeConfig.formatter,
        javascript: biomeConfig.javascript,
      }),
    );
    fs.mkdirSync(path.join(root, '.changeset'));
    const changeset =
      "---\n'@modern-js/app-tools': patch\n---\n\nFix routing.\n";
    const yaml = "packages:\n  - 'packages/*'\n";
    fs.writeFileSync(path.join(root, '.changeset/release.md'), changeset);
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), yaml);
    fs.writeFileSync(
      path.join(root, 'probe.ts'),
      'export const value={x:1};\n',
    );
    const result = spawnSync(
      biomeBin,
      ['format', '--vcs-enabled=false', '--write', '.'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(root, '.changeset/release.md'), 'utf8'),
      changeset,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
      yaml,
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'probe.ts'), 'utf8'),
      'export const value = { x: 1 };\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unused imports, unused variables and @ts-ignore fail lint in fork-owned code', () => {
  const guarded = [
    'packages/toolkit/ultramodern-create/src/probe.ts',
    'packages/server/bff-effect/src/probe.ts',
    'tests/integration/probe/src/probe.ts',
    'scripts/probe.mjs',
  ];
  const rulesByFile = lintProbes(guarded);
  for (const file of guarded) {
    assert.deepEqual(
      [...rulesByFile.get(file)].sort(),
      PROBE_RULES,
      `${file} must report every correctness rule`,
    );
  }
});

test('module-initialized component factories do not disable the rule in other files', () => {
  const factories = [
    'packages/runtime/federation-runtime/src/module-federation/distributed-ssr.tsx',
    'packages/runtime/i18n-extensions/src/router-navigation/adapter.tsx',
  ];
  const other = 'packages/runtime/federation-runtime/src/probe.tsx';
  const rules = lintProbes(
    [...factories, other],
    `export function createComponent() {
  return function Component() { return <div />; };
}
`,
  );
  for (const file of factories)
    assert(!rules.get(file).has('lint/correctness/noComponentHookFactories'));
  assert(rules.get(other).has('lint/correctness/noComponentHookFactories'));
});

test('upstream-owned packages keep upstream lint rules to stay shrink-only', () => {
  const rulesByFile = lintProbes([
    'packages/runtime/plugin-runtime/src/probe.ts',
  ]);
  assert.deepEqual(
    [...rulesByFile.get('packages/runtime/plugin-runtime/src/probe.ts')],
    [],
  );
});

test('reassigning Module._resolveFilename fails lint in package sources', () => {
  const probe = 'packages/server/bff-core/src/probe.ts';
  const rulesByFile = lintProbes(
    [probe],
    `import Module from 'node:module';
(Module as any)._resolveFilename = () => '';
`,
  );
  assert.deepEqual([...rulesByFile.get(probe)], ['plugin']);
});

test('the upstream-owned override excludes exactly the fork-owned package roots', () => {
  const upstreamOverride = biomeConfig.overrides.find(override =>
    override.includes.includes('packages/**'),
  );
  assert.ok(upstreamOverride, 'biome.json must scope upstream-owned packages');
  assert.deepEqual(
    upstreamOverride.includes.filter(pattern => pattern.startsWith('!')),
    FORK_OWNED_PACKAGE_ROOTS.map(root => `!${root}/**`),
    'Update the biome.json override when FORK_OWNED_PACKAGE_ROOTS changes',
  );
});
