import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findForcedMajors,
  findOverrideViolations,
  findUnscopedOverrides,
  parseOverrideKey,
  readImporterNames,
  readInstalledManifest,
} from '../check-overrides.mjs';
import { parsePnpmLockfile as parse } from '../lib/parse-pnpm-lockfile.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('workspace lockfile has only live, honoured overrides', () => {
  const lockfileText = readFileSync(
    path.join(repoRoot, 'pnpm-lock.yaml'),
    'utf8',
  );
  assert.deepEqual(
    findOverrideViolations(
      lockfileText,
      readImporterNames(lockfileText, repoRoot),
    ),
    [],
  );
});

test('workspace overrides stay inside the majors their dependents declare', () => {
  const lockfileText = readFileSync(
    path.join(repoRoot, 'pnpm-lock.yaml'),
    'utf8',
  );
  assert.deepEqual(findUnscopedOverrides(parse(lockfileText).overrides), []);
  assert.deepEqual(
    findForcedMajors(lockfileText, readInstalledManifest(repoRoot)),
    [],
  );
});

test('unranged and cross-major override selectors fail', () => {
  assert.deepEqual(
    findUnscopedOverrides({
      diff: '>=9.0.0',
      'uuid@>=13.0.0 <13.0.1': '14.0.2',
      'picomatch@<3': '2.3.2',
      'diff@>=4.0.0 <4.0.4': '4.0.4',
      'minimatch@3>brace-expansion': '1.1.18',
      'nx>brace-expansion': '-',
      'left-pad': 'npm:pad-left@1.0.0',
    }),
    [
      "'diff': an unranged selector forces every diff to >=9.0.0, across majors. " +
        "Write one 'diff@>=<major>.0.0 <<fixed>>' key per affected major.",
      "'uuid@>=13.0.0 <13.0.1': 14.0.2 is outside ^13.0.0, the major this selector replaces. " +
        'Pin a fixed release inside that major, or delete the override.',
      "'picomatch@<3': the selector spans more than one major. Write one key per affected major.",
    ],
  );
});

// Shape of the lockfile when `diff: '>=9.0.0'` forced ts-node's diff@^4.0.1
// onto diff 9, while ws stayed inside the major of its dependents.
const crossMajorLockfile = `
lockfileVersion: '9.0'
overrides:
  diff: '>=9.0.0'
  ws@>=8.0.0 <8.21.3: 8.21.3
importers:
  tests:
    devDependencies:
      diff:
        specifier: ^8.0.0
        version: 9.0.0
packages:
  diff@9.0.0: {}
  fsevents@2.3.3: {}
  miniflare@5.0.0: {}
  ts-node@10.9.2: {}
  ws@8.21.3: {}
snapshots:
  diff@9.0.0: {}
  fsevents@2.3.3:
    optional: true
    dependencies:
      diff: 9.0.0
  miniflare@5.0.0:
    dependencies:
      ws: 8.21.3
  ts-node@10.9.2(@types/node@26.6.2):
    dependencies:
      diff: 9.0.0
  ws@8.21.3: {}
`;

const manifests = {
  'miniflare@5.0.0': { dependencies: { ws: '8.21.0' } },
  'ts-node@10.9.2': { dependencies: { diff: '^4.0.1' } },
};
const readManifest = (name, version) => manifests[`${name}@${version}`];

test('a dependent forced across a major fails; a patch inside its major passes', () => {
  assert.deepEqual(findForcedMajors(crossMajorLockfile, readManifest), [
    'tests declares diff@^8.0.0 but resolves diff@9.0.0, another major. ' +
      'Scope the diff override to the major it fixes, or drop tests.',
    'ts-node@10.9.2 declares diff@^4.0.1 but resolves diff@9.0.0, another major. ' +
      'Scope the diff override to the major it fixes, or drop ts-node@10.9.2.',
  ]);
  const scoped = crossMajorLockfile
    .replace("diff: '>=9.0.0'", 'diff@>=4.0.0 <4.0.4: 4.0.4')
    .replace('specifier: ^8.0.0', 'specifier: ^9.0.0')
    .replace(
      'ts-node@10.9.2(@types/node@26.6.2):\n    dependencies:\n      diff: 9.0.0',
      'ts-node@10.9.2(@types/node@26.6.2):\n    dependencies:\n      diff: 4.0.4',
    );
  assert.deepEqual(findForcedMajors(scoped, readManifest), []);
});

test('a dependent that is not installed fails unless it is optional', () => {
  assert.deepEqual(
    findForcedMajors(crossMajorLockfile, (name, version) =>
      name === 'miniflare' ? undefined : readManifest(name, version),
    ).filter(line => line.startsWith('miniflare')),
    [
      'miniflare@5.0.0 is not installed, so its declared ranges cannot be checked. Run pnpm install.',
    ],
  );
});

test('override keys split on the parent separator, not on range operators', () => {
  assert.deepEqual(parseOverrideKey('react-router@>=7.0.0 <7.18.2'), {
    target: { name: 'react-router', range: '>=7.0.0 <7.18.2' },
  });
  assert.deepEqual(parseOverrideKey('minimatch@3>brace-expansion'), {
    parent: { name: 'minimatch', range: '3' },
    target: { name: 'brace-expansion', range: undefined },
  });
  assert.deepEqual(parseOverrideKey('@modern-js/runtime-utils>react-router'), {
    parent: { name: '@modern-js/runtime-utils', range: undefined },
    target: { name: 'react-router', range: undefined },
  });
});

// Shape of the lockfile before the dead overrides were removed: nx@23.2.1
// kept brace-expansion 5.0.9 because pnpm never matched `brace-expansion@`.
const preFixLockfile = `
lockfileVersion: '9.0'
overrides:
  '@remix-run/router': '>=1.23.4'
  '@modern-js/runtime-utils>react-router': 7.18.2
  '@isaacs/brace-expansion': '>=5.0.1'
  minimatch@3>brace-expansion: 1.1.18
  brace-expansion@: 5.0.12
importers:
  packages/toolkit/runtime-utils:
    dependencies:
      react-router:
        specifier: 7.18.4
        version: 7.18.2
packages:
  brace-expansion@1.1.18: {}
  brace-expansion@5.0.9: {}
  minimatch@3.1.5: {}
  nx@23.2.1: {}
  react-router@7.18.2: {}
snapshots:
  brace-expansion@1.1.18: {}
  brace-expansion@5.0.9: {}
  minimatch@3.1.5:
    dependencies:
      brace-expansion: 1.1.18
  nx@23.2.1:
    dependencies:
      brace-expansion: 5.0.9
  react-router@7.18.2: {}
`;

const importerNames = new Map([
  [
    '@modern-js/runtime-utils',
    { path: 'packages/toolkit/runtime-utils', version: '3.0.0' },
  ],
]);

test('dead, inverted and unmatched overrides each name their fix', () => {
  const violations = findOverrideViolations(preFixLockfile, importerNames);
  assert.equal(violations.length, 4);
  assert.match(
    violations[0],
    /^'@remix-run\/router': nothing in the lockfile resolves @remix-run\/router\. Delete/,
  );
  assert.match(
    violations[1],
    /workspace package.*set react-router in packages\/toolkit\/runtime-utils\/package\.json/,
  );
  assert.match(violations[2], /resolves @isaacs\/brace-expansion\. Delete/);
  assert.match(
    violations[3],
    /'brace-expansion@' has an empty version selector/,
  );
});

test('a resolution left inside a closed range fails', () => {
  const lockfile = preFixLockfile.replace(
    /overrides:[\s\S]*?importers:/,
    'overrides:\n  brace-expansion@>=5.0.0 <5.0.12: 5.0.12\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
  );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'brace-expansion@>=5.0.0 <5.0.12': the lockfile still resolves brace-expansion@5.0.9, which this override should replace with 5.0.12. " +
      'Run pnpm install, or fix the selector if pnpm does not match it.',
  ]);
});

test('a parent snapshot that ignores its override fails', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
    )
    .replace(
      'minimatch@3.1.5:\n    dependencies:\n      brace-expansion: 1.1.18',
      'minimatch@3.1.5:\n    dependencies:\n      brace-expansion: 5.0.9',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'minimatch@3>brace-expansion': minimatch@3.1.5 still resolves brace-expansion@5.0.9, not 1.1.18. " +
      'Run pnpm install so the lockfile picks up the override.',
  ]);
});

test('a parent that no longer depends on the target fails', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
    )
    .replace(
      'minimatch@3.1.5:\n    dependencies:\n      brace-expansion: 1.1.18',
      'minimatch@3.1.5: {}',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'minimatch@3>brace-expansion': no minimatch@3 in the lockfile depends on brace-expansion. Delete the override.",
  ]);
});

test('a removal override passes once the edge is gone and fails while it stays', () => {
  const withOverride = override =>
    preFixLockfile.replace(
      /overrides:[\s\S]*?importers:/,
      `overrides:\n  ${override}\nimporters:`,
    );
  assert.deepEqual(
    findOverrideViolations(
      withOverride("nx>brace-expansion: '-'").replace(
        'nx@23.2.1:\n    dependencies:\n      brace-expansion: 5.0.9',
        'nx@23.2.1: {}',
      ),
      importerNames,
    ),
    [],
  );
  assert.deepEqual(
    findOverrideViolations(
      withOverride("nx>brace-expansion: '-'"),
      importerNames,
    ),
    [
      "'nx>brace-expansion': nx@23.2.1 still depends on brace-expansion, which this override removes. " +
        'Run pnpm install so the lockfile picks up the override.',
    ],
  );
});

test('a removal override whose parent resolves nowhere fails', () => {
  const lockfile = preFixLockfile.replace(
    /overrides:[\s\S]*?importers:/,
    "overrides:\n  old-parent>brace-expansion: '-'\nimporters:",
  );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'old-parent>brace-expansion': nothing in the lockfile resolves old-parent. Delete the override.",
  ]);
});

test('a prerelease outside the selector is not flagged', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  brace-expansion@>=5.0.0 <5.0.12: 5.0.12\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
    )
    .replaceAll('brace-expansion@5.0.9', 'brace-expansion@5.0.9-beta.1')
    .replace('brace-expansion: 5.0.9', 'brace-expansion: 5.0.9-beta.1');
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), []);
});

test('a prerelease left under a range override fails', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      "overrides:\n  react-router: '>=7.18.0'\nimporters:",
    )
    .replaceAll('7.18.2', '7.19.0-beta.1');
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'react-router': the lockfile still resolves react-router@7.19.0-beta.1, which this override should replace with >=7.18.0. " +
      'Run pnpm install, or fix the selector if pnpm does not match it.',
  ]);
});

test('a global removal override still fails while a workspace project keeps the edge', () => {
  const lockfile = preFixLockfile.replace(
    /overrides:[\s\S]*?importers:/,
    "overrides:\n  react-router: '-'\nimporters:",
  );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'react-router': packages/toolkit/runtime-utils still depends on react-router, which this override removes. " +
      'Run pnpm install so the lockfile picks up the override.',
  ]);
});

test('an npm: alias override is live through its edge name', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  left-pad: npm:pad-left@1.0.0\nimporters:',
    )
    .replace(
      'nx@23.2.1:\n    dependencies:',
      'nx@23.2.1:\n    dependencies:\n      left-pad: pad-left@1.0.0',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), []);
});

test('an npm: alias override fails while the edge keeps another version', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  nx>left-pad: npm:pad-left@1.2.3\nimporters:',
    )
    .replace(
      'nx@23.2.1:\n    dependencies:',
      'nx@23.2.1:\n    dependencies:\n      left-pad: pad-left@1.0.0',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'nx>left-pad': nx@23.2.1 still resolves left-pad@pad-left@1.0.0, not npm:pad-left@1.2.3. " +
      'Run pnpm install so the lockfile picks up the override.',
  ]);
  assert.deepEqual(
    findOverrideViolations(
      lockfile.replace('left-pad: pad-left@1.0.0', 'left-pad: pad-left@1.2.3'),
      importerNames,
    ),
    [],
  );
});

test('digit-leading package names parse and validate', () => {
  assert.deepEqual(parseOverrideKey('parent>2-decode'), {
    parent: { name: 'parent', range: undefined },
    target: { name: '2-decode', range: undefined },
  });
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  left-pad: npm:2-decode@1.2.3\nimporters:',
    )
    .replace(
      'nx@23.2.1:\n    dependencies:',
      'nx@23.2.1:\n    dependencies:\n      left-pad: 2-decode@1.0.0',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'left-pad': the lockfile still resolves left-pad@2-decode@1.0.0, which this override should replace with npm:2-decode@1.2.3. " +
      'Run pnpm install, or fix the selector if pnpm does not match it.',
  ]);
});

test('a parent override takes precedence over a generic one', () => {
  const lockfile = preFixLockfile.replace(
    /overrides:[\s\S]*?importers:/,
    'overrides:\n  brace-expansion: 5.0.9\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
  );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), []);
});

test('a parent selector that excludes the workspace version targets registry copies', () => {
  const lockfile = preFixLockfile.replace(
    /overrides:[\s\S]*?importers:/,
    'overrides:\n  minimatch@3>brace-expansion: 1.1.18\nimporters:',
  );
  const workspaceMinimatch = new Map([
    ['minimatch', { path: 'packages/minimatch', version: '10.0.0' }],
  ]);
  assert.deepEqual(findOverrideViolations(lockfile, workspaceMinimatch), []);
  assert.match(
    findOverrideViolations(
      lockfile,
      new Map([
        ['minimatch', { path: 'packages/minimatch', version: '3.0.0' }],
      ]),
    )[0],
    /workspace package.*set brace-expansion in packages\/minimatch\/package\.json/,
  );
});

test('a parent override of a peer without a snapshot edge is live', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      "overrides:\n  nx>react: '19.3.0'\nimporters:",
    )
    .replace(
      '  nx@23.2.1: {}\n',
      "  nx@23.2.1:\n    peerDependencies:\n      react: '19.3.0'\n",
    )
    .replace(
      'nx@23.2.1:\n    dependencies:',
      'nx@23.2.1:\n    dependencies:\n      react-dom: 19.3.0',
    );
  // react resolves only through another package's edge name.
  const withEdge = lockfile.replace(
    'minimatch@3.1.5:\n    dependencies:',
    'minimatch@3.1.5:\n    dependencies:\n      react: 19.3.0',
  );
  assert.deepEqual(findOverrideViolations(withEdge, importerNames), []);
  assert.match(
    findOverrideViolations(
      withEdge.replace("    peerDependencies:\n      react: '19.3.0'\n", ''),
      importerNames,
    )[0],
    /no nx in the lockfile depends on react\. Delete/,
  );
});

test('an unranged override judges git and file edges too', () => {
  const lockfile = preFixLockfile
    .replace(
      /overrides:[\s\S]*?importers:/,
      'overrides:\n  left-pad: 2.0.0\nimporters:',
    )
    .replace(
      'nx@23.2.1:\n    dependencies:',
      'nx@23.2.1:\n    dependencies:\n      left-pad: https://codeload.github.com/a/left-pad/tar.gz/abc',
    );
  assert.deepEqual(findOverrideViolations(lockfile, importerNames), [
    "'left-pad': the lockfile still resolves left-pad@https://codeload.github.com/a/left-pad/tar.gz/abc, which this override should replace with 2.0.0. " +
      'Run pnpm install, or fix the selector if pnpm does not match it.',
  ]);
});

test('peer ranges prove liveness but are not judged', () => {
  // The lockfile keeps a peer range as published even after an override
  // applies: follow-redirects keeps peer `debug: '*'` under
  // `debug: '>=4.4.3'`.
  const lockfile = preFixLockfile.replace(
    '  nx@23.2.1: {}\n',
    '  nx@23.2.1:\n    peerDependencies:\n      react: ^18\n',
  );
  for (const override of [
    "  react: '^19'",
    "  nx>react: '^19'",
    "  nx>react@^18: '^19'",
  ]) {
    assert.deepEqual(
      findOverrideViolations(
        lockfile.replace(
          /overrides:[\s\S]*?importers:/,
          `overrides:\n${override}\nimporters:`,
        ),
        importerNames,
      ),
      [],
    );
  }
});

test('a tarball dependent is found under its cut virtual-store name', t => {
  const root = mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'overrides-store-'),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const url =
    'https://example.com/releases/download/fork-1/fork-core-1.2.3.tgz';
  const install = (dir, version) => {
    const packageDir = path.join(
      root,
      'node_modules/.pnpm',
      dir,
      'node_modules/@scope/core',
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@scope/core', version }),
    );
  };
  install('@scope+core@https+++example.com+releases+download+fo_0a1b', '1.2.3');
  install('@scope+core@2.0.0_peer@1.0.0', '2.0.0');
  const read = readInstalledManifest(root);
  assert.equal(read('@scope/core', url)?.version, '1.2.3');
  assert.equal(read('@scope/core', '2.0.0')?.version, '2.0.0');
  // Two cut names sharing the prefix are ambiguous and stay unresolved.
  install('@scope+core@https+++example.com+releases+download+fo_9f8e', '1.2.4');
  assert.equal(readInstalledManifest(root)('@scope/core', url), undefined);
});
