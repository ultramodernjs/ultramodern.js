#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileEvidence } from '../../../scripts/lib/file-evidence.mjs';
import {
  readInstalledPackageFiles,
  verifyInstalledPackage,
} from '../../../scripts/ultramodern-renderers/installed-cohort.mjs';
import {
  readWorkerFederationProvider,
  startWorkerFederationRuntime,
  verifyWorkerFederationModule,
} from '../../../scripts/ultramodern-renderers/native-federation-workers.mjs';
import { workerFederationFaultSource } from './fixtures.mjs';

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Called only after validating the native manifest and its entry identity. */
export function isSharedCounterCompilation(source, appRoot, sharedCounter) {
  if (source.transformKind !== 'compile') return false;
  assert(
    !path.isAbsolute(source.resource),
    'Native source resources must be relative to the actual application.',
  );
  try {
    return (
      fs.realpathSync(path.resolve(appRoot, source.resource)) === sharedCounter
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The caller builds ordinary apps first, using these reserved origin ports. */
export function readWorkerFixturePlan(
  filename,
  ownedRoot = process.env.OWNED_TEMP_DIR,
) {
  assert(ownedRoot, 'Run the Worker proof through owned-temp-dir.');
  const root = fs.realpathSync(ownedRoot);
  const plan = readJson(filename);
  assert.equal(plan.schemaVersion, 1);
  assert(
    ['source', 'packed'].includes(plan.mode),
    'Declare the source or packed proof lane.',
  );
  assert.equal(
    plan.applications.length,
    3,
    'Use one genuine host and two genuine remotes.',
  );
  const roles = plan.applications.map(application => application.role);
  assert.deepEqual(roles.toSorted(), ['host', 'remote', 'remote']);
  const origins = new Set();
  const applications = plan.applications.map(application => {
    const directories = {};
    for (const key of ['appRoot', 'buildRoot', 'clientRoot', 'outputRoot']) {
      const directory = fs.realpathSync(application[key]);
      assert(inside(root, directory), `The ${key} escapes the proof owner.`);
      directories[key] = directory;
    }
    const origin = new URL(application.origin);
    assert.equal(origin.origin, application.origin);
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.hostname, '127.0.0.1');
    assert(origin.port, 'Compile using a reserved loopback origin.');
    assert(
      !origins.has(origin.origin),
      'Each Worker needs its own compiled origin.',
    );
    origins.add(origin.origin);
    const wranglerPath = fs.realpathSync(application.wranglerPath);
    assert(
      inside(directories.outputRoot, wranglerPath),
      'Use the emitted deployment configuration.',
    );
    const manifestPath = fs.realpathSync(application.manifestPath);
    assert(
      inside(directories.clientRoot, manifestPath),
      'Use the emitted client MF manifest.',
    );
    return {
      ...application,
      ...directories,
      wrangler: readJson(wranglerPath),
      manifest: readJson(manifestPath),
    };
  });
  assert.equal(
    new Set(applications.map(application => application.wrangler.name)).size,
    3,
  );
  assert(
    Array.isArray(plan.routes) && plan.routes.length > 0,
    'Name every composition route to verify.',
  );
  for (const route of plan.routes) {
    assert(typeof route.path === 'string' && route.path.startsWith('/'));
    const routeUrl = new URL(route.path, 'http://127.0.0.1');
    assert.equal(
      routeUrl.origin,
      'http://127.0.0.1',
      'A composition route escapes its host.',
    );
    assert.equal(
      routeUrl.pathname,
      route.path,
      'Use the exact compiled composition path.',
    );
    assert(
      typeof route.context?.pathname === 'string' &&
        route.context.pathname.startsWith('/') &&
        route.context.publicHref === route.path &&
        typeof route.context.language === 'string' &&
        route.context.language.length > 0 &&
        typeof route.context.greeting === 'string' &&
        route.context.greeting.length > 0,
      'Every composition route needs explicit native router and i18n expectations.',
    );
    assert(Array.isArray(route.expected) && route.expected.length > 0);
    for (const expected of route.expected) {
      assert(
        applications.some(
          application =>
            application.role === 'remote' &&
            application.remote === expected.remote,
        ),
      );
      assert(
        typeof expected.expose === 'string' && expected.expose.startsWith('./'),
      );
      assert(
        typeof expected.selector === 'string' && expected.selector.length > 0,
      );
      assert(
        typeof expected.contextSelector === 'string' &&
          expected.contextSelector.length > 0,
        'Name the actual host nearest-match provider for each expose.',
      );
    }
  }
  assert(
    Array.isArray(plan.hops) && plan.hops.length > 0,
    'Declare a real remote-to-remote Worker hop.',
  );
  for (const hop of plan.hops) {
    assert.notEqual(hop.from, hop.to);
    for (const remote of [hop.from, hop.to])
      assert(
        applications.some(
          application =>
            application.role === 'remote' && application.remote === remote,
        ),
      );
    assert(Array.isArray(hop.routes) && hop.routes.length > 0);
    const languages = new Set();
    for (const routePath of hop.routes) {
      const route = plan.routes.find(candidate => candidate.path === routePath);
      assert(route, 'A Worker hop names an undeclared composition route.');
      assert(
        route.expected.some(
          expected =>
            expected.remote === hop.to &&
            expected.expose === hop.expose &&
            expected.selector === hop.selector,
        ),
        'A Worker hop needs a directly observed destination expose.',
      );
      languages.add(route.context.language);
    }
    assert(
      languages.has('en') && languages.has('cs'),
      'Verify second-hop context recapture in both declared languages.',
    );
  }
  return { ...plan, root, applications };
}

async function reportWorkerCompositionFailure(page, detail) {
  let timer;
  try {
    const inspection = page.evaluate(
      ({ selector }) => {
        const bounded = value => String(value ?? '').slice(0, 512);
        const node = selector ? document.querySelector(selector) : null;
        const style = node ? getComputedStyle(node) : null;
        return {
          url: bounded(location.href),
          readyState: document.readyState,
          observed: node
            ? {
                tag: node.tagName,
                className: bounded(node.className),
                style: {
                  borderTopColor: style.borderTopColor,
                  borderTopStyle: style.borderTopStyle,
                  borderTopWidth: style.borderTopWidth,
                  display: style.display,
                  visibility: style.visibility,
                },
              }
            : null,
          stylesheets: [
            ...document.querySelectorAll(
              'link[rel~="stylesheet"],link[as="style"]',
            ),
          ]
            .slice(0, 24)
            .map(link => ({
              href: bounded(link.href),
              rel: bounded(link.rel),
              as: bounded(link.as),
              media: bounded(link.media),
              disabled: link.disabled,
              sheetPresent: link.sheet !== null,
            })),
          resourceTimings: performance
            .getEntriesByType('resource')
            .slice(-24)
            .map(entry => ({
              url: bounded(entry.name),
              initiatorType: entry.initiatorType,
              duration: entry.duration,
              transferSize: entry.transferSize,
            })),
        };
      },
      { selector: detail.expected?.selector ?? null },
    );
    // Observability only: a broken page cannot indefinitely delay the original
    // failure or its existing browser/resource cleanup.
    const browser = await Promise.race([
      inspection.catch(error => ({
        inspectionError: String(error).slice(0, 512),
      })),
      new Promise(resolve => {
        timer = setTimeout(
          () =>
            resolve({ inspectionError: 'Browser diagnostic exceeded 1000ms.' }),
          1000,
        );
      }),
    ]);
    console.error(
      'Worker composition failure diagnostic:',
      JSON.stringify({ ...detail, browser }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Each declared composition coordinate has its own direct server document. */
export async function verifyWorkerCompositionRoutes(
  context,
  hostOrigin,
  routes,
  hostAppId,
) {
  const result = [];
  const selectors = [
    ...new Set(
      routes.flatMap(route =>
        route.expected.map(expected => expected.selector),
      ),
    ),
  ];
  for (const route of routes) {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const resourceEvents = [];
    const requestFailures = [];
    const bounded = value => String(value ?? '').slice(0, 512);
    const append = (records, event) => {
      if (records.length === 24) records.shift();
      records.push(event);
    };
    page.on('response', response => {
      const request = response.request();
      append(resourceEvents, {
        event: 'response',
        url: bounded(response.url()),
        type: request.resourceType(),
        status: response.status(),
      });
    });
    page.on('request', request => {
      append(resourceEvents, {
        event: 'request',
        url: bounded(request.url()),
        type: request.resourceType(),
      });
    });
    page.on('requestfailed', request => {
      append(requestFailures, {
        url: bounded(request.url()),
        type: request.resourceType(),
        error: bounded(request.failure()?.errorText),
      });
    });
    let expectedCoordinate;
    let phase = 'navigation';
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    await page.route('**/*', async intercepted => {
      if (intercepted.request().resourceType() === 'script') await gate;
      await intercepted.continue();
    });
    try {
      const response = await page.goto(new URL(route.path, hostOrigin).href, {
        waitUntil: 'commit',
      });
      assert.equal(response.status(), 200);
      const observed = [];
      for (const expected of route.expected) {
        expectedCoordinate = expected;
        phase = 'SSR visibility';
        const element = page.locator(expected.selector);
        await element.waitFor({ state: 'visible' });
        assert.equal(
          await element.count(),
          1,
          'A composition expose has ambiguous SSR markup.',
        );
        phase = 'SSR stylesheet application';
        await page.waitForFunction(selector => {
          const node = document.querySelector(selector);
          return (
            node && getComputedStyle(node).borderTopColor === 'rgb(13, 117, 83)'
          );
        }, expected.selector);
        phase = 'SSR context assertions';
        const contextHost = page.locator(expected.contextSelector);
        assert.equal(
          await contextHost.count(),
          1,
          'The expose has an ambiguous host context marker.',
        );
        const observation = await element.evaluate(
          (node, { contextSelector }) => {
            const host = document.querySelector(contextSelector);
            const input = node.querySelector('input');
            const counter = node.querySelector('[data-counter]');
            const refs = (globalThis.__nativeWorkerRouteRefs ??= {
              document: document.documentElement,
              remotes: {},
            });
            refs.remotes[node.dataset.workerRemote] = { node, input, counter };
            return {
              id: node.dataset.workerRemote,
              appId: node.dataset.appId,
              owner: node.dataset.owner,
              pathname: node.dataset.path,
              publicHref: node.dataset.publicHref,
              language: node.dataset.language,
              greeting: node.querySelector('[data-remote-greeting]')
                ?.textContent,
              match: {
                id: node.dataset.matchId,
                routeId: node.dataset.matchRouteId,
                params: node.dataset.matchParams,
                search: node.dataset.matchSearch,
                current: node.dataset.matchCurrent,
              },
              border: getComputedStyle(node).borderTopColor,
              host: {
                appId: host.dataset.appId,
                pathname: host.dataset.path,
                publicHref: host.dataset.publicHref,
                language: host.dataset.language,
                match: {
                  id: host.dataset.matchId,
                  routeId: host.dataset.matchRouteId,
                  params: host.dataset.matchParams,
                  search: host.dataset.matchSearch,
                  current: host.dataset.matchCurrent,
                },
                greeting: host.querySelector('[data-host-greeting]')
                  ?.textContent,
              },
            };
          },
          { contextSelector: expected.contextSelector },
        );
        assert(
          observation.id &&
            observation.match.id &&
            observation.match.routeId &&
            observation.match.params &&
            observation.match.search,
          'A native expose did not observe a real nearest match.',
        );
        assert.equal(
          observation.match.current,
          'true',
          'The nearest match is absent from the genuine native current matches.',
        );
        assert.deepEqual(observation.match, observation.host.match);
        assert.deepEqual(observation.host, {
          appId: hostAppId,
          ...route.context,
          match: observation.match,
        });
        assert.deepEqual(
          {
            appId: observation.appId,
            pathname: observation.pathname,
            publicHref: observation.publicHref,
            language: observation.language,
            greeting: observation.greeting,
          },
          { appId: hostAppId, ...route.context },
        );
        assert.equal(observation.owner, 'host');
        assert.equal(observation.border, 'rgb(13, 117, 83)');
        await element
          .locator('input')
          .first()
          .fill(`typed before hydration ${observation.id}`);
        observed.push({
          remote: expected.remote,
          expose: expected.expose,
          text: await element.textContent(),
          ...observation,
        });
      }
      for (const selector of selectors)
        if (!route.expected.some(expected => expected.selector === selector))
          assert.equal(
            await page.locator(selector).count(),
            0,
            'A composition route rendered an unexpected remote expose.',
          );
      const rootMatch = observed.find(observation => observation.id === 'a')
        ?.match.id;
      const nestedMatch = observed.find(
        observation => observation.id === 'b-hop',
      )?.match.id;
      if (nestedMatch)
        assert.notEqual(
          nestedMatch,
          rootMatch,
          'The nested Worker received the layout match instead of the page match.',
        );
      release();
      phase = 'browser hydration adoption';
      await page.waitForFunction(
        ids =>
          ids.every(id => globalThis.__octaneWorkerProof?.mounts[id] === 1),
        observed.map(observation => observation.id),
      );
      assert(
        await page.evaluate(() => {
          const refs = globalThis.__nativeWorkerRouteRefs;
          return (
            document.documentElement === refs.document &&
            Object.entries(refs.remotes).every(
              ([id, saved]) =>
                saved.node ===
                  document.querySelector(`[data-worker-remote="${id}"]`) &&
                saved.input === saved.node.querySelector('input') &&
                saved.counter === saved.node.querySelector('[data-counter]') &&
                saved.input.value === `typed before hydration ${id}`,
            )
          );
        }),
        'A direct composition document replaced native SSR nodes during adoption.',
      );
      for (const [index, expected] of route.expected.entries())
        await page.waitForFunction(
          ({ selector, contextSelector, canonical, appId, retainedMatch }) => {
            const node = document.querySelector(selector);
            const host = document.querySelector(contextSelector);
            return (
              node?.dataset.appId === appId &&
              node?.dataset.owner === 'host' &&
              node?.dataset.path === canonical.pathname &&
              node?.dataset.language === canonical.language &&
              node?.dataset.publicHref === canonical.publicHref &&
              node?.dataset.matchId === host?.dataset.matchId &&
              node?.dataset.matchRouteId === host?.dataset.matchRouteId &&
              node?.dataset.matchParams === host?.dataset.matchParams &&
              node?.dataset.matchSearch === host?.dataset.matchSearch &&
              node?.dataset.matchId === retainedMatch.id &&
              node?.dataset.matchRouteId === retainedMatch.routeId &&
              node?.dataset.matchParams === retainedMatch.params &&
              node?.dataset.matchSearch === retainedMatch.search &&
              node?.dataset.matchCurrent === 'true' &&
              host?.dataset.matchCurrent === 'true' &&
              host?.dataset.appId === appId &&
              host?.dataset.path === canonical.pathname &&
              host?.dataset.publicHref === canonical.publicHref &&
              host?.dataset.language === canonical.language &&
              host?.querySelector('[data-host-greeting]')?.textContent ===
                canonical.greeting &&
              node?.querySelector('[data-remote-greeting]')?.textContent ===
                canonical.greeting
            );
          },
          {
            selector: expected.selector,
            contextSelector: expected.contextSelector,
            canonical: route.context,
            appId: hostAppId,
            retainedMatch: observed[index].match,
          },
        );
      if (nestedMatch) {
        await page.locator('[data-counter="b-hop"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-counter="b-hop"]')?.textContent ===
            '38',
        );
        assert.equal(
          await page.locator('[data-counter="b"]').textContent(),
          '19',
        );
        await page.locator('[data-global-counter="b-hop"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-global-counter="b-hop"]')
              ?.textContent === '4',
        );
        for (const id of ['host', 'a', 'b', 'a-hop'])
          assert.equal(
            await page.locator(`[data-global-counter="${id}"]`).textContent(),
            '3',
          );
        await page.locator('[data-host-nested-home]').click();
        await page.waitForFunction(() =>
          ['a-hop', 'b-hop'].every(
            id => globalThis.__octaneWorkerProof?.cleanups[id] === 1,
          ),
        );
        assert.equal(
          await page.locator('[data-worker-remote="a-hop"]').count(),
          0,
        );
        assert.equal(
          await page.locator('[data-worker-remote="b-hop"]').count(),
          0,
        );
        for (const id of ['a', 'b']) {
          assert.equal(
            await page.locator(`[data-global-counter="${id}"]`).textContent(),
            '3',
          );
          await page.waitForFunction(
            id =>
              document.querySelector(`[data-worker-remote="${id}"]`)?.dataset
                .path === '/',
            id,
          );
        }
        assert(
          await page.evaluate(() =>
            ['a', 'b'].every(id => {
              const saved = globalThis.__nativeWorkerRouteRefs.remotes[id];
              return (
                saved.node ===
                  document.querySelector(`[data-worker-remote="${id}"]`) &&
                saved.input === saved.node.querySelector('input') &&
                saved.counter === saved.node.querySelector('[data-counter]') &&
                saved.input.value === `typed before hydration ${id}` &&
                globalThis.__octaneWorkerProof?.mounts[id] === 1 &&
                !globalThis.__octaneWorkerProof?.cleanups[id]
              );
            }),
          ),
          'Disposing the second-hop boundary disturbed a surviving native owner.',
        );
        await page.locator('[data-global-counter="b"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-global-counter="b"]')?.textContent ===
            '4',
        );
        for (const id of ['host', 'a'])
          assert.equal(
            await page.locator(`[data-global-counter="${id}"]`).textContent(),
            '3',
          );
        await page.locator('[data-counter="host"]').click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-counter="host"]')?.textContent ===
            '6',
        );
        assert(
          await page.evaluate(
            () =>
              document.documentElement ===
              globalThis.__nativeWorkerRouteRefs.document,
          ),
        );
      }
      assert.deepEqual(
        errors,
        [],
        'The direct composition document produced browser errors.',
      );
      result.push({
        path: route.path,
        context: route.context,
        observed,
        adopted: true,
        nestedDisposed: Boolean(nestedMatch),
      });
    } catch (error) {
      try {
        await reportWorkerCompositionFailure(page, {
          route: bounded(route.path),
          expected: expectedCoordinate
            ? {
                remote: bounded(expectedCoordinate.remote),
                expose: bounded(expectedCoordinate.expose),
                selector: bounded(expectedCoordinate.selector),
                contextSelector: bounded(expectedCoordinate.contextSelector),
              }
            : null,
          phase,
          resourceEvents,
          requestFailures,
          errors: errors.slice(-16).map(bounded),
        });
      } catch {
        // Diagnostics cannot replace the original assertion or browser error.
      }
      throw error;
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
  }
  return result;
}

/** Native loaders run normally after the browser has recorded the visible SSR nodes. */
export async function verifyWorkerFixtureBrowser(
  context,
  url,
  { failedRemote, hostAppId, disposalOrder = ['a', 'b'] } = {},
) {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const failures = [];
  const started = Date.now();
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') failures.push(message.text());
  });
  let releaseScripts;
  const gate = new Promise(resolve => {
    releaseScripts = resolve;
  });
  await page.route('**/*', async route => {
    if (route.request().resourceType() === 'script') await gate;
    await route.continue();
  });
  try {
    const response = await page.goto(url, { waitUntil: 'commit' });
    assert.equal(response.status(), 200);
    for (const id of ['a', 'b']) {
      const selector =
        id === failedRemote
          ? `[data-fallback="${id}"]`
          : `[data-worker-remote="${id}"]`;
      await page.locator(selector).waitFor({ state: 'visible' });
    }
    const ssrElapsedMs = Date.now() - started;
    await page.waitForFunction(
      failed =>
        ['a', 'b'].every(
          id =>
            id === failed ||
            getComputedStyle(
              document.querySelector(`[data-worker-remote="${id}"]`),
            ).borderTopColor === 'rgb(13, 117, 83)',
        ),
      failedRemote,
    );
    const ssr = await page.evaluate(failed => {
      const hostContext = document.querySelector('[data-worker-host]');
      const refs = {
        document: document.documentElement,
        host: document.querySelector('[data-counter="host"]'),
        hostMatch: {
          id: hostContext.dataset.matchId,
          routeId: hostContext.dataset.matchRouteId,
          params: hostContext.dataset.matchParams,
          search: hostContext.dataset.matchSearch,
          current: hostContext.dataset.matchCurrent,
        },
        remotes: {},
      };
      const observations = {};
      for (const id of ['a', 'b']) {
        if (id === failed) continue;
        const node = document.querySelector(`[data-worker-remote="${id}"]`);
        const input = node.querySelector('input');
        const counter = node.querySelector('[data-counter]');
        refs.remotes[id] = { node, input, counter };
        observations[id] = {
          appId: node.dataset.appId,
          owner: node.dataset.owner,
          path: node.dataset.path,
          publicHref: node.dataset.publicHref,
          match: {
            id: node.dataset.matchId,
            routeId: node.dataset.matchRouteId,
            params: node.dataset.matchParams,
            search: node.dataset.matchSearch,
            current: node.dataset.matchCurrent,
          },
          language: node.dataset.language,
          count: counter.textContent,
          greeting: node.querySelector('[data-remote-greeting]').textContent,
          border: getComputedStyle(node).borderTopColor,
        };
      }
      globalThis.__nativeWorkerRefs = refs;
      return observations;
    }, failedRemote);
    const hostMatch = await page.evaluate(
      () => globalThis.__nativeWorkerRefs.hostMatch,
    );
    assert(
      hostMatch.id && hostMatch.routeId && hostMatch.params && hostMatch.search,
    );
    assert.equal(hostMatch.current, 'true');
    for (const [id, observation] of Object.entries(ssr)) {
      assert.deepEqual(observation, {
        appId: hostAppId,
        owner: 'host',
        path: '/',
        publicHref: '/en/',
        match: hostMatch,
        language: 'en',
        count: id === 'a' ? '11' : '19',
        greeting: 'Hello from host',
        border: 'rgb(13, 117, 83)',
      });
      await page
        .locator(`[data-remote-input="${id}"]`)
        .fill(`typed before hydration ${id}`);
    }
    const ssrBeforeHydration =
      Object.keys(ssr).length === (failedRemote ? 1 : 2);
    releaseScripts();
    await page.waitForFunction(() =>
      ['a', 'b'].every(id => globalThis.__octaneWorkerProof?.mounts[id] === 1),
    );
    await page.waitForFunction(() => {
      const refs = globalThis.__nativeWorkerRefs;
      return Object.entries(refs.remotes).every(
        ([id, value]) =>
          value.node ===
            document.querySelector(`[data-worker-remote="${id}"]`) &&
          value.input ===
            document.querySelector(`[data-remote-input="${id}"]`) &&
          value.counter === document.querySelector(`[data-counter="${id}"]`),
      );
    });
    const exactNodeAdoption = await page.evaluate(() => {
      const refs = globalThis.__nativeWorkerRefs;
      return Object.entries(refs.remotes).every(
        ([id, value]) =>
          value.node ===
            document.querySelector(`[data-worker-remote="${id}"]`) &&
          value.input ===
            document.querySelector(`[data-remote-input="${id}"]`) &&
          value.counter === document.querySelector(`[data-counter="${id}"]`),
      );
    });
    assert(exactNodeAdoption);
    for (const id of Object.keys(ssr))
      assert.equal(
        await page.locator(`[data-remote-input="${id}"]`).inputValue(),
        `typed before hydration ${id}`,
      );
    if (failedRemote)
      await page
        .locator(`[data-fallback="${failedRemote}"]`)
        .waitFor({ state: 'hidden' });
    for (const [id, expected] of [
      ['host', '6'],
      ['a', '12'],
      ['b', '20'],
    ]) {
      await page.locator(`[data-counter="${id}"]`).click();
      await page.waitForFunction(
        ({ id, expected }) =>
          document.querySelector(`[data-counter="${id}"]`)?.textContent ===
          expected,
        { id, expected },
      );
    }
    for (const id of ['host', 'a', 'b'])
      assert.equal(
        await page.locator(`[data-global-counter="${id}"]`).textContent(),
        '3',
      );
    await page.locator('[data-global-counter="a"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-global-counter="a"]')?.textContent ===
        '4',
    );
    assert.equal(
      await page.locator('[data-global-counter="host"]').textContent(),
      '3',
    );
    assert.equal(
      await page.locator('[data-global-counter="b"]').textContent(),
      '3',
    );
    await page.locator('[data-host-relabel]').click();
    await page.waitForFunction(() =>
      ['a', 'b'].every(
        id =>
          document.querySelector(`[data-remote-label="${id}"]`)?.textContent ===
          'updated by host',
      ),
    );
    assert.equal(await page.locator('[data-counter="a"]').textContent(), '12');
    assert.equal(await page.locator('[data-counter="b"]').textContent(), '20');
    assert.equal(
      await page.locator('[data-global-counter="a"]').textContent(),
      '4',
    );
    assert.equal(
      await page.locator('[data-global-counter="b"]').textContent(),
      '3',
    );
    assert.equal(
      await page.locator('[data-global-counter="host"]').textContent(),
      '3',
    );
    await page.locator('[data-host-language]').click();
    await page.waitForFunction(() =>
      ['a', 'b'].every(id => {
        const node = document.querySelector(`[data-worker-remote="${id}"]`);
        return (
          node?.dataset.language === 'cs' &&
          node?.dataset.publicHref === '/cs/' &&
          node.querySelector('[data-remote-greeting]').textContent ===
            'Ahoj od hostitele'
        );
      }),
    );
    await page.locator('[data-host-navigation]').click();
    await page.locator('[data-host-about]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-worker-host]');
      const match = globalThis.__nativeWorkerRefs.hostMatch;
      return ['a', 'b'].every(id => {
        const node = document.querySelector(`[data-worker-remote="${id}"]`);
        return (
          node?.dataset.path === '/about' &&
          node.dataset.publicHref === '/cs/about' &&
          node.dataset.language === 'cs' &&
          node.dataset.appId === host.dataset.appId &&
          node.dataset.matchId === match.id &&
          host.dataset.matchId === match.id &&
          node.dataset.matchRouteId === match.routeId &&
          host.dataset.matchRouteId === match.routeId &&
          node.dataset.matchParams === match.params &&
          host.dataset.matchParams === match.params &&
          node.dataset.matchSearch === match.search &&
          host.dataset.matchSearch === match.search &&
          node.dataset.matchCurrent === 'true' &&
          host.dataset.matchCurrent === 'true' &&
          host.dataset.path === '/about' &&
          host.dataset.publicHref === '/cs/about' &&
          host.dataset.language === 'cs' &&
          node.querySelector('[data-remote-greeting]')?.textContent ===
            'Ahoj od hostitele'
        );
      });
    });
    assert.equal(new URL(page.url()).pathname, '/cs/about');
    assert(
      await page.evaluate(
        () =>
          document.documentElement === globalThis.__nativeWorkerRefs.document,
      ),
    );
    assert(
      await page.evaluate(() =>
        Object.entries(globalThis.__nativeWorkerRefs.remotes).every(
          ([id, value]) =>
            value.node ===
              document.querySelector(`[data-worker-remote="${id}"]`) &&
            value.input ===
              document.querySelector(`[data-remote-input="${id}"]`) &&
            value.counter === document.querySelector(`[data-counter="${id}"]`),
        ),
      ),
      'Native prop/context updates replaced a retained server node.',
    );
    for (const [index, id] of disposalOrder.entries()) {
      await page.locator(`[data-host-toggle="${id}"]`).click();
      await page
        .locator(`[data-worker-remote="${id}"]`)
        .waitFor({ state: 'detached' });
      await page.waitForFunction(
        id => globalThis.__octaneWorkerProof?.cleanups[id] === 1,
        id,
      );
      if (index === 0) {
        const sibling = disposalOrder[1];
        const before = Number(
          await page.locator(`[data-counter="${sibling}"]`).textContent(),
        );
        await page.locator(`[data-counter="${sibling}"]`).click();
        await page.waitForFunction(
          ({ sibling, expected }) =>
            document.querySelector(`[data-counter="${sibling}"]`)
              ?.textContent === String(expected),
          { sibling, expected: before + 1 },
        );
        const globalBefore = Number(
          await page
            .locator(`[data-global-counter="${sibling}"]`)
            .textContent(),
        );
        await page.locator(`[data-global-counter="${sibling}"]`).click();
        await page.waitForFunction(
          ({ sibling, expected }) =>
            document.querySelector(`[data-global-counter="${sibling}"]`)
              ?.textContent === String(expected),
          { sibling, expected: globalBefore + 1 },
        );
        assert.equal(
          await page.locator('[data-global-counter="host"]').textContent(),
          '3',
        );
      }
      await page.locator('[data-counter="host"]').click();
      await page.waitForFunction(
        expected =>
          document.querySelector('[data-counter="host"]')?.textContent ===
          String(expected),
        7 + index,
      );
    }
    assert.deepEqual(failures, [], 'The native browser reported errors.');
    return {
      ssr,
      ssrElapsedMs,
      disposalOrder,
      ssrBeforeHydration,
      exactNodeAdoption,
      browserRecovery: Boolean(failedRemote),
    };
  } finally {
    releaseScripts();
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
}

/** Execute prebuilt ordinary source/packed apps; generated public acceptance is separate. */
export async function runWorkerFixtureProof(plan, { signal } = {}) {
  signal?.throwIfAborted();
  let packed;
  if (plan.mode === 'packed') {
    assert(
      process.env.ULTRAMODERN_MF_PACKED_CONTEXT,
      'Packed Workers need the authenticated release context.',
    );
    const helpers = await import(
      '../../../scripts/ultramodern-renderers/native-federation-packed.mjs'
    );
    packed = await helpers.readPackedNativeFederationContext(
      process.env.ULTRAMODERN_MF_PACKED_CONTEXT,
      'octane',
    );
    for (const application of plan.applications)
      helpers.verifyPackedNativeFederationDependencies({
        appRoot: application.appRoot,
        cohort: packed.cohort,
        dependencyNames: application.dependencyNames,
      });
  } else
    assert(
      !process.env.ULTRAMODERN_MF_PACKED_CONTEXT,
      'A source proof cannot claim the packed lane.',
    );
  const host = plan.applications.find(
    application => application.role === 'host',
  );
  const hostRequire = createRequire(path.join(host.appRoot, 'package.json'));
  const toolingRequire = createRequire(
    hostRequire.resolve('@modern-js/ultramodern-app-tools'),
  );
  const moduleOwners = [];
  const publicModule = (request, specifier, sourceName) => {
    if (packed)
      moduleOwners.push(
        verifyWorkerFederationModule({
          request,
          specifier,
          sourceName,
          cohort: packed.cohort,
          consumerRoot: plan.root,
        }),
      );
    return request(specifier);
  };
  const {
    readRendererFederationContract,
    assertRendererFederationCompatibility,
  } = publicModule(
    toolingRequire,
    '@modern-js/federation-runtime/renderer-contract',
    '@modern-js/federation-runtime',
  );
  const { readWorkerFederationPublication } = publicModule(
    hostRequire,
    '@modern-js/renderer-core/worker-federation',
    '@modern-js/renderer-core',
  );
  const { validateOctaneModuleManifest, octaneModuleManifestFileName } =
    publicModule(
      hostRequire,
      '@modern-js/renderer-octane/manifest',
      '@modern-js/renderer-octane',
    );
  const { readNativeRendererWorkerResources } = publicModule(
    toolingRequire,
    '@modern-js/app-tools-extensions/cloudflare/native-renderer',
    '@modern-js/app-tools-extensions',
  );
  const hostContract = readRendererFederationContract(
    host.manifest.metaData.ultramodernRenderer,
  );
  assert.equal(hostContract.profile.renderer, 'octane');
  const resources = new Map();
  const sharedCounter = fs.realpathSync(plan.sharedCounterPath);
  assert(
    inside(plan.root, sharedCounter),
    'Use one owned authored native Counter source.',
  );
  const counterCompilations = [];
  const files = [];
  for (const application of plan.applications) {
    const contract = readRendererFederationContract(
      application.manifest.metaData.ultramodernRenderer,
    );
    assertRendererFederationCompatibility(hostContract, contract);
    const worker =
      application.role === 'remote'
        ? readWorkerFederationPublication(
            application.manifest.metaData.ultramodernWorkerFederation,
            contract.identities,
          )
        : undefined;
    const publisherEntries = worker
      ? new Set(
          [
            ...plan.routes.flatMap(route =>
              route.expected
                .filter(expected => expected.remote === application.remote)
                .map(expected => expected.expose),
            ),
            ...plan.hops
              .filter(hop => hop.to === application.remote)
              .map(hop => hop.expose),
          ].map(expose => {
            assert(
              worker.exposes[expose],
              `No native publisher for ${expose}.`,
            );
            return worker.exposes[expose].entryName;
          }),
        )
      : undefined;
    if (publisherEntries)
      assert(
        publisherEntries.size,
        'The remote needs observed expose publishers.',
      );
    const resource = await readNativeRendererWorkerResources(
      application.buildRoot,
      {
        renderer: { name: 'octane', nativeDocuments: true, rsc: false },
        identities: contract.identities,
      },
    );
    assert(resource, 'The compiler did not emit native Worker resources.');
    resources.set(application.wrangler.name, resource);
    for (const entryName of publisherEntries ?? [])
      assert(
        resource.entries[entryName],
        `Missing native publisher entry ${entryName}.`,
      );
    const counterCandidates = [];
    const nativeEntrySamples = [];
    const sources = Object.entries(resource.entries).flatMap(
      ([entryName, entry]) => {
        const native = validateOctaneModuleManifest(
          entry.nativeManifest,
          contract.identities[entryName],
          entry.hydrationBuildId,
        );
        nativeEntrySamples.push({
          entryName,
          sourceModuleCount: native.sourceModules.length,
          sourceModules: native.sourceModules.slice(0, 32).map(source => ({
            resource: source.resource,
            transformKind: source.transformKind,
            canonicalId: source.canonicalId,
            assets: source.assets,
          })),
          assetCount: native.assets.length,
          assets: native.assets.slice(0, 16).map(asset => asset.file),
        });
        for (const source of native.sourceModules) {
          if (
            source.resource.toLowerCase().includes('counter') ||
            source.canonicalId.toLowerCase().includes('counter')
          )
            counterCandidates.push({
              entryName,
              resource: source.resource,
              transformKind: source.transformKind,
              canonicalId: source.canonicalId,
              resolvedResource: path.resolve(
                application.appRoot,
                source.resource,
              ),
            });
        }
        const compiledCounter = native.sourceModules.filter(source =>
          isSharedCounterCompilation(
            source,
            application.appRoot,
            sharedCounter,
          ),
        );
        if (publisherEntries?.has(entryName))
          assert(
            compiledCounter.length,
            `Observed expose publisher ${entryName} in ${application.wrangler.name} did not compile the shared Counter. ${JSON.stringify(nativeEntrySamples.at(-1))}`,
          );
        return publisherEntries && !publisherEntries.has(entryName)
          ? []
          : compiledCounter;
      },
    );
    assert(
      sources.length > 0,
      `Every Worker must compile the same physical Counter source. ${JSON.stringify(
        {
          worker: application.wrangler.name,
          appRoot: application.appRoot,
          expectedResource: sharedCounter,
          expectedRelativeResource: path
            .relative(application.appRoot, sharedCounter)
            .split(path.sep)
            .join('/'),
          counterCandidates,
          nativeEntrySamples,
          federationExposes: application.manifest.exposes,
        },
        null,
        2,
      )}`,
    );
    const evidence = sources.map(source => ({
      canonicalId: source.canonicalId,
      emittedSourceSha256: source.emittedSourceSha256,
    }));
    for (const item of evidence) assert.deepEqual(item, evidence[0]);
    counterCompilations.push({
      worker: application.wrangler.name,
      ...evidence[0],
    });
    if (application.role === 'remote') {
      assert.equal(worker.remote, application.remote);
      const resourceRenderer = readRendererFederationContract(
        resource.workerFederation.renderer,
      );
      const resourceWorker = readWorkerFederationPublication(
        resource.workerFederation.worker,
        resourceRenderer.identities,
      );
      assert.deepEqual(
        { renderer: resourceRenderer, worker: resourceWorker },
        { renderer: contract, worker },
      );
      assert.equal(
        new URL(resource.workerFederationManifestUrl).origin,
        application.origin,
      );
      for (const coordinate of Object.values(worker.exposes)) {
        const identity = contract.identities[coordinate.entryName];
        const native = validateOctaneModuleManifest(
          readJson(
            path.join(
              application.clientRoot,
              octaneModuleManifestFileName(coordinate.entryName),
            ),
          ),
          identity,
          coordinate.native.publisherBuildId,
        );
        for (const asset of native.assets) {
          const filename = fs.realpathSync(
            path.join(application.clientRoot, asset.file),
          );
          assert(
            inside(application.clientRoot, filename),
            'A native client asset escapes its publication.',
          );
          assert.equal(
            fileEvidence(filename, application.clientRoot).sha256,
            asset.sha256,
          );
        }
      }
    }
    for (const directory of new Set([
      application.buildRoot,
      application.outputRoot,
    ]))
      files.push({ directory, files: readInstalledPackageFiles(directory) });
  }
  for (const compilation of counterCompilations.slice(1))
    assert.deepEqual(
      {
        canonicalId: compilation.canonicalId,
        emittedSourceSha256: compilation.emittedSourceSha256,
      },
      {
        canonicalId: counterCompilations[0].canonicalId,
        emittedSourceSha256: counterCompilations[0].emittedSourceSha256,
      },
      'Independent publishers must retain identical native declarations from the shared source.',
    );
  for (const route of plan.routes)
    for (const expected of route.expected) {
      const remote = plan.applications.find(
        application => application.remote === expected.remote,
      );
      assert(
        Object.hasOwn(
          resources.get(remote.wrangler.name).workerFederation.worker.exposes,
          expected.expose,
        ),
        'A composition route names an unpublished expose.',
      );
    }
  const hopPolicies = plan.hops.map(hop => {
    const from = plan.applications.find(
      application => application.remote === hop.from,
    );
    const to = plan.applications.find(
      application => application.remote === hop.to,
    );
    const service = resources
      .get(from.wrangler.name)
      .workerFederationServices.find(candidate => candidate.remote === hop.to);
    assert(
      service,
      'A declared second hop has no genuine emitted Worker service policy.',
    );
    const fragment = service.fragments.find(
      candidate => candidate.expose === hop.expose,
    );
    assert(
      fragment,
      'A declared second hop has no genuine emitted expose coordinate.',
    );
    for (const routePath of hop.routes) {
      const route = plan.routes.find(candidate => candidate.path === routePath);
      assert(
        fragment.paths[route.context.language],
        'A declared second-hop language has no emitted native endpoint.',
      );
    }
    return { hop, from, to, service, fragment };
  });
  const provider = await readWorkerFederationProvider({
    mode: plan.mode,
    generatorPackageRoot: plan.generatorPackageRoot,
    consumerRoot: plan.generatorConsumerRoot,
    cohort: packed?.cohort,
  });
  const faultPath = path.join(plan.root, 'octane-worker-fault.mjs');
  fs.writeFileSync(faultPath, workerFederationFaultSource, { flag: 'wx' });
  let runtime;
  let browser;
  let failure;
  let result;
  const cleanupErrors = [];
  try {
    const hostResource = resources.get(host.wrangler.name);
    const faults = plan.applications
      .filter(application => application.role === 'remote')
      .map(application => {
        const service = hostResource.workerFederationServices.find(
          service => service.remote === application.remote,
        );
        assert(service, 'The genuine host has no bound remote service.');
        return {
          name: `proof-fault-${application.wrangler.name}`,
          host: host.wrangler.name,
          target: application.wrangler.name,
          binding: service.binding,
          scriptPath: faultPath,
        };
      });
    const hopFaults = hopPolicies.map(({ from, to, service }, index) => ({
      name: `proof-hop-${index}-${from.wrangler.name}-${to.wrangler.name}`,
      host: from.wrangler.name,
      target: to.wrangler.name,
      binding: service.binding,
      scriptPath: faultPath,
    }));
    const allFaults = [...faults, ...hopFaults];
    const bridgePorts = Object.fromEntries(
      plan.applications.map(application => [
        application.wrangler.name,
        Number(new URL(application.origin).port),
      ]),
    );
    runtime = await startWorkerFederationRuntime({
      applications: plan.applications,
      provider,
      bridgeNames: [
        ...plan.applications.map(application => application.wrangler.name),
        ...allFaults.map(fault => fault.name),
      ],
      bridgePorts,
      faults: allFaults,
      signal,
    });
    const browserRequire = createRequire(
      path.join(plan.browserDependencyRoot, 'package.json'),
    );
    browser = await browserRequire('playwright').chromium.launch({
      headless: true,
      ...(plan.browserExecutable
        ? { executablePath: plan.browserExecutable }
        : {}),
    });
    const control = async (fault, mode) => {
      const response = await fetch(
        `${runtime.bridges.get(fault.name).url}/__proof/control`,
        { method: 'POST', body: JSON.stringify({ mode }), signal },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    result = {
      mode: plan.mode,
      positive: [],
      concurrent: [],
      faults: [],
      routes: [],
      hops: [],
      counterCompilations,
    };
    const hostAppId = Object.values(hostContract.identities)[0].appId;
    const rootRoute = plan.routes.find(
      route =>
        route.context.pathname === '/' && route.context.language === 'en',
    );
    assert(
      rootRoute,
      'The source proof requires a direct English root document.',
    );
    const hostUrl = new URL(rootRoute.path, host.origin).href;
    const hopBefore = await Promise.all(
      hopFaults.map(fault => control(fault, 'pass')),
    );
    const routeContext = await browser.newContext();
    try {
      result.routes = await verifyWorkerCompositionRoutes(
        routeContext,
        host.origin,
        plan.routes,
        hostAppId,
      );
    } finally {
      await routeContext.close();
    }
    for (const [index, { hop, fragment }] of hopPolicies.entries()) {
      const after = await control(hopFaults[index], 'pass');
      const requests = after.requests
        .slice(hopBefore[index].requests.length)
        .filter(request => request.method === 'POST');
      for (const routePath of hop.routes) {
        const route = plan.routes.find(
          candidate => candidate.path === routePath,
        );
        assert(
          requests.some(
            request =>
              request.path === fragment.paths[route.context.language] &&
              request.status === 200,
          ),
          'The declared locale never reached the actual remote-to-remote service binding.',
        );
      }
      result.hops.push({ ...hop, requests });
    }
    for (const disposalOrder of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      const context = await browser.newContext();
      try {
        result.positive.push(
          await verifyWorkerFixtureBrowser(context, hostUrl, {
            disposalOrder,
            hostAppId,
          }),
        );
      } finally {
        await context.close();
      }
    }
    const beforeConcurrent = await control(faults[0], 'pass');
    const concurrent = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        const context = await browser.newContext();
        try {
          return await verifyWorkerFixtureBrowser(context, hostUrl, {
            hostAppId,
          });
        } finally {
          await context.close();
        }
      }),
    );
    const concurrentFailures = concurrent
      .filter(entry => entry.status === 'rejected')
      .map(entry => entry.reason);
    if (concurrentFailures.length > 0)
      throw new AggregateError(
        concurrentFailures,
        'Concurrent Worker documents failed after all browser callbacks were drained.',
      );
    result.concurrent = concurrent.map(entry => entry.value);
    const afterConcurrent = await control(faults[0], 'pass');
    const nativeRequests = afterConcurrent.requests
      .slice(beforeConcurrent.requests.length)
      .filter(request => request.method === 'POST');
    assert(
      nativeRequests.length >= 4,
      'The concurrent documents did not request native remote snapshots.',
    );
    assert.equal(
      new Set(nativeRequests.map(request => request.requestSha256)).size,
      nativeRequests.length,
      'Independent native documents reused an encoded request identity.',
    );
    result.requestDigests = nativeRequests.map(
      request => request.requestSha256,
    );
    for (const mode of [
      'unavailable',
      'headers-hang',
      'body-hang',
      'manifest-unavailable',
      'manifest-headers-hang',
      'manifest-body-hang',
      'foreign-manifest',
      'foreign-renderer',
      'foreign-request-authority',
      'foreign-response-authority',
      'foreign-native-publisher',
      'foreign-native-abi',
      'foreign-native-document',
      'foreign-native-boundary',
      'foreign-native-echo',
    ]) {
      signal?.throwIfAborted();
      const before = await control(faults[0], mode);
      const started = Date.now();
      const context = await browser.newContext();
      try {
        const proof = await verifyWorkerFixtureBrowser(context, hostUrl, {
          failedRemote: 'a',
          hostAppId,
        });
        const after = await control(faults[0], 'pass');
        assert(
          proof.ssrElapsedMs < 5000,
          'The native SSR fallback exceeded its bounded deadline.',
        );
        assert.equal(
          after.active,
          0,
          'The failed service kept an active request.',
        );
        const requests = after.requests.slice(before.requests.length);
        if (mode.endsWith('-hang')) {
          const method = mode.startsWith('manifest-') ? 'GET' : 'POST';
          const pending = requests.filter(
            request => request.mode === mode && request.method === method,
          );
          assert(
            pending.length > 0,
            'The intended service hang was never exercised.',
          );
          assert.equal(
            after.cancellations - before.cancellations,
            pending.length,
            'Each failed service request must cancel once.',
          );
        }
        if (['foreign-manifest', 'foreign-renderer'].includes(mode)) {
          assert(
            requests.some(
              request => request.method === 'GET' && request.mutation === mode,
            ),
            'The foreign manifest fault was never exercised.',
          );
          assert(
            !requests.some(request => request.method === 'POST'),
            'A rejected publisher reached the remote expose.',
          );
        }
        if (mode === 'foreign-request-authority') {
          assert(
            requests.some(
              request =>
                request.method === 'POST' &&
                request.mutation === 'request-authority',
            ),
            'The foreign request fault was never exercised.',
          );
          assert(
            requests
              .filter(request => request.method === 'POST')
              .every(request => request.status === 400),
            'The remote must reject foreign admission before importing its expose.',
          );
        }
        if (mode === 'foreign-response-authority')
          assert(
            requests.some(
              request => request.method === 'POST' && request.mutation === mode,
            ),
            'The foreign response fault was never exercised.',
          );
        if (mode.startsWith('foreign-native-')) {
          const nativeFaults = requests.filter(
            request => request.method === 'POST' && request.mutation === mode,
          );
          assert(
            nativeFaults.length > 0,
            'The native identity fault was never exercised.',
          );
          if (mode !== 'foreign-native-echo')
            assert(
              nativeFaults.every(request => request.status === 400),
              'The native codec must reject a foreign identity before importing its expose.',
            );
        }
        result.faults.push({
          mode,
          elapsedMs: Date.now() - started,
          proof,
          requests,
          activeRequests: after.active,
          cancellations: after.cancellations - before.cancellations,
        });
      } finally {
        await context.close();
        await control(faults[0], 'pass');
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const dispose of [() => browser?.close(), () => runtime?.dispose()]) {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      provider.verify();
      for (const owner of moduleOwners)
        verifyInstalledPackage(owner.directory, owner.artifact);
      for (const owner of files)
        assert.deepEqual(
          readInstalledPackageFiles(owner.directory),
          owner.files,
          'A built candidate changed during proof.',
        );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      fs.unlinkSync(faultPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Octane Worker proof failed.',
    );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Run through owned-temp-dir: node proof.mjs --plan <compiled-fixture-plan.json>\nThe plan selects source or authenticated packed ordinary apps. Generated public acceptance is a separate row.\n',
    );
  } else {
    assert.equal(
      process.argv[2],
      '--plan',
      'Supply the actual compiled fixture plan.',
    );
    assert.equal(process.argv.length, 4);
    const cancellation = new AbortController();
    const interrupt = signal =>
      cancellation.abort(new Error(`Received ${signal}`));
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [
      signal,
      () => interrupt(signal),
    ]);
    for (const [signal, handler] of handlers) process.once(signal, handler);
    try {
      const plan = readWorkerFixturePlan(process.argv[3]);
      const evidence = await runWorkerFixtureProof(plan, {
        signal: cancellation.signal,
      });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } finally {
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
    }
  }
}
