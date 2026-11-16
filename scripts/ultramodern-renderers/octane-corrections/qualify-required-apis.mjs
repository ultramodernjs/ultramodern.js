import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Strict public-API and genuine stable-TypeScript consumer acceptance.
// Run inside owned-temp-dir with the consumer directory as the argument.
// Missing APIs and stable-TS failures must never become successful receipts.
assert(
  process.env.OWNED_TEMP_DIR,
  'Use owned-temp-dir --run for the fixture lifecycle',
);
assert(process.argv[2], 'Pass the installed consumer root');
const consumer = fs.realpathSync(process.argv[2]);
const request = createRequire(path.join(consumer, 'package.json'));
const results = [];
for (const [specifier, required] of [
  [
    'octane',
    [
      'registerExternalSnapshotContext',
      'decodeExternalSnapshot',
      'serializeExternalSnapshotRequest',
      'externalSnapshotBoundary',
      'publisherBoundary',
      'preparePublisherBoundaryReplacement',
    ],
  ],
  [
    'octane/server',
    [
      'registerExternalSnapshotContext',
      'decodeExternalSnapshotRequest',
      'serializeExternalSnapshot',
      'externalSnapshotBoundary',
      'publisherBoundary',
      'prepareExternalSnapshotRequest',
      'releasePreparedExternalSnapshotRequest',
      'renderExternalSnapshot',
    ],
  ],
]) {
  try {
    const api = await import(pathToFileURL(request.resolve(specifier)).href);
    const missing = required.filter(name => typeof api[name] !== 'function');
    assert.deepEqual(
      missing,
      [],
      `${specifier}: missing required published APIs`,
    );
    results.push({ check: specifier, status: 'PASS' });
  } catch (error) {
    results.push({ check: specifier, status: 'FAIL', error: error.message });
  }
}
const fixture = fs.mkdtempSync(
  path.join(process.env.OWNED_TEMP_DIR, 'stable-ts7-'),
);
let project;
try {
  const tsManifest = JSON.parse(
    fs.readFileSync(request.resolve('typescript/package.json')),
  );
  assert.equal(tsManifest.version, '7.0.2');
  fs.symlinkSync(
    path.join(consumer, 'node_modules'),
    path.join(fixture, 'node_modules'),
  );
  const source =
    'export function App(props: { label: string; count: number }) { return <p>{props.label}{props.count}</p>; }';
  fs.writeFileSync(path.join(fixture, 'App.tsx'), source);
  fs.writeFileSync(
    path.join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        jsxImportSource: 'octane',
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ['*.tsx'],
    }),
  );
  const { createTextTypeProject } = await import(
    pathToFileURL(request.resolve('octane/compiler/typescript')).href
  );
  project = createTextTypeProject({
    tsconfig: path.join(fixture, 'tsconfig.json'),
    typescript: path.dirname(request.resolve('typescript/package.json')),
  });
  const facts = project.snapshot('App.tsx');
  assert.deepEqual(
    facts.stringChildRanges.map(([start, end]) => source.slice(start, end)),
    ['props.label'],
  );
  assert(
    facts.primitiveTextChildRanges.some(
      ([start, end]) => source.slice(start, end) === 'props.count',
    ),
  );
  results.push({ check: 'stable TypeScript 7.0.2 text facts', status: 'PASS' });
} catch (error) {
  results.push({
    check: 'stable TypeScript 7.0.2 text facts',
    status: 'FAIL',
    error: error.stack,
  });
} finally {
  project?.dispose();
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.some(result => result.status !== 'PASS') ? 1 : 0;
