import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { decodeOctaneSSRDocument } from '../../tests/ultramodern-renderers/octane-federation/fixtures.mjs';
import { createSSRMarkerProxy } from '../../tests/ultramodern-renderers/octane-federation/marker-proxy.mjs';
import {
  launchServer,
  ready,
  reservePort,
} from '../ultramodern-production-readiness/renderer-mf-lifecycle-proof/runtime.mjs';
import {
  installedBin,
  installPackedNativeFederationDependencies,
  readPackedNativeFederationContext,
  recordPackedNativeFederationProcess,
  runPackedNativeFederationCommand,
  runPackedNativeFederationProof,
  verifyPackedNativeFederationDependencies,
} from './native-federation-packed.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const requireHtml = createRequire(
  new URL('../../packages/toolkit/utils/package.json', import.meta.url),
);
const { Window } = await import(requireHtml.resolve('happy-dom'));
const htmlWindow = new Window({
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
  },
});
const htmlParser = new htmlWindow.DOMParser();

/** Require real native markup, including only completed Octane stream HTML. */
export function assertGeneratedNativeFederationSSR({
  html,
  plan,
  renderer,
  route,
}) {
  assert(['solid', 'octane'].includes(renderer));
  let markup = html;
  if (renderer === 'octane') {
    const source = htmlParser.parseFromString(html, 'text/html');
    const carriers = Array.from(
      source.querySelectorAll('div[hidden][data-oct-s]'),
    );
    const completions = Array.from(
      source.querySelectorAll('script[data-octane-stream]:not([type])'),
    );
    const segments = decodeOctaneSSRDocument(html).segments.filter(
      segment =>
        segment.completed &&
        carriers.some(carrier => {
          const payload = carrier.querySelector(
            'script[type="application/json"][data-octane-stream]',
          );
          return (
            carrier.getAttribute('data-oct-s') === segment.id &&
            payload &&
            JSON.parse(payload.textContent) === segment.markup
          );
        }) &&
        completions.some(
          script =>
            script.textContent === `$OCTRC(${JSON.stringify(segment.id)})`,
        ),
    );
    markup = [html, ...segments.map(segment => segment.markup)].join('\n');
  }
  const document = htmlParser.parseFromString(markup, 'text/html');
  for (const inert of document.querySelectorAll('script, style, template'))
    inert.remove();
  const remotes = Array.from(
    document.querySelectorAll('section[data-testid="native-remote"]'),
  );
  assert(remotes.length > 0, `Generated ${route} omitted native remote SSR`);
  const matches = remotes.filter(
    remote => remote.getAttribute('data-remote-id') === plan.remote.id,
  );
  assert.equal(
    matches.length,
    1,
    'Generated native remote SSR must have one matching identity',
  );
  assert(
    matches[0].textContent.includes(plan.host.displayName),
    'Generated remote omitted shell props',
  );
}

/** Select real generated UI/API units and their documented deployment inputs. */
export function planGeneratedNativeFederation({
  workspaceRoot,
  topology,
  workspaceResult,
  verticalResult,
  renderer,
  hostPort,
  remotePort,
}) {
  assert(['solid', 'octane'].includes(renderer));
  const shellDescriptor = workspaceResult.createdApps.find(
    app => app.kind === 'shell',
  );
  const remoteDescriptor = verticalResult.createdApps.find(
    app => app.kind === 'vertical',
  );
  assert(
    shellDescriptor && remoteDescriptor,
    'Public SDK omitted the generated UI descriptors',
  );
  assert.equal(shellDescriptor.id, topology.shell.id);
  assert.equal(remoteDescriptor.id, topology.verticals[0]?.id);
  assert.equal(shellDescriptor.directory, topology.shell.path);
  assert.equal(remoteDescriptor.directory, topology.verticals[0]?.path);
  const host = {
    ...topology.shell,
    displayName: shellDescriptor.displayName,
    portEnv: shellDescriptor.portEnv,
  };
  const remote = {
    ...topology.verticals[0],
    displayName: remoteDescriptor.displayName,
    portEnv: remoteDescriptor.portEnv,
  };
  assert.equal(
    topology.verticals.length,
    1,
    'Expected one generated full-stack vertical',
  );
  for (const app of [host, remote]) {
    assert.equal(app.renderer, renderer);
    assert(typeof app.displayName === 'string' && app.displayName.length > 0);
    assert(typeof app.portEnv === 'string' && app.portEnv.length > 0);
    assert.equal(app.rendererCapabilities.federation, true);
    assert(
      typeof app.path === 'string' && !path.isAbsolute(app.path),
      'Generated application path must be relative',
    );
    const relative = path.relative(
      workspaceRoot,
      path.resolve(workspaceRoot, app.path),
    );
    assert(
      relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      'Generated application escapes its workspace',
    );
  }
  assert.equal(host.moduleFederation.role, 'host');
  assert.equal(remote.moduleFederation.role, 'remote');
  assert(remote.moduleFederation.exposes.includes('./Route'));
  assert(remote.moduleFederation.exposes.includes('./Widget'));
  assert.equal(remote.api.runtime, 'effect');
  assert(
    remote.api.basePath && remote.api.readiness.endpoint,
    'Generated vertical must have its real BFF contract',
  );
  const reference = host.moduleFederation.remotes.find(
    item => item.id === remote.id,
  );
  assert(
    reference?.manifestEnv,
    'Generated shell must compose its native vertical',
  );
  const hostOrigin = `http://127.0.0.1:${hostPort}`;
  const remoteOrigin = `http://127.0.0.1:${remotePort}`;
  return {
    host,
    remote,
    hostRoot: path.join(workspaceRoot, host.path),
    remoteRoot: path.join(workspaceRoot, remote.path),
    hostOrigin,
    remoteOrigin,
    routePath: `/remotes/${remote.id}`,
    env: {
      [host.portEnv]: String(hostPort),
      [remote.portEnv]: String(remotePort),
      [reference.manifestEnv]: `${reference.name}@${remoteOrigin}/mf-manifest.json`,
    },
  };
}

function snapshotSources(directory, snapshot = new Map()) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.modern', '.git'].includes(entry.name))
      continue;
    const filename = path.join(directory, entry.name);
    assert(
      !entry.isSymbolicLink(),
      `Generated source is a symlink: ${filename}`,
    );
    if (entry.isDirectory()) snapshotSources(filename, snapshot);
    else if (/\.(?:tsx?|json|yaml)$/u.test(entry.name))
      snapshot.set(
        filename,
        createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      );
  }
  return snapshot;
}

function assertSourcesUnchanged(snapshot) {
  for (const [filename, digest] of snapshot)
    assert.equal(
      createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      digest,
      `Generated source changed during acceptance: ${filename}`,
    );
}

export function authenticateGeneratedNativeFederationApp(
  appRoot,
  workspaceRoot,
  context,
) {
  const manifest = readJson(path.join(appRoot, 'package.json'));
  const workspace = parseYaml(
    fs.readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );
  const artifacts = new Map(
    context.cohort.artifacts.map(item => [item.sourceName, item]),
  );
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const [name, request] of Object.entries(dependencies)) {
    if (!name.startsWith('@modern-js/')) continue;
    const artifact = artifacts.get(name);
    assert(
      artifact,
      `Generated dependency ${name} is absent from the candidate`,
    );
    const selected = request.startsWith('catalog:')
      ? (request === 'catalog:'
          ? workspace.catalog
          : workspace.catalogs?.[request.slice('catalog:'.length)])?.[name]
      : request;
    assert.equal(
      selected,
      `npm:${artifact.targetName}@${artifact.version}`,
      `Generated dependency ${name} does not select the candidate`,
    );
  }
  const dependencyNames = Object.keys(dependencies).filter(
    name =>
      artifacts.has(name) ||
      /^(?:@module-federation\/|@octanejs\/|@solidjs\/|octane$|solid-js$|typescript$|@types\/node$)/u.test(
        name,
      ),
  );
  const roots = verifyPackedNativeFederationDependencies({
    appRoot,
    cohort: context.cohort,
    dependencyNames,
    packageIdentities: context.packageIdentities,
  });
  for (const name of [
    '@modern-js/ultramodern-app-tools',
    '@modern-js/renderer-core',
    `@modern-js/renderer-${context.renderer}`,
    '@modern-js/federation-runtime',
    '@module-federation/enhanced',
    '@module-federation/node',
    '@module-federation/runtime',
  ])
    assert(roots[name], `Generated native MF did not install ${name}`);
  return roots;
}

function validateGeneratedBuild(appRoot, renderer) {
  const requireApp = createRequire(path.join(appRoot, 'package.json'));
  const sdk = requireApp('@modern-js/ultramodern-app-tools');
  const profile = sdk.resolveRendererProfile(renderer);
  const build = sdk.validateRendererBuildManifest(
    readJson(path.join(appRoot, 'dist/renderer-build.json')),
    profile,
    { routerFrameworks: sdk.resolveRendererRouterFrameworks(renderer) },
  );
  const manifest = readJson(path.join(appRoot, 'dist/mf-manifest.json'));
  const requireSdk = createRequire(
    requireApp.resolve('@modern-js/ultramodern-app-tools'),
  );
  const { readRendererFederationContract } = requireSdk(
    '@modern-js/federation-runtime/renderer-contract',
  );
  const contract = readRendererFederationContract(
    manifest.metaData.ultramodernRenderer,
  );
  assert.equal(contract.profile.renderer, renderer);
  assert.deepEqual({ ...contract.identities }, { ...build.entries });
  return { build, manifest };
}

async function readEndpoint(url, signal, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  assert.equal(
    response.status,
    200,
    `${options.method ?? 'GET'} ${url} returned ${response.status}`,
  );
  return response;
}

async function proveBff(plan, signal) {
  const base = `${plan.remoteOrigin}${plan.remote.api.basePath}`;
  const readiness = await (
    await readEndpoint(
      `${plan.remoteOrigin}${plan.remote.api.bff.prefix}${plan.remote.api.readiness.endpoint}`,
      signal,
    )
  ).json();
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.versionSkew, 'none');
  assert.equal(readiness.checks.api, 'ready');
  const { items } = await (await readEndpoint(base, signal)).json();
  assert(items.length > 0, 'Generated BFF returned no demo items');
  assert.deepEqual(items[0].marker, readiness.marker);
  const item = await (
    await readEndpoint(`${base}/${encodeURIComponent(items[0].id)}`, signal)
  ).json();
  assert.equal(item.id, items[0].id);
  const { item: created } = await (
    await readEndpoint(base, signal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Packed native MF acceptance' }),
    })
  ).json();
  assert.equal(created.title, 'Packed native MF acceptance');
  assert.deepEqual(created.marker, readiness.marker);
}

async function proveBrowser(plan, context, signal) {
  signal.throwIfAborted();
  const requireBrowser = createRequire(
    path.join(context.browserDependencyRoot, 'package.json'),
  );
  const { chromium } = requireBrowser('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath: context.browserExecutable,
  });
  const proxy = createSSRMarkerProxy({
    target: plan.hostOrigin,
    signal,
    widgetSelector: '[data-testid="native-remote"]',
    counterSelector:
      '[data-testid="native-remote"] [data-testid="native-count"]',
  });
  const close = () => {
    void browser.close();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => {
        proxy.off('error', reject);
        resolve();
      });
    });
    const browserOrigin = `http://127.0.0.1:${proxy.address().port}`;
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${browserOrigin}/remotes`, { waitUntil: 'networkidle' });
    assert(
      await page.evaluate(() =>
        Boolean(window.__ssrRemoteWidget && window.__ssrRemoteCounter),
      ),
      'SSR marker did not capture the generated native widget and counter',
    );
    assert.equal(proxy.proof.markerCaptured, true);
    assert(proxy.proof.blockedEntries > 0);
    assert(proxy.proof.deliveredEntries.length > 0);
    assert(
      proxy.proof.deliveredEntries.every(entry => entry.markerCaptured),
      'Native entry bytes arrived before the SSR node marker',
    );
    const widget = page.locator(
      `[data-testid="native-remote"][data-remote-id="${plan.remote.id}"]`,
    );
    assert.equal(await widget.count(), 1);
    assert(
      (await widget.textContent()).includes(plan.host.displayName),
      'Generated remote did not receive the shell prop',
    );
    await widget
      .getByRole('button', { name: 'Increment', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-testid="native-remote"] [data-testid="native-count"]',
        )?.textContent === '1',
    );
    assert(
      await page.evaluate(
        () =>
          window.__ssrRemoteWidget ===
            document.querySelector('[data-testid="native-remote"]') &&
          window.__ssrRemoteCounter ===
            document.querySelector(
              '[data-testid="native-remote"] [data-testid="native-count"]',
            ),
      ),
      'Native hydration replaced server-rendered remote nodes',
    );
    const navigations = [];
    page.on('request', request => {
      if (
        request.isNavigationRequest() &&
        request.resourceType() === 'document'
      )
        navigations.push(request.url());
    });
    await page
      .getByRole('link', { name: plan.remote.displayName, exact: true })
      .click();
    await page.waitForURL(`${browserOrigin}${plan.routePath}`);
    await page
      .locator('[data-testid="native-remote"]')
      .getByRole('button', { name: 'Increment', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-testid="native-remote"] [data-testid="native-count"]',
        )?.textContent === '1',
    );
    await page
      .locator('[data-testid="native-remote"]')
      .getByRole('link', { name: 'Home', exact: true })
      .click();
    await page.waitForURL(`${browserOrigin}/`);
    assert.equal(
      await page
        .locator('[data-testid="native-route"]')
        .getAttribute('data-renderer'),
      context.renderer,
    );
    assert.deepEqual(
      navigations,
      [],
      'Generated native links caused document reloads',
    );
    assert.deepEqual(errors, [], 'Generated native MF emitted browser errors');
  } finally {
    signal.removeEventListener('abort', close);
    try {
      await browser.close();
    } finally {
      if (proxy.listening) {
        const closed = new Promise((resolve, reject) => {
          proxy.close(error => (error ? reject(error) : resolve()));
        });
        proxy.closeAllConnections();
        await closed;
      }
    }
  }
}

async function proveGeneratedTopology(context, renderer, signal) {
  const requireGenerator = createRequire(
    path.join(context.generatorConsumerRoot, 'package.json'),
  );
  const targetName = context.release.createPackage.targetName;
  verifyPackedNativeFederationDependencies({
    appRoot: context.generatorConsumerRoot,
    cohort: context.cohort,
  });
  const sdk = requireGenerator(`${targetName}/ultramodern-workspace`);
  const workspaceRoot = path.join(context.workRoot, 'workspace');
  const options = {
    modernVersion: context.release.release.version,
    enableTailwind: false,
    packageSource: {
      strategy: 'install',
      modernPackageVersion: context.release.release.version,
      registry: process.env.npm_config_registry,
      aliasScope: context.release.targetScope,
      aliasPackageNamePrefix: 'modern-js-',
    },
  };
  const workspaceResult = await sdk.generateUltramodernWorkspace({
    ...options,
    targetDir: workspaceRoot,
    packageName: `packed-mf-${renderer}`,
    renderer,
    generateAgentFiles: false,
  });
  const verticalResult = await sdk.addUltramodernVertical({
    ...options,
    workspaceRoot,
    name: 'packed-mf',
    preset: 'full-stack',
    apiProtocol: 'rest',
  });
  const snapshot = snapshotSources(workspaceRoot);
  const plan = planGeneratedNativeFederation({
    workspaceRoot,
    topology: readJson(
      path.join(workspaceRoot, 'topology/reference-topology.json'),
    ),
    workspaceResult,
    verticalResult,
    renderer,
    hostPort: await reservePort(),
    remotePort: await reservePort(),
  });
  await installPackedNativeFederationDependencies({
    directory: workspaceRoot,
    context,
    signal,
  });
  for (const appRoot of [plan.hostRoot, plan.remoteRoot])
    authenticateGeneratedNativeFederationApp(appRoot, workspaceRoot, context);
  const env = {
    ...process.env,
    ...plan.env,
    NODE_PATH: '',
    NODE_ENV: 'production',
  };
  const command = (executable, args, cwd, log, extraEnv = {}) =>
    runPackedNativeFederationCommand(executable, args, {
      witness: path.join(
        context.workRoot,
        `${log.replace(/\.log$/u, '')}-process.json`,
      ),
      cwd,
      env: { ...env, ...extraEnv },
      log: path.join(context.workRoot, log),
      signal,
    });
  const servers = [];
  let failure;
  try {
    await command(
      context.pnpmExecutable,
      ['--filter', './packages/*', 'build'],
      workspaceRoot,
      'shared-build.log',
    );
    await command(
      process.execPath,
      [installedBin(plan.remoteRoot), 'build'],
      plan.remoteRoot,
      'remote-build.log',
      { PORT: new URL(plan.remoteOrigin).port },
    );
    validateGeneratedBuild(plan.remoteRoot, renderer);
    const launch = (appRoot, origin, name) => {
      const server = launchServer(process.execPath, installedBin(appRoot), {
        cwd: appRoot,
        env: { ...env, PORT: new URL(origin).port },
        log: path.join(context.workRoot, `${name}-serve.log`),
        signal,
      });
      servers.push(server);
      recordPackedNativeFederationProcess(
        path.join(context.workRoot, `${name}-process.json`),
        server.child.pid,
      );
      return server;
    };
    const remote = launch(plan.remoteRoot, plan.remoteOrigin, 'remote');
    await ready(remote, `${plan.remoteOrigin}/mf-manifest.json`, signal);
    await command(
      process.execPath,
      [installedBin(plan.hostRoot), 'build'],
      plan.hostRoot,
      'host-build.log',
      { PORT: new URL(plan.hostOrigin).port },
    );
    validateGeneratedBuild(plan.hostRoot, renderer);
    const host = launch(plan.hostRoot, plan.hostOrigin, 'host');
    await ready(host, `${plan.hostOrigin}/remotes`, signal);
    for (const route of ['/remotes', plan.routePath]) {
      const html = await (
        await readEndpoint(`${plan.hostOrigin}${route}`, signal, {
          headers: { accept: 'text/html' },
        })
      ).text();
      assertGeneratedNativeFederationSSR({ html, plan, renderer, route });
    }
    await proveBff(plan, signal);
    await proveBrowser(plan, context, signal);
    assertSourcesUnchanged(snapshot);
    process.stdout.write(
      `Generated ${renderer} MF shell, route, widget, native browser interaction and BFF passed.\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    for (const server of servers.reverse()) {
      try {
        await server.stop();
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              'Generated MF acceptance and server retirement failed',
            )
          : error;
      }
    }
  }
  if (failure) throw failure;
}

export function runPackedNativeFederationGeneratedProof({
  generatorConsumerRoot,
  browserDependencyRoot,
  browserExecutable,
  nativeInputs,
  ...options
}) {
  return runPackedNativeFederationProof({
    ...options,
    proofScript: fileURLToPath(import.meta.url),
    contextExtras: {
      generatorConsumerRoot,
      browserDependencyRoot,
      browserExecutable,
      ...(nativeInputs ? { nativeInputs } : {}),
    },
    processWitnessPaths: [
      'workspace/packed-mf-install-process.json',
      'shared-build-process.json',
      'remote-build-process.json',
      'host-build-process.json',
      'remote-process.json',
      'host-process.json',
    ],
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = process.env.ULTRAMODERN_MF_PACKED_CONTEXT;
  assert(input, 'Generated native MF must run through the packed release gate');
  const renderer = readJson(input).renderer;
  const context = await readPackedNativeFederationContext(input, renderer);
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error('Generated native MF proof interrupted'));
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(event, interrupt);
  try {
    await proveGeneratedTopology(context, renderer, controller.signal);
  } finally {
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.removeListener(event, interrupt);
  }
}
