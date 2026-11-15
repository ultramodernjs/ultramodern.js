import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReleaseCompilerPayload,
  producerIdentity,
  produceTarget,
  stagePayload,
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

test('aggregation requires all five platforms and never fills gaps', t => {
  const root = fixture(t);
  const input = matrix(root);
  fs.rmSync(path.join(input, source.targets[0]), { recursive: true });
  assert.throws(
    () => stagePayload({ input, output: path.join(root, 'output'), env }),
    /complete five-target/,
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

test('producer rejects unsupported platform without creating an output', t => {
  const root = fixture(t);
  assert.throws(
    () =>
      produceTarget({
        artifactDir: root,
        target: 'linux-x64-musl',
        output: path.join(root, 'out'),
        env,
      }),
    /unsupported target/,
  );
});

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
  assert.deepEqual(
    Object.keys(manifest.targets).sort(),
    [...source.targets].sort(),
  );
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
