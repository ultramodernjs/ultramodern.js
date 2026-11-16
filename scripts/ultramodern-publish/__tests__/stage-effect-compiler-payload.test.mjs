import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildInputs,
  restoreBuild,
  snapshotBuild,
} from '../../ci/prepared-build-cache.mjs';
import {
  assertCachedSourceIdentity,
  assertReleaseCompilerPayload,
  producerIdentity,
  produceTarget,
  stagePayload,
  writeCachedSourceIdentity,
} from '../stage-effect-compiler-payload.mjs';

const source = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../packages/solutions/app-tools-extensions/compiler/source.json',
      import.meta.url,
    ),
  ),
);
const env = {
  GITHUB_REPOSITORY: 'ultramodernjs/ultramodern.js',
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const toolchain = {
  cargo: 'cargo 1.95.0 (04f5b22a1 2026-09-20)',
  rustc: 'rustc 1.95.0 (6e4b7bbf5 2026-10-01)',
};
const toolchainVersion = command => toolchain[command];
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(
      fs.realpathSync(process.env.OWNED_TEMP_DIR || tmpdir()),
      'compiler-stage-',
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function matrix(root) {
  const input = path.join(root, 'input');
  fs.mkdirSync(input);
  for (const target of source.targets) {
    const directory = path.join(input, target);
    fs.mkdirSync(path.join(directory, target, 'notices'), { recursive: true });
    const name = target.startsWith('win32') ? 'tsrs.exe' : 'tsrs';
    const data = {
      [`${target}/${name}`]: 'fake compiler bytes; never execute',
      [`${target}/lib.d.ts`]: 'declare const fixture: unique symbol;',
      [`${target}/notices/LICENSE-Effect`]: 'MIT License',
      [`${target}/notices/LICENSE-tsrs`]: 'Apache License Version 2.0',
      [`${target}/notices/LICENSE-TypeScript`]: 'Apache License Version 2.0',
      [`${target}/notices/THIRD-PARTY-NOTICES`]: 'Fixture license inventory',
    };
    const files = Object.entries(data).map(([relative, text]) => {
      fs.writeFileSync(path.join(directory, relative), text, {
        mode: relative.endsWith(name) ? 0o755 : 0o644,
      });
      return {
        path: relative,
        size: Buffer.byteLength(text),
        sha256: hash(text),
        executable: relative === `${target}/${name}`,
      };
    });
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        source,
        producer: producerIdentity(env),
        targets: { [target]: { executable: `${target}/${name}`, files } },
      }),
    );
  }
  return input;
}

test('prepared builds bind verified compiler bytes but never restore another run receipt', t => {
  const root = fixture(t);
  const packageRoot = path.join(
    root,
    'packages/solutions/app-tools-extensions',
  );
  const compiler = path.join(packageRoot, 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  for (const filename of [
    'resolve.cjs',
    'resolve.d.cts',
    'source.json',
    'constraint.patch',
  ])
    fs.copyFileSync(
      new URL(
        `../../../packages/solutions/app-tools-extensions/compiler/${filename}`,
        import.meta.url,
      ),
      path.join(compiler, filename),
    );
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'packages'], { cwd: root });
  const inputs = () => buildInputs(root, { CI: 'true' }, { pnpm: '12.11.2' });
  const ordinary = inputs().key;
  const payload = path.join(compiler, 'payload');
  stagePayload({ input: matrix(root), output: payload, env });
  const baseline = inputs();
  assert.notEqual(baseline.key, ordinary);
  const receiptPath = path.join(payload, 'manifest.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.producer.runId = '5678';
  receipt.producer.sourceCommit = 'b'.repeat(40);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal(
    inputs().key,
    baseline.key,
    'run metadata is not compiler identity',
  );

  const output = path.join(packageRoot, 'dist/index.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'compiled with the verified corrected compiler');
  const snapshot = snapshotBuild(root, baseline);
  assert.ok(
    Object.keys(snapshot.outputs).every(
      file => !file.includes('/compiler/payload/'),
    ),
  );
  fs.unlinkSync(output);
  restoreBuild(root, baseline.key);
  assert.equal(
    JSON.parse(fs.readFileSync(receiptPath, 'utf8')).producer.runId,
    '5678',
    'the current run receipt must survive restoring prepared outputs',
  );
  const target = receipt.targets['linux-x64'];
  const executable = target.files.find(file => file.path === target.executable);
  const binary = path.join(payload, executable.path);
  fs.appendFileSync(binary, 'changed compiler bytes');
  assert.throws(inputs, /size or SHA-256 mismatch/u);
  const bytes = fs.readFileSync(binary);
  executable.size = bytes.length;
  executable.sha256 = hash(bytes);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.notEqual(
    inputs().key,
    baseline.key,
    'another compiler cannot reuse the build',
  );
});

test('producer identity requires authenticated repository, source, run and attempt', () => {
  assert.equal(producerIdentity(env).sourceCommit, env.GITHUB_SHA);
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: 'attacker/fork',
    GITHUB_SHA: 'main',
    GITHUB_RUN_ID: '0',
    GITHUB_RUN_ATTEMPT: '',
  }))
    assert.throws(
      () => producerIdentity({ ...env, [key]: value }),
      /authenticated/,
    );
});

test('aggregation rejects another producer run before copying bytes', t => {
  const root = fixture(t);
  const input = matrix(root);
  assert.throws(
    () =>
      stagePayload({
        input,
        output: path.join(root, 'output'),
        env: { ...env, GITHUB_RUN_ID: '4321' },
      }),
    /producer receipt mismatch/,
  );
  assert.equal(fs.existsSync(path.join(root, 'output')), false);
});

test('aggregation requires all source platforms and never fills gaps', t => {
  const root = fixture(t);
  const input = matrix(root);
  fs.rmSync(path.join(input, source.targets[0]), { recursive: true });
  assert.throws(
    () => stagePayload({ input, output: path.join(root, 'output'), env }),
    /complete .*matrix required/,
  );
});

test('aggregation rejects tampered compiler before publishing output', t => {
  const root = fixture(t);
  const input = matrix(root);
  fs.appendFileSync(path.join(input, 'linux-x64/linux-x64/tsrs'), 'tamper');
  const output = path.join(root, 'output');
  assert.throws(
    () => stagePayload({ input, output, env }),
    /digest\/size mismatch/,
  );
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['input']);
});

test('aggregation refuses symlink artifacts and does not touch their destination', t => {
  const root = fixture(t);
  const input = matrix(root);
  fs.renameSync(path.join(input, 'linux-x64'), path.join(root, 'outside'));
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(input, 'linux-x64'),
    'dir',
  );
  assert.throws(
    () => stagePayload({ input, output: path.join(root, 'output'), env }),
    /symlink/,
  );
  assert.ok(fs.existsSync(path.join(root, 'outside/manifest.json')));
});

test('staging refuses to replace any preexisting output', t => {
  const root = fixture(t);
  const input = matrix(root);
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'user'), 'preserve');
  assert.throws(
    () => stagePayload({ input, output, env }),
    /output already exists/,
  );
  assert.equal(fs.readFileSync(path.join(output, 'user'), 'utf8'), 'preserve');
});

for (const target of ['linux-x64-musl', 'darwin-x64']) {
  test(`producer rejects unsupported ${target} without creating an output`, t => {
    const root = fixture(t);
    const output = path.join(root, 'out');
    assert.throws(
      () => produceTarget({ artifactDir: root, target, output, env }),
      /unsupported target/,
    );
    assert.equal(fs.existsSync(output), false);
  });
}

test('complete matrix stages verified bytes and survives artifact mode loss', t => {
  const root = fixture(t);
  const input = matrix(root);
  // GitHub artifact extraction does not preserve executable permissions.
  for (const target of source.targets) {
    if (target.startsWith('win32')) continue;
    fs.chmodSync(path.join(input, target, target, 'tsrs'), 0o644);
  }
  const output = path.join(root, 'verified');
  const manifest = stagePayload({ input, output, env });
  assert.deepEqual(Object.keys(manifest.targets).sort(), [
    'darwin-arm64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]);
  if (process.platform !== 'win32')
    assert.equal(
      fs.statSync(path.join(output, 'linux-x64/tsrs')).mode & 0o777,
      0o755,
    );
  const extracted = path.join(root, 'restaged');
  stagePayload({
    input: output,
    output: extracted,
    completeManifest: true,
    env,
  });
  assert.equal(
    fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'),
  );
});

test('target producer preserves adjacent libraries and notices', t => {
  const root = fixture(t);
  const input = matrix(root);
  const output = path.join(root, 'produced');
  const manifest = produceTarget({
    artifactDir: path.join(input, 'linux-x64/linux-x64'),
    target: 'linux-x64',
    output,
    env,
  });
  assert.equal(manifest.targets['linux-x64'].executable, 'linux-x64/tsrs');
  assert.equal(
    fs.readFileSync(path.join(output, 'linux-x64/lib.d.ts'), 'utf8'),
    'declare const fixture: unique symbol;',
  );
});

// A restored cache entry is the built target directory plus the identity
// receipt beside it; the same-run inventory receipt is never cached.
function restored(root) {
  const input = matrix(root);
  const cache = path.join(root, 'cache');
  for (const target of source.targets) {
    fs.cpSync(
      path.join(input, target, target),
      path.join(cache, target, 'artifact'),
      { recursive: true },
    );
    writeCachedSourceIdentity({
      target,
      output: path.join(cache, target, 'source-identity.json'),
      env,
      toolchainVersion,
    });
  }
  return cache;
}

test('cached bytes record the pinned identity and are accepted once, not twice', t => {
  const root = fixture(t);
  const output = path.join(root, 'cache/linux-x64/source-identity.json');
  const identity = writeCachedSourceIdentity({
    target: 'linux-x64',
    output,
    env,
    toolchainVersion,
  });
  assert.equal(identity.effectBaseCommit, source.effect.baseCommit);
  assert.equal(identity.tsrsSourceCommit, source.tsrs.sourceCommit);
  assert.equal(identity.typescriptSourceCommit, source.typescript.sourceCommit);
  assert.equal(identity.componentVersion, source.tsrs.version);
  assert.equal(identity.optimization, source.optimization);
  assert.equal(identity.patchSha256, source.patchSha256);
  assert.equal(identity.producedBy.sourceCommit, env.GITHUB_SHA);
  assert.deepEqual(
    assertCachedSourceIdentity({ input: output, target: 'linux-x64' }),
    identity,
  );
  assert.throws(
    () =>
      writeCachedSourceIdentity({
        target: 'linux-x64',
        output,
        env,
        toolchainVersion,
      }),
    /EEXIST/,
  );
  assert.throws(
    () =>
      writeCachedSourceIdentity({
        target: 'darwin-x64',
        output: path.join(root, 'unsupported.json'),
        env,
        toolchainVersion,
      }),
    /unsupported target/,
  );
  assert.equal(fs.existsSync(path.join(root, 'unsupported.json')), false);
});

for (const [name, mutate] of [
  ['another target', identity => ({ ...identity, target: 'linux-arm64' })],
  [
    'another TypeScript source',
    identity => ({ ...identity, typescriptSourceCommit: 'f'.repeat(40) }),
  ],
  [
    'another correction patch',
    identity => ({ ...identity, patchSha256: 'f'.repeat(64) }),
  ],
  [
    'another component version',
    identity => ({ ...identity, componentVersion: '0.22.0-ts7.1.0-beta' }),
  ],
  ['an optimized build', identity => ({ ...identity, optimization: 'speed' })],
  ['an unknown field', identity => ({ ...identity, embedded: true })],
  ['no toolchain', ({ toolchain: _ignored, ...rest }) => rest],
  [
    'an unusable rustc',
    identity => ({
      ...identity,
      toolchain: { ...identity.toolchain, rustc: 'unknown' },
    }),
  ],
  [
    'no producer receipt',
    identity => ({ ...identity, producedBy: { runId: '1' } }),
  ],
  ['a bare array', () => []],
]) {
  test(`a restore carrying ${name} is rejected before anything is staged`, t => {
    const root = fixture(t);
    const output = path.join(root, 'source-identity.json');
    const identity = writeCachedSourceIdentity({
      target: 'linux-x64',
      output,
      env,
      toolchainVersion,
    });
    fs.writeFileSync(output, JSON.stringify(mutate(identity)));
    assert.throws(
      () => assertCachedSourceIdentity({ input: output, target: 'linux-x64' }),
      /different pinned source identity|rustc and cargo|producer receipt|not a receipt/,
    );
  });
}

for (const [name, write] of [
  ['A missing', () => {}],
  ['An unparsable', output => fs.writeFileSync(output, '{ not json')],
]) {
  test(`${name} identity receipt is a cache miss, not a staged payload`, t => {
    const root = fixture(t);
    const output = path.join(root, 'source-identity.json');
    write(output);
    assert.throws(
      () => assertCachedSourceIdentity({ input: output, target: 'linux-x64' }),
      /missing or unreadable/,
    );
  });
}

test('the hit path stages restored bytes and rejects tampering after produce', t => {
  const root = fixture(t);
  const cache = restored(root);
  const produced = path.join(root, 'produced');
  for (const target of source.targets) {
    assertCachedSourceIdentity({
      input: path.join(cache, target, 'source-identity.json'),
      target,
    });
    produceTarget({
      artifactDir: path.join(cache, target, 'artifact'),
      target,
      output: path.join(produced, target),
      env,
    });
  }
  const payload = path.join(root, 'payload');
  const manifest = stagePayload({ input: produced, output: payload, env });
  assert.deepEqual(
    Object.keys(manifest.targets).sort(),
    [...source.targets].sort(),
  );
  // The identity receipt sits beside the cached bytes, never inside them.
  assert.equal(
    fs.existsSync(path.join(payload, 'linux-x64/source-identity.json')),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(payload, 'linux-x64/tsrs'), 'utf8'),
    'fake compiler bytes; never execute',
  );
  // Digests bind the produced inventory to the staged bytes within one run.
  // Substituted cache bytes are caught by the identity receipt and the release
  // smoke in `resolve`, not here: produce re-digests whatever it is given.
  fs.appendFileSync(path.join(produced, 'linux-x64/linux-x64/tsrs'), 'tamper');
  assert.throws(
    () =>
      stagePayload({ input: produced, output: path.join(root, 'retry'), env }),
    /digest\/size mismatch/,
  );
  assert.equal(fs.existsSync(path.join(root, 'retry')), false);
});

test('a cached directory without its compiler binary never reaches staging', t => {
  const root = fixture(t);
  const cache = restored(root);
  fs.rmSync(path.join(cache, 'linux-x64/artifact/tsrs'));
  const output = path.join(root, 'produced/linux-x64');
  assert.throws(
    () =>
      produceTarget({
        artifactDir: path.join(cache, 'linux-x64/artifact'),
        target: 'linux-x64',
        output,
        env,
      }),
    /expected one tsrs/,
  );
  assert.equal(fs.existsSync(output), false);
});

const canonicalCompiler = new URL(
  '../../../packages/solutions/app-tools-extensions/compiler/',
  import.meta.url,
);
for (const bootstrap of [
  'resolve.cjs',
  'resolve.d.cts',
  'source.json',
  'constraint.patch',
]) {
  for (const mutation of ['missing', 'changed', 'symlink']) {
    test(`release package rejects ${mutation} bootstrap ${bootstrap}`, t => {
      const root = fixture(t);
      const input = matrix(root);
      const packageRoot = path.join(root, 'package');
      stagePayload({
        input,
        output: path.join(packageRoot, 'compiler/payload'),
        env,
      });
      for (const filename of [
        'resolve.cjs',
        'resolve.d.cts',
        'source.json',
        'constraint.patch',
      ]) {
        fs.writeFileSync(
          path.join(packageRoot, 'compiler', filename),
          fs.readFileSync(new URL(filename, canonicalCompiler)),
        );
      }
      const changed = path.join(packageRoot, 'compiler', bootstrap);
      if (mutation === 'missing') fs.unlinkSync(changed);
      else if (mutation === 'changed') fs.appendFileSync(changed, '\nchanged');
      else {
        const outside = path.join(root, 'outside');
        fs.renameSync(changed, outside);
        fs.symlinkSync(outside, changed);
      }
      assert.throws(
        () => assertReleaseCompilerPayload(packageRoot, { sameRun: false }),
        /bootstrap/,
      );
    });
  }
}
