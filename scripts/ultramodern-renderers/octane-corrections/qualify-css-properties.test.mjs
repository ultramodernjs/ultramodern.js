import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { qualifyCSSProperties } from './qualify-css-properties.mjs';

// Run under owned-temp-dir. Supply real installed/extracted package directories:
// OCTANE_CSS_CONSUMER, OCTANE_CSSTYPE_3_2_3, OCTANE_CSSTYPE_3_2_4.
// The consumer must resolve octane, @types/react and typescript/unstable/sync.
test('the source-only CSS correction passes real complete declarations across csstype identities', async t => {
  assert(process.env.OWNED_TEMP_DIR, 'Run inside owned-temp-dir');
  const consumer = fs.realpathSync(process.env.OCTANE_CSS_CONSUMER);
  const css323 = fs.realpathSync(process.env.OCTANE_CSSTYPE_3_2_3);
  const css324 = fs.realpathSync(process.env.OCTANE_CSSTYPE_3_2_4);
  for (const [root, expected] of [
    [css323, '3.2.3'],
    [css324, '3.2.4'],
  ])
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
      expected,
    );
  const request = createRequire(path.join(consumer, 'package.json'));
  assert.equal(
    JSON.parse(fs.readFileSync(request.resolve('typescript/package.json')))
      .version,
    '7.0.2',
  );
  const octane = fs.realpathSync(path.join(consumer, 'node_modules/octane'));
  const installed = fs.readFileSync(
    path.join(octane, 'dist/jsx-runtime.d.ts'),
    'utf8',
  );
  const before =
    'extends React.CSSProperties, CSS.PropertiesHyphen<string | number>';
  const after =
    "extends Omit<React.CSSProperties, 'viewTransitionScope'>, Omit<CSS.PropertiesHyphen<string | number>, keyof React.CSSProperties>";
  // Reverse the known correction for the fail-before mutation even after adoption.
  const original = installed.replace(after, before);
  assert(original.includes(before));
  const work = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'css-source-proof-'),
  );
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const source = path.join(work, 'packages/octane/src/jsx-runtime.d.ts');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, original);
  const baseline = path.join(work, 'before.d.ts');
  fs.writeFileSync(baseline, original);
  const patch = fileURLToPath(
    new URL('octane-0.20.0/css-properties-source.patch', import.meta.url),
  );
  execFileSync('git', ['apply', '--check', patch], { cwd: work });
  execFileSync('git', ['apply', patch], { cwd: work });
  assert.equal(
    fs.readFileSync(source, 'utf8'),
    original.replace(before, after),
    'Only the extends clause may change; preserve the complete declaration body',
  );
  for (const [name, octaneCss, reactCss, failure] of [
    ['mixed-3.2.3-3.2.4', css323, css324, /TS2320/u],
    ['same-3.2.4-viewTransitionScope', css324, css324, /TS2430/u],
  ]) {
    const options = { consumer, work, octaneCss, reactCss };
    await assert.rejects(
      qualifyCSSProperties({ ...options, declarationFile: baseline }),
      failure,
    );
    t.diagnostic(`${name} before: rejected with ${failure.source}`);
    const result = await qualifyCSSProperties({
      ...options,
      declarationFile: source,
    });
    assert.equal(result.negativeDiagnostics.length, 5);
    t.diagnostic(
      `${name} after: passed; negative controls TS${result.negativeDiagnostics.map(d => d.code).join(', TS')}`,
    );
  }
  await qualifyCSSProperties({
    consumer,
    work,
    declarationFile: source,
    octaneCss: css323,
    reactCss: css323,
  });
  assert.equal(
    fs.readFileSync(path.join(octane, 'dist/jsx-runtime.d.ts'), 'utf8'),
    installed,
  );
});
