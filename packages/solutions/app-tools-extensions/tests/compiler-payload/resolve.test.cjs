'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const packageRoot = path.resolve(__dirname, '../..');
const originalCompiler = path.join(packageRoot, 'compiler');
const source = JSON.parse(
  fs.readFileSync(path.join(originalCompiler, 'source.json'), 'utf8'),
);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temp = process.env.OWNED_TEMP_DIR;
assert.ok(
  temp,
  'Run through owned-temp-dir --run to own and clean fake fixtures',
);
let sequence = 0;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture({ absent = false, targets = source.targets } = {}) {
  const directory = path.join(fs.realpathSync(temp), `selector-${++sequence}`);
  const renamedPackage = path.join(
    directory,
    'node_modules',
    'renamed-tooling',
  );
  const compiler = path.join(renamedPackage, 'compiler');
  const payload = path.join(compiler, 'payload');
  fs.mkdirSync(compiler, { recursive: true });
  for (const file of [
    'resolve.cjs',
    'resolve.d.cts',
    'source.json',
    'constraint.patch',
  ]) {
    fs.copyFileSync(
      path.join(originalCompiler, file),
      path.join(compiler, file),
    );
  }
  const original = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  writeJson(path.join(renamedPackage, 'package.json'), {
    name: 'renamed-tooling',
    type: 'module',
    exports: {
      './internal-effect-payload':
        original.exports['./internal-effect-payload'],
    },
  });
  const from = path.join(directory, 'consumer.cjs');
  fs.writeFileSync(from, '');
  const requireFrom = createRequire(from);
  const api = requireFrom('renamed-tooling/internal-effect-payload');
  const manifest = {
    schemaVersion: 1,
    source: structuredClone(source),
    producer: {
      repository: 'ultramodernjs/ultramodern.js',
      workflow: 'effect-compiler-payload.yml',
      runId: '1234',
      runAttempt: '1',
      sourceCommit: 'a'.repeat(40),
    },
    targets: {},
  };
  for (const target of targets) {
    const executable = `${target}/tsrs${target.startsWith('win32-') ? '.exe' : ''}`;
    const files = [];
    for (const relative of [
      executable,
      `${target}/lib/lib.d.ts`,
      `${target}/notices/LICENSE-Effect`,
      `${target}/notices/LICENSE-tsrs`,
      `${target}/notices/LICENSE-TypeScript`,
      `${target}/notices/THIRD-PARTY-NOTICES`,
    ]) {
      const file = path.join(payload, relative);
      const contents = Buffer.from(`FAKE ONLY ${relative}\n`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, {
        mode: relative === executable ? 0o755 : 0o644,
      });
      files.push({
        path: relative,
        size: contents.length,
        sha256: hash(contents),
        executable: relative === executable,
      });
    }
    manifest.targets[target] = { executable, files };
  }
  const save = () => writeJson(path.join(payload, 'manifest.json'), manifest);
  if (absent) fs.rmSync(payload, { recursive: true, force: true });
  else save();
  const identity = (name, data) =>
    writeJson(path.join(directory, 'node_modules', name, 'package.json'), {
      name,
      ...data,
    });
  identity('@effect/tsgo', { version: source.effect.baseVersion });
  identity('tsrs', {
    version: source.tsrs.version,
    tsrs: {
      typescriptVersion: source.typescript.version,
      typescriptCommit: source.typescript.sourceCommit,
    },
    optionalDependencies: Object.fromEntries(
      source.targets.map(target => [
        `@tsrs/${target}${target.startsWith('linux-') ? '-gnu' : ''}`,
        source.tsrs.version,
      ]),
    ),
  });
  identity('typescript', {
    version: '7.0.2',
    gitHead: 'c'.repeat(40),
  });
  return {
    api,
    payload,
    compiler,
    directory,
    from,
    manifest,
    save,
    identity,
    requireFrom,
  };
}

function platform(os, arch, action, libc = 'gnu') {
  const osDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  const read = fs.readFileSync;
  Object.defineProperty(process, 'platform', { value: os });
  Object.defineProperty(process, 'arch', { value: arch });
  fs.readFileSync = function (file, ...args) {
    if (file === '/usr/bin/ldd')
      return libc === 'musl' ? 'musl libc' : 'GNU libc';
    return read.call(this, file, ...args);
  };
  try {
    return action();
  } finally {
    Object.defineProperty(process, 'platform', osDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
    fs.readFileSync = read;
  }
}

// Ambient developer overrides must not affect hermetic fake-package tests.
for (const name of ['TSRS_BINARY', 'EFFECT_TSGO_BIN']) delete process.env[name];

function selected(f, options = {}) {
  return platform('darwin', 'arm64', () =>
    f.api.resolveOwnedEffectCompiler({ from: f.from, ...options }),
  );
}

function rejectsMutation(name, mutate) {
  test(name, () => {
    const f = fixture();
    mutate(f);
    f.save();
    assert.throws(() => selected(f));
  });
}

test('absent package payload returns absent without installed tools or compiled dist', () => {
  const f = fixture({ absent: true });
  fs.rmSync(path.join(f.directory, 'node_modules/tsrs'), { recursive: true });
  assert.deepEqual(selected(f), { kind: 'absent' });
  assert.deepEqual(f.api.validateOwnedEffectPayload(), { kind: 'absent' });
  assert.throws(() =>
    f.api.validateOwnedEffectPayload({ requireComplete: true }),
  );
});

test('source declares four targets and the M3+ arm64 macOS support policy', () => {
  assert.deepEqual(source.targets, [
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
  ]);
  assert.deepEqual(source.macos, { architecture: 'arm64', minimumChip: 'M3' });
});

for (const absent of [true, false]) {
  test(`Darwin x64 (including Rosetta) rejects ${absent ? 'absent' : 'present'} payload instead of allowing official fallback`, () => {
    const f = fixture({ absent });
    assert.throws(
      () =>
        platform('darwin', 'x64', () =>
          f.api.resolveOwnedEffectCompiler({ from: f.from }),
        ),
      /macOS.*arm64.*M3/i,
    );
  });
}

test('renamed package exports identical uncompiled CJS through require and ESM', async () => {
  const f = fixture();
  const consumer = path.join(f.directory, 'consumer.mjs');
  fs.writeFileSync(
    consumer,
    'export { resolveOwnedEffectCompiler, validateOwnedEffectPayload } from "renamed-tooling/internal-effect-payload";',
  );
  const esm = await import(pathToFileURL(consumer).href);
  assert.equal(
    esm.resolveOwnedEffectCompiler,
    f.api.resolveOwnedEffectCompiler,
  );
  const result = selected(f);
  assert.deepEqual(result, {
    kind: 'owned',
    executable: path.join(f.payload, 'darwin-arm64/tsrs'),
    artifactSha256: f.manifest.targets['darwin-arm64'].files[0].sha256,
    manifestSha256: hash(
      fs.readFileSync(path.join(f.payload, 'manifest.json')),
    ),
    typescriptVersion: source.typescript.version,
    typescriptCommit: source.typescript.sourceCommit,
    effectVersion: source.effect.baseVersion,
    tsrsVersion: source.tsrs.version,
    target: 'darwin-arm64',
    distribution: 'ultramodern-effect-tsrs',
  });
  assert.equal(selected(f, { from: pathToFileURL(f.from) }).kind, 'owned');
  assert.equal(selected(f, { from: f.directory }).kind, 'owned');
});

test('stage root is validated against module source, with a complete target-set gate', () => {
  const f = fixture();
  const staged = path.join(f.directory, 'staged');
  fs.renameSync(f.payload, staged);
  const result = f.api.validateOwnedEffectPayload({
    payloadRoot: staged,
    requireComplete: true,
  });
  assert.equal(result.kind, 'owned');
  assert.deepEqual(Object.keys(result.manifest.targets).sort(), [
    'darwin-arm64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  assert.deepEqual(result.manifest, f.manifest);
  assert.equal(
    result.manifestSha256,
    hash(fs.readFileSync(path.join(staged, 'manifest.json'))),
  );
  assert.deepEqual(selected(f), { kind: 'absent' });
});

test('present empty directory and invalid JSON are not absence', () => {
  const f = fixture({ absent: true });
  fs.mkdirSync(f.payload);
  assert.throws(() => selected(f));
  fs.writeFileSync(path.join(f.payload, 'manifest.json'), '{');
  assert.throws(() => selected(f));
});

for (const [label, mutate] of [
  [
    'source identity',
    f => {
      f.manifest.source.effect.baseCommit = 'b'.repeat(40);
    },
  ],
  [
    'extra source metadata',
    f => {
      f.manifest.source.extra = true;
    },
  ],
  [
    'macOS support policy',
    f => {
      f.manifest.source.macos = { architecture: 'arm64', minimumChip: 'M1' };
    },
  ],
  [
    'schema version',
    f => {
      f.manifest.schemaVersion = 2;
    },
  ],
  [
    'producer repository',
    f => {
      f.manifest.producer.repository = 'elsewhere';
    },
  ],
  [
    'producer workflow',
    f => {
      f.manifest.producer.workflow = 'other.yml';
    },
  ],
  [
    'numeric producer run',
    f => {
      f.manifest.producer.runId = 1;
    },
  ],
  [
    'producer attempt',
    f => {
      f.manifest.producer.runAttempt = '-1';
    },
  ],
  [
    'producer commit',
    f => {
      f.manifest.producer.sourceCommit = 'main';
    },
  ],
  [
    'unknown target',
    f => {
      f.manifest.targets['linux-x64-musl'] = f.manifest.targets['linux-x64'];
    },
  ],
  [
    'removed Intel macOS target',
    f => {
      f.manifest.targets['darwin-x64'] = f.manifest.targets['darwin-arm64'];
    },
  ],
  [
    'empty target map',
    f => {
      f.manifest.targets = {};
    },
  ],
  [
    'wrong executable',
    f => {
      f.manifest.targets['darwin-arm64'].executable = '../escape';
    },
  ],
  [
    'duplicate inventory',
    f => {
      f.manifest.targets['darwin-arm64'].files.push(
        f.manifest.targets['darwin-arm64'].files[0],
      );
    },
  ],
  [
    'fractional size',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].size = 1.5;
    },
  ],
  [
    'empty file metadata',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].size = 0;
    },
  ],
  [
    'wrong size',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].size++;
    },
  ],
  [
    'wrong digest',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].sha256 = '0'.repeat(64);
    },
  ],
  [
    'malformed digest',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].sha256 = 'z'.repeat(64);
    },
  ],
  [
    'invalid mode metadata',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].executable = 'yes';
    },
  ],
  [
    'native executable flag',
    f => {
      f.manifest.targets['darwin-arm64'].files[0].executable = false;
    },
  ],
  [
    'wrong bytes',
    f => {
      fs.appendFileSync(path.join(f.payload, 'darwin-arm64/tsrs'), 'tampered');
    },
  ],
  [
    'empty actual file',
    f => {
      fs.writeFileSync(path.join(f.payload, 'darwin-arm64/tsrs'), '');
    },
  ],
  [
    'native executable mode',
    f => {
      fs.chmodSync(path.join(f.payload, 'darwin-arm64/tsrs'), 0o644);
    },
  ],
  [
    'nonregular file',
    f => {
      fs.rmSync(path.join(f.payload, 'darwin-arm64/tsrs'));
      fs.mkdirSync(path.join(f.payload, 'darwin-arm64/tsrs'));
    },
  ],
  [
    'unlisted file',
    f => {
      fs.writeFileSync(path.join(f.payload, 'stray'), 'FAKE');
    },
  ],
  [
    'missing libs',
    f => {
      f.manifest.targets['darwin-arm64'].files.splice(1, 1);
      fs.rmSync(path.join(f.payload, 'darwin-arm64/lib'), { recursive: true });
    },
  ],
  [
    'missing Effect license',
    f => {
      f.manifest.targets['darwin-arm64'].files.splice(2, 1);
      fs.rmSync(path.join(f.payload, 'darwin-arm64/notices/LICENSE-Effect'));
    },
  ],
  [
    'missing tsrs license',
    f => {
      f.manifest.targets['darwin-arm64'].files.splice(3, 1);
      fs.rmSync(path.join(f.payload, 'darwin-arm64/notices/LICENSE-tsrs'));
    },
  ],
  [
    'missing third-party notices',
    f => {
      f.manifest.targets['darwin-arm64'].files.pop();
      fs.rmSync(
        path.join(f.payload, 'darwin-arm64/notices/THIRD-PARTY-NOTICES'),
      );
    },
  ],
  [
    'patch hash',
    f => {
      fs.appendFileSync(path.join(f.compiler, 'constraint.patch'), 'tampered');
    },
  ],
])
  rejectsMutation(`rejects ${label}`, mutate);

for (const unsafe of [
  '../outside',
  '/absolute',
  'darwin-arm64/../../escape',
  'darwin-arm64//tsrs',
  'darwin-arm64/./tsrs',
  'darwin-arm64/C:tsrs',
  'darwin-arm64/\\escape',
  'darwin-arm64/tsrs\0',
]) {
  rejectsMutation(`rejects unsafe path ${JSON.stringify(unsafe)}`, f => {
    f.manifest.targets['darwin-arm64'].files[0].path = unsafe;
  });
}

for (const relative of [
  'manifest.json',
  'darwin-arm64/tsrs',
  'darwin-arm64/lib',
  'darwin-arm64',
]) {
  test(`rejects symlink at ${relative}`, () => {
    const f = fixture();
    const original = path.join(f.payload, relative);
    const moved = path.join(f.directory, 'symlink-destination');
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    assert.throws(() => selected(f), /symlink/);
  });
}

test('rejects payload root and ancestor symlinks, including dangling links', () => {
  const f = fixture();
  const moved = path.join(f.directory, 'actual-payload');
  fs.renameSync(f.payload, moved);
  fs.symlinkSync(moved, f.payload);
  assert.throws(() => selected(f));
  const linkedAncestor = path.join(f.directory, 'linked');
  fs.symlinkSync(f.compiler, linkedAncestor);
  assert.throws(() =>
    f.api.validateOwnedEffectPayload({
      payloadRoot: path.join(linkedAncestor, 'payload'),
    }),
  );
  fs.unlinkSync(f.payload);
  fs.symlinkSync(path.join(f.directory, 'missing'), f.payload);
  assert.throws(() => selected(f));
});

test('partial payload is allowed by validator but complete/current-target checks fail', () => {
  const f = fixture({ targets: ['win32-x64'] });
  assert.equal(f.api.validateOwnedEffectPayload().kind, 'owned');
  assert.throws(
    () => f.api.validateOwnedEffectPayload({ requireComplete: true }),
    /complete payload requires all source targets/,
  );
  assert.throws(() => selected(f), /current target/);
});

test('all supported platforms follow the installed tsrs platform contract', () => {
  const f = fixture();
  for (const target of source.targets) {
    const [os, arch] = target.split('-');
    assert.equal(
      platform(os, arch, () =>
        f.api.resolveOwnedEffectCompiler({ from: f.from }),
      ).target,
      target,
    );
  }
  for (const [os, arch, libc] of [
    ['linux', 'x64', 'musl'],
    ['win32', 'arm64', 'gnu'],
    ['freebsd', 'x64', 'gnu'],
  ]) {
    assert.deepEqual(
      platform(
        os,
        arch,
        () => f.api.resolveOwnedEffectCompiler({ from: f.from }),
        libc,
      ),
      { kind: 'absent' },
    );
  }
  fs.appendFileSync(path.join(f.payload, 'darwin-arm64/tsrs'), 'corruption');
  assert.throws(() =>
    platform('freebsd', 'x64', () =>
      f.api.resolveOwnedEffectCompiler({ from: f.from }),
    ),
  );
});

for (const [name, data] of [
  ['@effect/tsgo', { version: '0.66.0' }],
  ['tsrs', { version: '0.20.0' }],
  [
    'tsrs',
    {
      version: source.tsrs.version,
      tsrs: {
        typescriptVersion: source.typescript.version,
        typescriptCommit: 'b'.repeat(40),
      },
    },
  ],
]) {
  test(`rejects installed identity mismatch: ${name} ${JSON.stringify(data)}`, () => {
    const f = fixture();
    f.identity(name, data);
    assert.throws(() => selected(f), /identity/);
  });
}

test('embedded compiler identity is independent of the npm TypeScript adapter', () => {
  const f = fixture();
  assert.equal(selected(f).typescriptVersion, source.typescript.version);
  fs.rmSync(path.join(f.directory, 'node_modules/typescript'), {
    recursive: true,
  });
  assert.equal(selected(f).kind, 'owned');
});

test('rejects missing installed tools and wrong tsrs platform metadata', () => {
  const f = fixture();
  fs.rmSync(path.join(f.directory, 'node_modules/@effect'), {
    recursive: true,
  });
  assert.throws(() => selected(f));
  const g = fixture();
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(g.directory, 'node_modules/tsrs/package.json'),
      'utf8',
    ),
  );
  pkg.optionalDependencies['@tsrs/darwin-arm64'] = 'wrong';
  g.identity('tsrs', pkg);
  assert.throws(() => selected(g), /platform contract/);
});

test('matching explicit and both env overrides cannot replace owned selection', () => {
  const f = fixture();
  const copy = path.join(f.directory, 'FAKE-override');
  fs.copyFileSync(path.join(f.payload, 'darwin-arm64/tsrs'), copy);
  fs.chmodSync(copy, 0o755);
  process.env.TSRS_BINARY = copy;
  process.env.EFFECT_TSGO_BIN = copy;
  try {
    assert.equal(
      selected(f, { configuredExecutable: copy }).executable,
      path.join(f.payload, 'darwin-arm64/tsrs'),
    );
    fs.appendFileSync(copy, 'bad');
    assert.throws(
      () => selected(f, { configuredExecutable: copy }),
      /override differs/,
    );
  } finally {
    delete process.env.TSRS_BINARY;
    delete process.env.EFFECT_TSGO_BIN;
  }
});

for (const name of ['configuredExecutable', 'TSRS_BINARY', 'EFFECT_TSGO_BIN']) {
  test(`enforces ${name} independently, including alongside a matching override`, () => {
    const f = fixture();
    const good = path.join(f.payload, 'darwin-arm64/tsrs');
    const bad = path.join(f.directory, 'bad-override');
    fs.writeFileSync(bad, 'FAKE DIFFERENT', { mode: 0o755 });
    try {
      if (name !== 'configuredExecutable') process.env[name] = bad;
      assert.throws(() =>
        selected(f, {
          configuredExecutable: name === 'configuredExecutable' ? bad : good,
        }),
      );
    } finally {
      delete process.env[name];
    }
  });
}

test('overrides cannot bypass source or inventory corruption; symlink overrides fail', () => {
  const f = fixture();
  const good = path.join(f.payload, 'darwin-arm64/tsrs');
  const linked = path.join(f.directory, 'linked-override');
  fs.symlinkSync(good, linked);
  assert.throws(() => selected(f, { configuredExecutable: linked }), /symlink/);
  f.manifest.source.tsrs.version = 'wrong';
  f.save();
  assert.throws(() => selected(f, { configuredExecutable: good }), /source/);
});

test('selection performs no writes, native execution, or download', () => {
  const f = fixture();
  const originals = new Map();
  const child = require('node:child_process');
  for (const [object, keys] of [
    [fs, ['writeFileSync', 'copyFileSync', 'chmodSync', 'mkdirSync']],
    [
      child,
      ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile'],
    ],
    [globalThis, ['fetch']],
  ]) {
    for (const key of keys) {
      originals.set([object, key], object[key]);
      object[key] = () => {
        throw new Error(`forbidden selection side effect: ${key}`);
      };
    }
  }
  try {
    assert.equal(selected(f).kind, 'owned');
  } finally {
    for (const [[object, key], value] of originals) object[key] = value;
  }
});

test('package includes raw compiler files and keeps payload git-ignore separate from npm', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  assert.ok(pkg.files.includes('compiler'));
  assert.equal(
    pkg.exports['./internal-effect-payload'].types,
    './compiler/resolve.d.cts',
  );
  assert.match(
    fs.readFileSync(path.join(originalCompiler, '.gitignore'), 'utf8'),
    /\/payload\//,
  );
  assert.ok(fs.existsSync(path.join(originalCompiler, '.npmignore')));
  assert.ok(
    !fs
      .readFileSync(path.join(originalCompiler, 'resolve.cjs'), 'utf8')
      .includes('/dist/'),
  );
});

test('requires TypeScript license and hashes all notice bytes', () => {
  const f = fixture();
  const inventory = f.manifest.targets['darwin-arm64'];
  inventory.files = inventory.files.filter(
    file => !file.path.endsWith('LICENSE-TypeScript'),
  );
  fs.rmSync(path.join(f.payload, 'darwin-arm64/notices/LICENSE-TypeScript'));
  f.save();
  assert.throws(() => selected(f), /LICENSE-TypeScript/);
  const g = fixture();
  fs.appendFileSync(
    path.join(g.payload, 'darwin-arm64/notices/LICENSE-Effect'),
    'tampered',
  );
  assert.throws(() => selected(g), /SHA-256/);
});

test('Linux report probes distinguish GNU, musl and unknown without native execution', () => {
  const f = fixture();
  const osDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  const read = fs.readFileSync;
  const report = process.report.getReport;
  const excluded = process.report.excludeNetwork;
  const child = require('node:child_process');
  const exec = child.execFileSync;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  fs.readFileSync = function (file, ...args) {
    if (file === '/usr/bin/ldd') throw new Error('no ldd fixture');
    return read.call(this, file, ...args);
  };
  child.execFileSync = () => {
    throw new Error('native execution forbidden');
  };
  try {
    process.report.getReport = () => ({
      header: { glibcVersionRuntime: '2.39' },
    });
    assert.equal(
      f.api.resolveOwnedEffectCompiler({ from: f.from }).target,
      'linux-x64',
    );
    process.report.getReport = () => ({
      sharedObjects: ['/lib/ld-musl-x86_64.so.1'],
    });
    assert.deepEqual(f.api.resolveOwnedEffectCompiler({ from: f.from }), {
      kind: 'absent',
    });
    process.report.getReport = () => ({});
    assert.deepEqual(f.api.resolveOwnedEffectCompiler({ from: f.from }), {
      kind: 'absent',
    });
    process.report.getReport = () => {
      throw new Error('report disabled');
    };
    assert.deepEqual(f.api.resolveOwnedEffectCompiler({ from: f.from }), {
      kind: 'absent',
    });
    assert.equal(process.report.excludeNetwork, excluded);
  } finally {
    fs.readFileSync = read;
    process.report.getReport = report;
    child.execFileSync = exec;
    Object.defineProperty(process, 'platform', osDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
  }
});
