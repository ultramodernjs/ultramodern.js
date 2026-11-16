import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { registerOwnedRoot } from '../ultramodern-production-readiness/react-rsc-worker-proof/lifecycle.mjs';
import { verifySidecar } from './verify-sidecars.mjs';

assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
assert.equal(
  typeof vm.SourceTextModule,
  'function',
  'Run Node with --experimental-vm-modules for actual ESM remote entries',
);

const directory = fs.mkdtempSync(
  path.join(process.env.OWNED_TEMP_DIR, 'mf-node-entry-'),
);
const packages = path.join(directory, 'node_modules/@module-federation');
const owner = `mf-node-entry-${process.pid}`;
const require = createRequire(path.join(directory, 'package.json'));
const routes = new Map();
const formats = new Map();
let origin;
let sequence = 0;
let registered = false;

const container = (name, renderer = 'octane') => `
module.exports = {
  renderer: ${JSON.stringify(renderer)},
  init() {},
  get(expose) {
    globalThis[${JSON.stringify(`${name}_factoryCalls`)}] =
      (globalThis[${JSON.stringify(`${name}_factoryCalls`)}] || 0) + 1;
    return () => ({ value: "healthy", expose });
  }
};`;

const server = http.createServer((request, response) => {
  const route = routes.get(request.url);
  assert(route, `Unknown test route ${request.url}`);
  route.requests += 1;
  if (route.mode === 'headers-hang') return;
  response.writeHead(route.mode === '503' ? 503 : 200, {
    'content-type': 'application/javascript',
    'x-entry-test': route.name,
  });
  if (route.mode === 'body-hang') {
    response.write('module.exports =');
    return;
  }
  response.end(
    route.mode === 'syntax-error' ? 'module.exports =' : route.source,
  );
});

before(async () => {
  registered =
    registerOwnedRoot({
      workDir: directory,
      owner,
      ownerPid: process.pid,
    }).status === 'registered';
  fs.mkdirSync(packages, { recursive: true });
  await verifySidecar('mf-sdk', {
    materializeTo: path.join(packages, 'sdk'),
  });
  await verifySidecar('mf-runtime-core', {
    materializeTo: path.join(packages, 'runtime-core'),
  });

  // The core's one unmodified runtime dependency is authenticated independently.
  const bytes = Buffer.from(
    await (
      await fetch(
        'https://registry.npmjs.org/@module-federation/error-codes/-/error-codes-2.9.3.tgz',
        { signal: AbortSignal.timeout(30_000) },
      )
    ).arrayBuffer(),
  );
  assert.equal(
    createHash('sha512').update(bytes).digest('base64'),
    'sXWo6XHOFKC1Dcu9DcSA1okZjtIz2y3uM+NJrAoSpeZ9QSPXielkMWT5PtG7MqGE3OQ+/HDawiLK53IOi3NHcQ==',
  );
  const errorCodes = path.join(packages, 'error-codes');
  fs.mkdirSync(errorCodes);
  const tarball = path.join(directory, 'error-codes.tgz');
  fs.writeFileSync(tarball, bytes);
  execFileSync('tar', [
    '-xzf',
    tarball,
    '--strip-components=1',
    '-C',
    errorCodes,
  ]);

  for (const [format, extension] of [
    ['CJS', 'cjs'],
    ['ESM', 'js'],
  ]) {
    const module = filename => path.join(packages, filename);
    formats.set(format, {
      sdk:
        format === 'CJS'
          ? require(module(`sdk/dist/node.${extension}`))
          : await import(pathToFileURL(module(`sdk/dist/node.${extension}`))),
      core:
        format === 'CJS'
          ? require(module(`runtime-core/dist/index.${extension}`))
          : await import(
              pathToFileURL(module(`runtime-core/dist/index.${extension}`))
            ),
    });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  if (registered)
    execFileSync('disk-guardian-artifacts', [
      'release',
      directory,
      '--owner',
      owner,
    ]);
  fs.rmSync(directory, { recursive: true, force: true });
});

function entry(mode = 'healthy', renderer = 'octane') {
  const name = `node_entry_${++sequence}`;
  const url = `/entry-${sequence}.js`;
  const route = {
    name,
    mode,
    requests: 0,
    source: container(name, renderer),
  };
  routes.set(url, route);
  return { route, url: `${origin}${url}` };
}

function boundedFetch(deadline = 250, observations = []) {
  return async (url, init) => {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(deadline)])
      : AbortSignal.timeout(deadline);
    const response = await fetch(url, { ...init, signal });
    observations.push({
      url,
      status: response.status,
      headers: response.headers,
    });
    assert(response.ok, `Remote entry returned HTTP ${response.status}`);
    // The deadline remains attached to the native response's body stream.
    return response;
  };
}

function host(core, fixture, fetchHook, hooks = {}, type = 'commonjs-module') {
  return new core.ModuleFederation({
    name: `node_entry_host_${++sequence}`,
    remotes: [
      {
        name: fixture.route.name,
        entry: fixture.url,
        type,
        entryGlobalName: fixture.route.name,
      },
    ],
    plugins: [{ name: `entry_fetch_${sequence}`, fetch: fetchHook, ...hooks }],
  });
}

function esmGraph(failure) {
  const remote = entry();
  const child = entry();
  const leaf = entry(failure === 'evaluation-error' ? 'healthy' : failure);
  remote.route.source = `
import { value } from "./${path.basename(new URL(child.url).pathname)}";
export const renderer = "octane";
export function init() {}
export function get(expose) { return () => ({value, expose}); }`;
  child.route.source = `
export { value } from "./${path.basename(new URL(leaf.url).pathname)}";`;
  leaf.route.source =
    failure === 'evaluation-error'
      ? 'throw new Error("evaluation blocked"); export const value = "healthy";'
      : 'export const value = "healthy";';
  return { remote, child, leaf };
}

for (const format of ['CJS', 'ESM']) {
  test(`${format}: the SDK calls its declared fetch tuple and consumes its response`, async () => {
    const { sdk } = formats.get(format);
    const fixture = entry();
    const observations = [];
    const fetchHook = boundedFetch(1000, observations);
    let tuple;
    await sdk.loadScriptNode(fixture.url, {
      attrs: { name: fixture.route.name, globalName: fixture.route.name },
      loaderHook: {
        async fetch(args) {
          tuple = args;
          return fetchHook(...args);
        },
      },
    });
    assert.deepEqual(tuple, [fixture.url, {}]);
    assert.equal(observations[0].status, 200);
    assert.equal(
      observations[0].headers.get('x-entry-test'),
      fixture.route.name,
    );
    assert.equal(globalThis[fixture.route.name].renderer, 'octane');
    assert.equal(fixture.route.requests, 1);
  });

  test(`${format}: a declined SDK hook uses the normal fetch loader`, async () => {
    const { sdk } = formats.get(format);
    const fixture = entry();
    await sdk.loadScriptNode(fixture.url, {
      attrs: { name: fixture.route.name, globalName: fixture.route.name },
      loaderHook: { fetch: () => false },
    });
    assert.equal(fixture.route.requests, 1);
    assert.equal(globalThis[fixture.route.name].renderer, 'octane');
  });

  test(`${format}: the SDK propagates an aborted response body without evaluating it`, async () => {
    const { sdk } = formats.get(format);
    const fixture = entry('body-hang');
    const controller = new AbortController();
    await assert.rejects(
      sdk.loadScriptNode(fixture.url, {
        attrs: { name: fixture.route.name, globalName: fixture.route.name },
        loaderHook: {
          async fetch([url, init]) {
            const response = await fetch(url, {
              ...init,
              signal: controller.signal,
            });
            assert.equal(response.status, 200);
            controller.abort(new Error('The response body was cancelled'));
            return response;
          },
        },
      }),
      /cancelled/u,
    );
    assert.equal(fixture.route.requests, 1);
    assert.equal(globalThis[fixture.route.name], undefined);
  });

  test(`${format}: the core forwards remote identity and current resource URL to fetch`, async () => {
    const { core } = formats.get(format);
    const fixture = entry();
    const rewritten = entry();
    const context = {
      initiator: 'loadRemote',
      id: `${fixture.route.name}/Card`,
      resourceType: 'remoteEntry',
      url: fixture.url,
      expose: './Card',
    };
    let observed;
    const instance = host(
      core,
      fixture,
      async (...args) => {
        observed = args;
        return fetch(args[0], args[1]);
      },
      { createScript: () => ({ url: rewritten.url }) },
    );
    const remoteInfo = core.getRemoteInfo(instance.options.remotes[0]);
    const loaded = await core.getRemoteEntry({
      origin: instance,
      remoteInfo,
      resourceContext: context,
    });
    assert.equal(loaded.renderer, 'octane');
    assert.equal(observed[0], rewritten.url);
    assert.deepEqual(observed[1], {});
    assert.equal(observed[2], remoteInfo);
    assert.deepEqual(observed[3], { ...context, url: rewritten.url });
    assert.equal(context.url, fixture.url);
    assert.equal(fixture.route.requests, 0);
    assert.equal(rewritten.route.requests, 1);
  });

  for (const failure of ['503', 'headers-hang', 'body-hang']) {
    test(`${format}: ${failure} can recover in the same host without deleting caches`, async () => {
      const { core } = formats.get(format);
      const fixture = entry(failure);
      const observations = [];
      const admissions = [];
      const fetchHook = boundedFetch(250, observations);
      let remote;
      const instance = host(
        core,
        fixture,
        async (url, init, remoteInfo) => {
          remote = remoteInfo;
          return fetchHook(url, init);
        },
        { afterLoadEntry: info => admissions.push(info) },
      );
      const id = `${fixture.route.name}/Card`;
      await assert.rejects(instance.loadRemote(id));
      assert.equal(remote.name, fixture.route.name);
      assert.equal(fixture.route.requests, 1);
      assert(admissions.some(info => info.error));
      assert.equal(globalThis[`${fixture.route.name}_factoryCalls`], undefined);
      if (failure === '503') assert.equal(observations[0].status, 503);
      if (failure === 'body-hang') assert.equal(observations[0].status, 200);

      fixture.route.mode = 'healthy';
      assert.deepEqual(await instance.loadRemote(id), {
        value: 'healthy',
        expose: './Card',
      });
      assert.equal(fixture.route.requests, 2);
      assert(admissions.some(info => info.remoteEntryExports));
      assert.equal(globalThis[`${fixture.route.name}_factoryCalls`], 1);
    });
  }

  test(`${format}: concurrent healthy loads retain the canonical entry request`, async () => {
    const { core } = formats.get(format);
    const fixture = entry();
    const instance = host(core, fixture, boundedFetch(1000));
    const id = `${fixture.route.name}/Card`;
    const loaded = await Promise.all([
      instance.loadRemote(id),
      instance.loadRemote(id),
    ]);
    assert.deepEqual(loaded[0], loaded[1]);
    assert.equal(fixture.route.requests, 1);
  });

  for (const failure of [
    'headers-hang',
    'body-hang',
    'syntax-error',
    'evaluation-error',
  ]) {
    test(`${format}: actual ESM remote import ${failure} can recover without clearing healthy modules`, async () => {
      const { core } = formats.get(format);
      const { remote, child, leaf } = esmGraph(failure);
      const instance = host(core, remote, boundedFetch(), {}, 'esm');
      const id = `${remote.route.name}/Card`;
      await assert.rejects(instance.loadRemote(id));
      assert.equal(remote.route.requests, 1);
      assert.equal(child.route.requests, 1);
      assert.equal(leaf.route.requests, 1);
      leaf.route.mode = 'healthy';
      leaf.route.source = 'export const value = "healthy";';
      assert.deepEqual(await instance.loadRemote(id), {
        value: 'healthy',
        expose: './Card',
      });
      assert.equal(remote.route.requests, 2);
      assert.equal(child.route.requests, 2);
      assert.equal(leaf.route.requests, 2);
    });
  }

  test(`${format}: actual ESM concurrent remote calls retain one entry request`, async () => {
    const { core } = formats.get(format);
    const { remote, child, leaf } = esmGraph('healthy');
    const instance = host(core, remote, boundedFetch(1000), {}, 'esm');
    const id = `${remote.route.name}/Card`;
    const loaded = await Promise.all([
      instance.loadRemote(id),
      instance.loadRemote(id),
    ]);
    assert.deepEqual(loaded[0], loaded[1]);
    assert.equal(loaded[0].value, 'healthy');
    assert.equal(remote.route.requests, 1);
    assert.equal(child.route.requests, 1);
    assert.equal(leaf.route.requests, 1);
  });

  test(`${format}: a failed ESM graph preserves a healthy module shared with another remote`, async () => {
    const { core } = formats.get(format);
    const { remote, child, leaf } = esmGraph('headers-hang');
    const healthy = entry();
    const stable = entry();
    const evaluationKey = `${stable.route.name}_evaluations`;
    stable.route.source = `
globalThis[${JSON.stringify(evaluationKey)}] =
  (globalThis[${JSON.stringify(evaluationKey)}] || 0) + 1;
export const healthy = "retained";`;
    remote.route.source =
      `import "./${path.basename(new URL(stable.url).pathname)}";\n` +
      remote.route.source;
    healthy.route.source = `
import { healthy } from "./${path.basename(new URL(stable.url).pathname)}";
export function init() {}
export function get() { return () => healthy; }`;
    const goodHost = host(core, healthy, boundedFetch(1000), {}, 'esm');
    const badHost = host(core, remote, boundedFetch(), {}, 'esm');
    assert.equal(
      await goodHost.loadRemote(`${healthy.route.name}/Card`),
      'retained',
    );
    const [bad, good] = await Promise.allSettled([
      badHost.loadRemote(`${remote.route.name}/Card`),
      goodHost.loadRemote(`${healthy.route.name}/Card`),
    ]);
    assert.equal(bad.status, 'rejected');
    assert.equal(good.status, 'fulfilled');
    assert.equal(good.value, 'retained');
    const retainedRequests = stable.route.requests;
    assert.equal(globalThis[evaluationKey], 1);
    leaf.route.mode = 'healthy';
    await badHost.loadRemote(`${remote.route.name}/Card`);
    assert.equal(child.route.requests, 2);
    assert.equal(stable.route.requests, retainedRequests);
    assert.equal(globalThis[evaluationKey], 1);
  });

  test(`${format}: invalid entry code and renderer admission fail before the remote factory`, async () => {
    const { core } = formats.get(format);
    for (const mode of ['syntax-error', 'healthy']) {
      const fixture = entry(mode, 'react');
      const instance = host(core, fixture, boundedFetch(1000), {
        afterLoadEntry({ remoteEntryExports }) {
          if (remoteEntryExports)
            assert.equal(remoteEntryExports.renderer, 'octane');
        },
      });
      const id = `${fixture.route.name}/Card`;
      await assert.rejects(instance.loadRemote(id));
      assert.equal(fixture.route.requests, 1);
      assert.equal(globalThis[`${fixture.route.name}_factoryCalls`], undefined);
      if (mode === 'healthy') {
        await assert.rejects(instance.loadRemote(id));
        assert.equal(fixture.route.requests, 1);
        assert.equal(
          globalThis[`${fixture.route.name}_factoryCalls`],
          undefined,
        );
      }
    }
  });
}
