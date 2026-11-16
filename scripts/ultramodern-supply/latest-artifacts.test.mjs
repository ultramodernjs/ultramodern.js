import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { collectSidecarPackages } from '../ultramodern-publish/lib/prepare-bleedingdev-packages/sidecars.mjs';
import { assertRecipeGraph, verifySidecar } from './verify-sidecars.mjs';

assert.ok(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
const directory = fs.mkdtempSync(
  path.join(process.env.OWNED_TEMP_DIR, 'latest-artifacts-'),
);
const recipes = JSON.parse(
  fs.readFileSync(new URL('./sidecars.json', import.meta.url), 'utf8'),
);
let redact;
let server;
const packageDirectory = id => path.join(directory, id);

before(async () => {
  assertRecipeGraph(recipes);
  for (const recipe of recipes) {
    await verifySidecar(recipe.id, {
      materializeTo: packageDirectory(recipe.id),
    });
  }
  const load = file =>
    import(
      pathToFileURL(
        path.join(packageDirectory('tanstack-redact'), 'dist', file),
      )
    );
  redact = await load('react/index.js');
  server = await load('server/index.js');
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('latest recipes preserve complete identities, notices and exact correction edges', () => {
  assert.equal(collectSidecarPackages().length, 21);
  for (const recipe of recipes) {
    const root = packageDirectory(recipe.id);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, recipe.fork.name);
    assert.equal(manifest.version, recipe.fork.version);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(
      semver.satisfies(manifest.version, `~${recipe.upstream.version}`),
      `${recipe.id}: stable fork must remain in its upstream peer-compatible line`,
    );
    assert.equal(manifest.license, recipe.license);
    assert.ok(
      fs.readdirSync(root).some(name => /^licen[cs]e(?:\.|$)/iu.test(name)),
      `${recipe.id}: missing notice`,
    );
    for (const [block, changes] of Object.entries(recipe.manifestChanges)) {
      for (const [name, version] of Object.entries(changes))
        assert.equal(manifest[block][name], version);
    }
  }
});

test('the unchanged publication gate rejects prerelease sidecar identities', () => {
  const root = path.join(directory, 'stable-gate');
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });
  const manifest = {
    name: '@bleedingdev/stable-gate-probe',
    version: '0.3.2',
    license: 'MIT',
    publishConfig: { access: 'public' },
  };
  const write = () =>
    fs.writeFileSync(
      path.join(root, 'fixture/package.json'),
      JSON.stringify(manifest),
    );
  write();
  assert.equal(
    collectSidecarPackages(root, { roots: ['fixture'] })[0].version,
    '0.3.2',
  );
  manifest.version = '0.3.1-ultramodern.1';
  write();
  assert.throws(
    () => collectSidecarPackages(root, { roots: ['fixture'] }),
    /must be stable semver/u,
  );
});

test('Redact emitted runtime keeps tree-position IDs and pre-read boundary completion inline', async () => {
  const { createElement: h, Suspense, useId } = redact;
  function Field() {
    return h('label', { id: useId() }, 'field');
  }
  const tree = h('div', null, h(Field), h(Field));
  const html = server.renderToString(tree);
  const ids = [...html.matchAll(/ id="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^_R_[0-9a-z]+_$/u);
  assert.equal(server.renderToString(tree), html);
  let finish;
  let ready = false;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  function Async() {
    if (!ready) throw pending;
    return h('b', null, 'done');
  }
  const stream = await server.renderToReadableStream(
    h(Suspense, { fallback: 'waiting' }, h(Async)),
    { identifierPrefix: 'pref:' },
  );
  ready = true;
  finish();
  await stream.allReady;
  const output = await new Response(stream).text();
  assert.match(output, /<b>done<\/b>/u);
  assert.doesNotMatch(output, /waiting|hidden|\$RC/u);
});

test('Redact regenerated source maps carry the corrected source in its new hydration layer', () => {
  const root = packageDirectory('tanstack-redact');
  const relative = 'dom/features/suspense-hydration/full';
  const source = fs.readFileSync(path.join(root, `src/${relative}.ts`), 'utf8');
  const map = JSON.parse(
    fs.readFileSync(path.join(root, `dist/${relative}.js.map`), 'utf8'),
  );
  assert.ok(source.includes('fiber.b.x = dispose'));
  assert.ok(
    map.sourcesContent.some(content => content.includes('fiber.b.x = dispose')),
  );
  assert.ok(fs.statSync(path.join(root, `dist/${relative}.d.ts`)).size > 0);
});

test('Redact pending boundaries retain prefixed transport IDs after the shell is read', async () => {
  const { createElement: h, Suspense } = redact;
  let finish;
  let ready = false;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  function Async() {
    if (!ready) throw pending;
    return h('b', null, 'resolved');
  }
  const stream = await server.renderToReadableStream(
    h(Suspense, { fallback: 'waiting' }, h(Async)),
    { identifierPrefix: 'pref:' },
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = decoder.decode((await reader.read()).value);
  assert.match(output, /waiting/u);
  assert.match(output, /pref:B:0/u);
  ready = true;
  finish();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  await stream.allReady;
  assert.match(output, /pref:S:0/u);
  assert.match(output, /<b>resolved<\/b>/u);
});
