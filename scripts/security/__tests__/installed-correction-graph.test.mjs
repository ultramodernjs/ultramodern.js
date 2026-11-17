import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectInstalledCorrectionGraph } from '../installed-correction-graph.mjs';

const packageName = 'picomatch';
const correctedVersions = ['2.3.2', '4.0.7'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const writePackage = (directory, manifest, files = {}) => {
  writeJson(path.join(directory, 'package.json'), manifest);
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), bytes);
  }
};
const link = (target, dependency) => {
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.symlinkSync(target, dependency, 'dir');
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const perVersion = entry => correctedVersions.map((_, i) => entry(i));

function correction(version) {
  const patch = Buffer.from(`canonical repository correction ${version}\n`);
  const manifest = { name: packageName, version, main: 'index.js' };
  const referenceFiles = new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['index.js', Buffer.from('module.exports = require("./lib/parse.js");\n')],
    ['lib/parse.js', Buffer.from(`module.exports = "parse ${version}";\n`)],
    ['LICENSE', Buffer.from('MIT\n')],
  ]);
  // Distinct per-version file sets prove each payload is compared to its own reference.
  if (version.startsWith('4.'))
    referenceFiles.set('posix.js', Buffer.from('module.exports = {};\n'));
  return {
    patch,
    patchPath: `patches/${packageName}@${version}.patch`,
    entry: {
      expectedIntegrity: `sha512-${createHash('sha512').update(`authenticated ${version} tarball`).digest('base64')}`,
      patchSha256: sha256(patch),
      referenceFiles,
    },
  };
}

function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'installed-correction-graph-',
      ),
    ),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository');
  fs.mkdirSync(root);
  const corrections = correctedVersions.map(correction);
  const versions = Object.fromEntries(
    correctedVersions.map((version, i) => [version, corrections[i].entry]),
  );
  const patched = correctedVersions.map(
    (version, i) =>
      `${version}(patch_hash=${corrections[i].entry.patchSha256})`,
  );
  const contexts = [
    'micromatch@4.0.8(peer@1.0.0)',
    'micromatch@4.0.8(peer@2.0.0)',
  ];
  const correctedContexts = [
    `${packageName}@${patched[0]}`,
    `${packageName}@${patched[1]}(peer@2.0.0)`,
  ];
  const dependencyKeys = [packageName, `${packageName}-alias`];
  const importers = ['.', 'packages/app'];
  const parents = [];
  const targets = [];
  const parentLinks = [];
  const targetLinks = [];
  for (let i = 0; i < contexts.length; i += 1) {
    const directory = path.join(root, importers[i]);
    writePackage(directory, {
      name: i === 0 ? 'repository' : 'app',
      version: '1.0.0',
      [i === 0 ? 'dependencies' : 'optionalDependencies']: {
        'parent-alias': 'npm:micromatch@4.0.8',
      },
    });
    const parent = path.join(
      root,
      'node_modules/.pnpm',
      `arbitrary-parent-location-${i}`,
      'node_modules/micromatch',
    );
    writePackage(
      parent,
      {
        name: 'micromatch',
        version: '4.0.8',
        dependencies: { [dependencyKeys[i]]: `^${correctedVersions[i]}` },
      },
      { 'index.js': 'module.exports = {};\n' },
    );
    const target = path.join(
      root,
      'node_modules/.pnpm',
      `arbitrary-payload-location-${i}`,
      `node_modules/${packageName}`,
    );
    for (const [file, bytes] of corrections[i].entry.referenceFiles) {
      fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
      fs.writeFileSync(path.join(target, file), bytes);
    }
    const parentLink = path.join(directory, 'node_modules/parent-alias');
    const targetLink = path.join(path.dirname(parent), dependencyKeys[i]);
    link(parent, parentLink);
    link(target, targetLink);
    parents.push(parent);
    targets.push(target);
    parentLinks.push(parentLink);
    targetLinks.push(targetLink);
  }
  const lock = {
    lockfileVersion: '9.0',
    patchedDependencies: Object.fromEntries(
      correctedVersions.map((version, i) => [
        `${packageName}@${version}`,
        corrections[i].entry.patchSha256,
      ]),
    ),
    importers: {
      '.': {
        dependencies: {
          'parent-alias': {
            specifier: 'npm:micromatch@4.0.8',
            version: contexts[0],
          },
        },
      },
      'packages/app': {
        optionalDependencies: {
          'parent-alias': {
            specifier: 'npm:micromatch@4.0.8',
            version: contexts[1],
          },
        },
      },
    },
    packages: {
      'micromatch@4.0.8': {},
      ...Object.fromEntries(
        correctedVersions.map((version, i) => [
          `${packageName}@${version}`,
          { resolution: { integrity: corrections[i].entry.expectedIntegrity } },
        ]),
      ),
    },
    snapshots: {
      [contexts[0]]: { dependencies: { [dependencyKeys[0]]: patched[0] } },
      [contexts[1]]: {
        optionalDependencies: { [dependencyKeys[1]]: correctedContexts[1] },
      },
      [correctedContexts[0]]: {},
      [correctedContexts[1]]: {},
    },
  };
  const workspace = {
    packages: ['packages/*'],
    patchedDependencies: Object.fromEntries(
      corrections.map(({ patchPath }, i) => [
        `${packageName}@${correctedVersions[i]}`,
        patchPath,
      ]),
    ),
  };
  const lockFile = path.join(root, 'pnpm-lock.yaml');
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  fs.mkdirSync(path.join(root, 'patches'));
  for (const { patchPath, patch } of corrections)
    fs.writeFileSync(path.join(root, patchPath), patch);
  const save = () => {
    writeJson(lockFile, lock);
    writeJson(workspaceFile, workspace);
  };
  save();
  const options = { root, packageName, versions };
  return {
    root,
    options,
    versions,
    corrections,
    patched,
    temporary,
    lock,
    workspace,
    lockFile,
    workspaceFile,
    contexts,
    correctedContexts,
    dependencyKeys,
    parents,
    targets,
    parentLinks,
    targetLinks,
    save,
    expectedTargets: () =>
      targets
        .map((target, i) => ({ root: target, version: correctedVersions[i] }))
        .sort((a, b) => a.root.localeCompare(b.root)),
    inspect: () => inspectInstalledCorrectionGraph(options),
  };
}

function addOptionalNativeBranch(f, platform) {
  const name = 'native-platform-fallback';
  const patched = f.patched[0];
  const directory = path.join(
    f.root,
    'node_modules/.pnpm',
    'optional-native',
    'node_modules',
    name,
  );
  const installedLink = path.join(f.root, 'node_modules', name);
  const manifestPath = path.join(f.root, 'package.json');
  const importer = readJson(manifestPath);
  importer.optionalDependencies = { [name]: '1.0.0' };
  writeJson(manifestPath, importer);
  f.lock.importers['.'].optionalDependencies = {
    [name]: { specifier: '1.0.0', version: '1.0.0' },
  };
  f.lock.packages[`${name}@1.0.0`] = platform;
  f.lock.snapshots[`${name}@1.0.0`] = {
    dependencies: { [packageName]: patched },
    optional: true,
  };
  f.save();
  return {
    name,
    manifestPath,
    attach() {
      writePackage(directory, {
        name,
        version: '1.0.0',
        dependencies: { [packageName]: correctedVersions[0] },
      });
      link(f.targets[0], path.join(path.dirname(directory), packageName));
      link(directory, installedLink);
    },
  };
}

test('optional packages excluded by the runner platform are omitted only as long as their links are absent', t => {
  const f = fixture(t);
  const branch = addOptionalNativeBranch(f, { cpu: [`!${process.arch}`] });
  const proof = f.inspect();
  assert.deepEqual(proof.targets, f.expectedTargets());
  assert.doesNotThrow(proof.assertUnchanged);
  branch.attach();
  assert.throws(proof.assertUnchanged, /Installed dependency edge changed/u);
  const present = f.inspect();
  assert.ok(present.identities.some(edge => edge.name === branch.name));
  assert.deepEqual(present.targets, f.expectedTargets());
});

test('a missing production link needs both a declared optional edge and a conclusive platform mismatch', async t => {
  for (const [name, metadata, mutate] of [
    ['no platform selectors', {}, () => {}],
    ['current cpu', { cpu: [process.arch] }, () => {}],
    ['current os', { os: [process.platform] }, () => {}],
    ['any cpu', { cpu: ['any'] }, () => {}],
    [
      'required lock edge',
      { cpu: [`!${process.arch}`] },
      (f, b) => {
        f.lock.importers['.'].dependencies[b.name] =
          f.lock.importers['.'].optionalDependencies[b.name];
        delete f.lock.importers['.'].optionalDependencies[b.name];
        f.save();
      },
    ],
    [
      'required manifest edge',
      { cpu: [`!${process.arch}`] },
      (_f, b) => {
        const manifest = readJson(b.manifestPath);
        manifest.dependencies[b.name] = manifest.optionalDependencies[b.name];
        delete manifest.optionalDependencies[b.name];
        writeJson(b.manifestPath, manifest);
      },
    ],
  ]) {
    await t.test(name, child => {
      const f = fixture(child);
      const branch = addOptionalNativeBranch(f, metadata);
      mutate(f, branch);
      assert.throws(
        f.inspect,
        /Missing installed dependency: .*native-platform-fallback/u,
      );
    });
  }
});

function addRemoteProductionBranch(f, protocol = 'https:') {
  const routerName = '@octanejs/tanstack-router';
  const routerUrl = `${protocol}//github.com/bleedingdev/octane/releases/download/%40octanejs%2Ftanstack-router%400.1.60%2Bultramodern.0b9f76ee3003/octanejs-tanstack-router-0.1.60%2Bultramodern.0b9f76ee3003.tgz`;
  const octaneUrl = `${protocol}//github.com/bleedingdev/octane/releases/download/octane%400.7.1%2Bultramodern.1331985ea3b0/octane-0.7.1%2Bultramodern.1331985ea3b0.tgz`;
  const octaneVersion = `${octaneUrl}(react-dom@19.3.0(react@19.3.0))(react@19.3.0)(typescript@7.0.2)(vite@8.3.2(@types/node@26.6.3)(esbuild@0.28.2)(jiti@2.7.0)(less@4.9.1(supports-color@10.2.2))(sass-embedded@1.105.1)(sass@1.105.1)(terser@5.51.2)(tsx@4.23.15)(yaml@2.9.1))`;
  const routerVersion = `${routerUrl}(octane@${octaneVersion})`;
  const routerSnapshot = `${routerName}@${routerVersion}`;
  const octaneSnapshot = `octane@${octaneVersion}`;
  const routerDirectory = path.join(f.root, 'node_modules/remote-router');
  const octaneDirectory = path.join(f.root, 'node_modules/remote-octane');
  writePackage(routerDirectory, {
    name: routerName,
    version: '0.1.60+ultramodern.0b9f76ee3003',
    dependencies: { octane: octaneUrl },
  });
  writePackage(octaneDirectory, {
    name: 'octane',
    version: '0.7.1+ultramodern.1331985ea3b0',
    dependencies: { 'parent-alias': 'npm:micromatch@4.0.8' },
  });
  link(routerDirectory, path.join(f.root, 'node_modules', routerName));
  link(routerDirectory, path.join(f.root, 'node_modules/router-alias'));
  link(octaneDirectory, path.join(routerDirectory, 'node_modules/octane'));
  link(f.parents[0], path.join(octaneDirectory, 'node_modules/parent-alias'));
  const manifestPath = path.join(f.root, 'package.json');
  const manifest = readJson(manifestPath);
  Object.assign(manifest.dependencies, {
    [routerName]: routerUrl,
    'router-alias': routerUrl,
    '@typescript/native': 'npm:typescript@7.0.2',
    '@rspack/core': '2.2.8',
  });
  writeJson(manifestPath, manifest);
  Object.assign(f.lock.importers['.'].dependencies, {
    [routerName]: { specifier: routerUrl, version: routerVersion },
    'router-alias': { specifier: routerUrl, version: routerSnapshot },
    '@typescript/native': {
      specifier: 'npm:typescript@7.0.2',
      version: 'typescript@7.0.2',
    },
    '@rspack/core': {
      specifier: '2.2.8',
      version:
        '2.2.8(@module-federation/runtime-tools@2.9.2)(@swc/helpers@0.5.23)',
    },
  });
  const octanePackage = `octane@${octaneUrl}`;
  f.lock.packages[`${routerName}@${routerUrl}`] = {
    version: '0.1.60+ultramodern.0b9f76ee3003',
  };
  f.lock.packages[octanePackage] = {
    version: '0.7.1+ultramodern.1331985ea3b0',
  };
  Object.assign(f.lock.snapshots, {
    [routerSnapshot]: { dependencies: { octane: octaneVersion } },
    [octaneSnapshot]: { dependencies: { 'parent-alias': f.contexts[0] } },
    'typescript@7.0.2': {},
    '@rspack/core@2.2.8(@module-federation/runtime-tools@2.9.2)(@swc/helpers@0.5.23)':
      {},
  });
  f.save();
  return { routerSnapshot, octaneSnapshot, octanePackage };
}

test('every corrected version resolves its own authenticated payload with its version', t => {
  const f = fixture(t);
  const proof = f.inspect();
  assert.deepEqual(proof.targets, f.expectedTargets());
  const corrected = proof.identities.filter(row => row.name === packageName);
  assert.deepEqual(
    new Set(corrected.map(row => `${row.version} ${row.snapshot}`)),
    new Set(
      correctedVersions.map(
        (version, i) => `${version} ${f.correctedContexts[i]}`,
      ),
    ),
  );
  proof.assertUnchanged();
});

test('the requested correction must name an exact package, versions and matching references', async t => {
  for (const [name, mutate, error] of [
    [
      'package name',
      options => {
        options.packageName = '../picomatch';
      },
      /Expected corrected package name/u,
    ],
    [
      'no versions',
      options => {
        options.versions = {};
      },
      /Expected corrected picomatch versions/u,
    ],
    [
      'version range',
      options => {
        options.versions = { '^4.0.7': options.versions['4.0.7'] };
      },
      /Expected exact corrected picomatch version/u,
    ],
    [
      'reference of another version',
      options => {
        options.versions = {
          ...options.versions,
          '4.0.7': {
            ...options.versions['4.0.7'],
            referenceFiles: options.versions['2.3.2'].referenceFiles,
          },
        };
      },
      /retain its upstream version/u,
    ],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      const options = { ...f.options };
      mutate(options);
      assert.throws(() => inspectInstalledCorrectionGraph(options), error);
    });
});

test('each corrected version rejects mismatched bytes, version, patch and peer contexts', async t => {
  for (const [i, version] of correctedVersions.entries()) {
    const other = 1 - i;
    const otherVersion = correctedVersions[other];
    const identity = `${packageName}@${version}`;
    const mutations = [
      [
        'payload bytes of the other version',
        f =>
          fs.writeFileSync(
            path.join(f.targets[i], 'lib/parse.js'),
            f.versions[otherVersion].referenceFiles.get('lib/parse.js'),
          ),
        new RegExp(`Installed ${identity} payload bytes differ`, 'u'),
      ],
      [
        'payload file set of the other version',
        f => {
          if (version.startsWith('4.'))
            fs.unlinkSync(path.join(f.targets[i], 'posix.js'));
          else
            fs.writeFileSync(
              path.join(f.targets[i], 'posix.js'),
              'module.exports = {};\n',
            );
        },
        new RegExp(`Installed ${identity} payload file set differs`, 'u'),
      ],
      [
        'installed manifest version',
        f =>
          writeJson(path.join(f.targets[i], 'package.json'), {
            name: packageName,
            version: otherVersion,
            main: 'index.js',
          }),
        /Installed dependency version differs from raw snapshot/u,
      ],
      [
        'installed target of the other version',
        f => {
          fs.unlinkSync(f.targetLinks[i]);
          link(f.targets[other], f.targetLinks[i]);
        },
        /Installed dependency version differs from raw snapshot/u,
      ],
      [
        'upstream integrity of the other version',
        f => {
          f.lock.packages[identity].resolution.integrity =
            f.versions[otherVersion].expectedIntegrity;
        },
        new RegExp(`${identity} upstream integrity differs`, 'u'),
      ],
      [
        'lock patch hash of the other version',
        f => {
          f.lock.patchedDependencies[identity] =
            f.versions[otherVersion].patchSha256;
        },
        new RegExp(`exact ${identity} patch hash`, 'u'),
      ],
      [
        'workspace registration',
        f => {
          delete f.workspace.patchedDependencies[identity];
        },
        new RegExp(`register the exact ${identity} patch`, 'u'),
      ],
      [
        'canonical patch bytes',
        f =>
          fs.appendFileSync(
            path.join(f.root, f.corrections[i].patchPath),
            'different',
          ),
        new RegExp(`Canonical ${identity} patch bytes differ`, 'u'),
      ],
      [
        'snapshot with the other version patch hash',
        f => {
          f.lock.snapshots[
            `${identity}(patch_hash=${f.versions[otherVersion].patchSha256})`
          ] = {};
        },
        /Unpatched or unexpected picomatch snapshot/u,
      ],
      [
        'unpatched snapshot',
        f => {
          f.lock.snapshots[identity] = {};
        },
        /Unpatched or unexpected picomatch snapshot/u,
      ],
      [
        'unpatched peer context',
        f => {
          f.lock.snapshots[`unused@1.0.0(${identity})`] = {};
        },
        /Unpatched picomatch peer context/u,
      ],
      [
        'peer context with the other version patch hash',
        f => {
          f.lock.snapshots[
            `unused@1.0.0(${identity}(patch_hash=${f.versions[otherVersion].patchSha256}))`
          ] = {};
        },
        /Unpatched picomatch peer context/u,
      ],
      [
        'unpatched consumer edge',
        f => {
          const snapshot = f.lock.snapshots[f.contexts[i]];
          const field = snapshot.dependencies ?? snapshot.optionalDependencies;
          field[f.dependencyKeys[i]] = i === 0 ? version : identity;
        },
        /Unpatched or unexpected picomatch snapshot/u,
      ],
      [
        'missing package record',
        f => {
          delete f.lock.packages[identity];
        },
        new RegExp(`No ${identity} package record was found`, 'u'),
      ],
      [
        'unreached version',
        f => {
          const importer = f.lock.importers[i === 0 ? '.' : 'packages/app'];
          delete (importer.dependencies ?? importer.optionalDependencies)[
            'parent-alias'
          ];
        },
        new RegExp(
          `No installed production consumer reaches patched ${identity}`,
          'u',
        ),
      ],
    ];
    for (const [name, mutate, error] of mutations)
      await t.test(`${version}: ${name}`, subtest => {
        const f = fixture(subtest);
        mutate(f);
        f.save();
        assert.throws(f.inspect, error);
      });
  }
});

test('versions outside the requested correction cannot appear in the raw graph', async t => {
  for (const [name, mutate, error] of [
    [
      'package record',
      f => {
        f.lock.packages[`${packageName}@3.0.1`] = {
          resolution: { integrity: f.versions['2.3.2'].expectedIntegrity },
        };
      },
      /Unexpected picomatch package record/u,
    ],
    [
      'snapshot',
      f => {
        f.lock.snapshots[`${packageName}@3.0.1`] = {};
      },
      /Unpatched or unexpected picomatch snapshot/u,
    ],
    [
      'peer context',
      f => {
        f.lock.snapshots[`unused@1.0.0(${packageName}@3.0.1)`] = {};
      },
      /Unpatched picomatch peer context/u,
    ],
    [
      'renamed alias edge',
      f => {
        f.lock.snapshots[f.contexts[0]].dependencies[packageName] =
          `@bleedingdev/${packageName}@4.0.8`;
      },
      /Unexpected picomatch alias/u,
    ],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      mutate(f);
      f.save();
      assert.throws(f.inspect, error);
    });
});

test('remote tarball snapshot references retain exact nested URL peer and native contexts', async t => {
  for (const protocol of ['https:', 'http:'])
    await t.test(protocol, subtest => {
      const f = fixture(subtest);
      const { routerSnapshot, octaneSnapshot } = addRemoteProductionBranch(
        f,
        protocol,
      );
      const proof = f.inspect();
      assert.deepEqual(proof.targets, f.expectedTargets());
      const remote = proof.identities.filter(row =>
        ['@octanejs/tanstack-router', 'octane'].includes(row.name),
      );
      assert.deepEqual(
        new Set(remote.map(row => row.snapshot)),
        new Set([routerSnapshot, octaneSnapshot]),
      );
      assert.deepEqual(
        new Set(remote.map(row => row.dependencyKey)),
        new Set(['@octanejs/tanstack-router', 'router-alias', 'octane']),
      );
      proof.assertUnchanged();
    });
});

test('remote references cannot borrow another peer context or installed version', async t => {
  await t.test('missing exact nested context', subtest => {
    const f = fixture(subtest);
    const { octaneSnapshot, octanePackage } = addRemoteProductionBranch(f);
    delete f.lock.snapshots[octaneSnapshot];
    f.lock.snapshots[octanePackage] = {};
    f.save();
    assert.throws(f.inspect, /Missing raw lock snapshot: octane@https:/u);
  });
  await t.test('installed remote version differs', subtest => {
    const f = fixture(subtest);
    const { octanePackage } = addRemoteProductionBranch(f);
    f.lock.packages[octanePackage].version = '0.7.0';
    f.save();
    assert.throws(
      f.inspect,
      /Installed dependency version differs from raw snapshot: octane@https:/u,
    );
  });
});

test('raw aliases, optional paths and distinct patch/peer contexts resolve from each physical consumer', t => {
  const f = fixture(t);
  const proof = f.inspect();
  assert.deepEqual(proof.targets, f.expectedTargets());
  const corrected = proof.identities.filter(row => row.name === packageName);
  assert.deepEqual(
    new Set(corrected.map(row => row.rawparentkey)),
    new Set(f.contexts),
  );
  assert.deepEqual(
    new Set(corrected.map(row => row.snapshot)),
    new Set(f.correctedContexts),
  );
  assert.deepEqual(
    new Set(corrected.map(row => row.dependencyKey)),
    new Set(f.dependencyKeys),
  );
  assert.deepEqual(
    new Set(corrected.map(row => row.physicalparent)),
    new Set(f.parents),
  );
  assert.ok(proof.digests.some(row => row.path === f.lockFile));
  assert.ok(proof.digests.some(row => row.path === f.workspaceFile));
  assert.ok(proof.digests.every(row => /^[a-f0-9]{64}$/u.test(row.sha256)));
  proof.assertUnchanged();
});

test('production workspace links use their installed target and retain the originating importer', t => {
  const f = fixture(t);
  f.lock.importers['.'].dependencies.local = {
    specifier: 'workspace:*',
    version: 'link:packages/app',
  };
  const manifestPath = path.join(f.root, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies.local = 'workspace:*';
  writeJson(manifestPath, manifest);
  link(
    path.join(f.root, 'packages/app'),
    path.join(f.root, 'node_modules/local'),
  );
  f.save();
  const proof = f.inspect();
  assert.ok(
    proof.identities.some(
      row =>
        row.importer === '.' &&
        row.rawparentkey === 'importer:packages/app' &&
        row.physicaltarget === f.parents[1],
    ),
  );
  assert.deepEqual(proof.targets, f.expectedTargets());
});

test('private importer manifests may omit a published identity without weakening snapshot identities', t => {
  const f = fixture(t);
  for (const importer of ['.', 'packages/app']) {
    const file = path.join(f.root, importer, 'package.json');
    const value = readJson(file);
    delete value.name;
    delete value.version;
    writeJson(file, value);
  }
  assert.deepEqual(f.inspect().targets, f.expectedTargets());
});

test('snapshot workspace peer links are workspace-relative and use the actual consumer edge', t => {
  const f = fixture(t);
  f.lock.snapshots[f.contexts[0]].dependencies.local = 'link:packages/app';
  const manifestPath = path.join(f.parents[0], 'package.json');
  const manifest = readJson(manifestPath);
  manifest.peerDependencies = { local: 'workspace:*' };
  writeJson(manifestPath, manifest);
  link(
    path.join(f.root, 'packages/app'),
    path.join(path.dirname(f.parents[0]), 'local'),
  );
  f.save();
  const proof = f.inspect();
  assert.ok(
    proof.identities.some(
      row =>
        row.rawparentkey === f.contexts[0] &&
        row.dependencyKey === 'local' &&
        row.snapshot === 'importer:packages/app',
    ),
  );
  proof.assertUnchanged();
});

test('development edges must retain an exact patched snapshot', async t => {
  await t.test('unpatched development edge', subtest => {
    const f = fixture(subtest);
    f.lock.importers['.'].devDependencies = {
      'dev-picomatch': { version: `${packageName}@4.0.7` },
    };
    f.save();
    assert.throws(f.inspect, /Unpatched or unexpected picomatch/u);
  });
  await t.test('missing development snapshot', subtest => {
    const f = fixture(subtest);
    f.lock.importers['.'].devDependencies = {
      'dev-picomatch': {
        version: `${packageName}@${f.patched[1]}(peer@missing)`,
      },
    };
    f.save();
    assert.throws(f.inspect, /Missing raw picomatch snapshot/u);
  });
});

test('missing raw snapshots fail even when their names resemble an admitted context', t => {
  const f = fixture(t);
  delete f.lock.snapshots[f.contexts[1]];
  f.save();
  assert.throws(f.inspect, /Missing raw lock snapshot/u);
});

test('missing snapshots on unrelated production branches also fail closed', t => {
  const f = fixture(t);
  f.lock.importers['.'].dependencies.unrelated = {
    version: 'unrelated@1.0.0(peer@1.0.0)',
  };
  f.save();
  assert.throws(f.inspect, /Missing raw lock snapshot/u);
});

test('an installed package in another raw context cannot replace a missing parent or target', async t => {
  for (const [name, select] of [
    ['parent', f => f.parentLinks[1]],
    ['target', f => f.targetLinks[1]],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      fs.unlinkSync(select(f));
      if (name === 'parent') fs.unlinkSync(f.parentLinks[0]);
      assert.throws(f.inspect, /Missing installed dependency/u);
    });
});

test('a nearer importer cannot silently use a different peer context with incompatible dependency aliases', t => {
  const f = fixture(t);
  fs.unlinkSync(f.parentLinks[1]);
  assert.throws(
    f.inspect,
    /Installed parent does not declare its lock dependency/u,
  );
});

test('linked importer records and physical importers are both required', async t => {
  await t.test('raw importer', subtest => {
    const f = fixture(subtest);
    f.lock.importers['.'].dependencies.local = {
      version: 'link:missing-importer',
    };
    f.save();
    assert.throws(f.inspect, /Missing linked importer/u);
  });
  await t.test('physical importer', subtest => {
    const f = fixture(subtest);
    fs.rmSync(path.join(f.root, 'packages/app'), { recursive: true });
    assert.throws(f.inspect, /ENOENT/u);
  });
});

test('borrowed physical parents and targets cannot qualify a repository installation', async t => {
  for (const [name, select, manifest] of [
    ['parent', f => f.parentLinks[1], { name: 'micromatch', version: '4.0.8' }],
    ['target', f => f.targetLinks[1], { name: packageName, version: '4.0.7' }],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      const external = path.join(f.temporary, 'borrowed');
      writePackage(external, manifest);
      fs.unlinkSync(select(f));
      link(external, select(f));
      assert.throws(f.inspect, /borrowed an external root/u);
    });
});

test('wrong parent identity or an undeclared installed dependency fails', async t => {
  for (const [name, mutate, error] of [
    [
      'name',
      value => {
        value.name = 'different';
      },
      /name differs/u,
    ],
    [
      'version',
      value => {
        value.version = '4.0.7';
      },
      /version differs/u,
    ],
    [
      'edge',
      value => {
        delete value.dependencies[packageName];
      },
      /does not declare its lock dependency/u,
    ],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      const file = path.join(f.parents[0], 'package.json');
      const value = readJson(file);
      mutate(value);
      writeJson(file, value);
      assert.throws(f.inspect, error);
    });
});

test('installed payloads must contain exactly the authenticated regular files', async t => {
  for (const [name, mutate, error] of [
    [
      'changed bytes',
      f =>
        fs.writeFileSync(path.join(f.targets[0], 'lib/parse.js'), 'different'),
      /payload bytes differ/u,
    ],
    [
      'missing file',
      f => fs.unlinkSync(path.join(f.targets[0], 'LICENSE')),
      /file set differs/u,
    ],
    [
      'unexpected file',
      f => fs.writeFileSync(path.join(f.targets[0], 'extra.js'), 'unexpected'),
      /file set differs/u,
    ],
    [
      'unexpected directory',
      f => fs.mkdirSync(path.join(f.targets[0], 'extra')),
      /Unexpected picomatch payload directory/u,
    ],
    [
      'symbolic payload',
      f => {
        fs.unlinkSync(path.join(f.targets[0], 'LICENSE'));
        fs.symlinkSync(
          path.join(f.targets[1], 'LICENSE'),
          path.join(f.targets[0], 'LICENSE'),
        );
      },
      /payload contains a symbolic link/u,
    ],
    [
      'renamed manifest',
      f => {
        writeJson(path.join(f.targets[0], 'package.json'), {
          name: `@bleedingdev/${packageName}`,
          version: '2.3.2',
        });
      },
      /name differs/u,
    ],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      mutate(f);
      assert.throws(f.inspect, error);
    });
});

test('audit-time mutations of graph inputs, consumers, edges and payloads are detected', async t => {
  for (const [name, mutate] of [
    ['lock', f => fs.appendFileSync(f.lockFile, '\n')],
    ['workspace', f => fs.appendFileSync(f.workspaceFile, '\n')],
    ...perVersion(i => [
      `patch ${correctedVersions[i]}`,
      f =>
        fs.appendFileSync(path.join(f.root, f.corrections[i].patchPath), '\n'),
    ]),
    [
      'parent manifest',
      f => fs.appendFileSync(path.join(f.parents[0], 'package.json'), '\n'),
    ],
    ...perVersion(i => [
      `target payload ${correctedVersions[i]}`,
      f => fs.appendFileSync(path.join(f.targets[i], 'lib/parse.js'), '\n'),
    ]),
    [
      'added payload',
      f => fs.writeFileSync(path.join(f.targets[1], 'extra.js'), 'unexpected'),
    ],
    [
      'dependency link',
      f => {
        fs.unlinkSync(f.targetLinks[0]);
        link(f.targets[1], f.targetLinks[0]);
      },
    ],
    [
      'new nearer dependency',
      f => {
        link(
          f.targets[1],
          path.join(f.parents[0], `node_modules/${packageName}`),
        );
      },
    ],
  ])
    await t.test(name, subtest => {
      const f = fixture(subtest);
      const proof = f.inspect();
      mutate(f);
      assert.throws(proof.assertUnchanged);
    });
});

test('conflicting lock documents cannot hide an unpatched raw record', t => {
  const f = fixture(t);
  const first = {
    lockfileVersion: '9.0',
    packages: {
      [`${packageName}@4.0.7`]: {
        resolution: { integrity: 'sha512-untrusted' },
      },
    },
  };
  fs.writeFileSync(
    f.lockFile,
    `${JSON.stringify(first)}\n---\n${JSON.stringify(f.lock)}\n`,
  );
  assert.throws(f.inspect, /integrity differs|Conflicting raw lock record/u);
});

test('reference inputs cannot be renamed', t => {
  const f = fixture(t);
  f.versions['2.3.2'].referenceFiles.set(
    'package.json',
    Buffer.from(
      JSON.stringify({ name: `@bleedingdev/${packageName}`, version: '2.3.2' }),
    ),
  );
  assert.throws(f.inspect, /retain its upstream name/u);
});
