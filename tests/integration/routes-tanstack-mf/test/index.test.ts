import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { collectBrowserErrors } from '../../../utils/browserErrors';
import {
  acquireFixtureLock,
  type ReleaseFixtureLock,
} from '../../../utils/fixtureLock';
import {
  getPort,
  killApp,
  launchApp,
  launchOptions,
  modernBuild,
  modernServe,
} from '../../../utils/modernTestUtils';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';
import { assertPluginDataLoaderRuntimeBuilt } from './pluginDataLoaderRuntime';

setSuiteTimeout(1000 * 60 * 8);

async function waitForAppReady(url: string, maxRetries = 60) {
  let lastStatus: number | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(2000),
      });
      lastStatus = res.status;
      // A dev server starts answering long before it has emitted the artifact
      // being asked for: the Module Federation manifest is written at the end
      // of the first compile, and until then the same port returns 404. The
      // old check accepted anything under 500, so a remote counted as ready
      // while its manifest was still missing, and the host was started against
      // remotes it could not resolve - which is how the host ends up compiling
      // with no output at all and the hook dies on the suite timeout with
      // nothing to read. Ready means this URL is actually serving.
      if (res.ok || (res.status >= 300 && res.status < 400)) {
        return;
      }
    } catch {
      lastStatus = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(
    `App did not become ready: ${url} (last status: ${
      lastStatus === undefined ? 'no response' : lastStatus
    })`,
  );
}

const remoteDir = path.resolve(__dirname, '../mf-remote');
const remoteTwoDir = path.resolve(__dirname, '../mf-remote-2');
const hostDir = path.resolve(__dirname, '../mf-host');
const fixtureRoot = path.resolve(__dirname, '..');

type FederatedPorts = {
  remote: number;
  remoteTwo: number;
  host: number;
};

async function createFederatedPorts(): Promise<FederatedPorts> {
  const ports = new Set<number>();
  while (ports.size < 3) {
    ports.add(await getPort());
  }
  const [remote, remoteTwo, host] = Array.from(ports);
  return {
    remote,
    remoteTwo,
    host,
  };
}

function isIgnorableWindowsTaskkillError(error: unknown) {
  if (process.platform !== 'win32' || !(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('Access is denied') ||
    error.message.includes('operation attempted is not supported')
  );
}

function createFederatedEnv(ports: FederatedPorts) {
  return {
    MF_REMOTE_PORT: String(ports.remote),
    MF_REMOTE_TWO_PORT: String(ports.remoteTwo),
    MF_HOST_PORT: String(ports.host),
    MF_HOST_ORIGIN: `http://localhost:${ports.host}`,
    MF_REMOTE_ORIGIN: `http://localhost:${ports.remote}`,
  };
}

async function fetchHtml(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'text/html',
      ...init?.headers,
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    html: await res.text(),
  };
}

async function fetchJson(url: string) {
  const res = await fetch(url);
  const json = await res.json();
  return {
    status: res.status,
    json,
  };
}

async function assertRedirectAndNotFoundHandoff(hostPort: number) {
  const redirectResponse = await fetchHtml(
    `http://localhost:${hostPort}/mf-redirect`,
    {
      redirect: 'manual',
    },
  );
  expect(redirectResponse.status).toBe(307);
  expect(redirectResponse.headers.get('location')).toBe('/mf');
  expect(redirectResponse.html).not.toContain('mf-redirect:unreachable');

  const notFoundResponse = await fetchHtml(
    `http://localhost:${hostPort}/mf-not-found`,
  );
  expect(notFoundResponse.status).toBe(404);
  expect(notFoundResponse.html).toContain('404');
  expect(notFoundResponse.html).not.toContain('mf-not-found:unreachable');
}

type TraceSpanSnapshot = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

function findLatestSpanByNameWhere(
  spans: TraceSpanSnapshot[],
  name: string,
  predicate: (span: TraceSpanSnapshot) => boolean,
): TraceSpanSnapshot | undefined {
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    if (span?.name === name && predicate(span)) {
      return span;
    }
  }
  return undefined;
}

function randomHex(bytes: number) {
  return randomBytes(bytes).toString('hex');
}

function createTraceparent() {
  const traceId = randomHex(16);
  const rootSpanId = randomHex(8);
  return {
    traceId,
    rootSpanId,
    traceparent: `00-${traceId}-${rootSpanId}-01`,
  };
}

async function assertEffectLocalePropagation(
  page: Page,
  hostPort: number,
  remotePort: number,
  errors: string[],
) {
  const initialErrorCount = errors.length;
  const acceptLanguage = 'zh-CN,zh;q=0.9';

  await page.goto(`http://localhost:${hostPort}/mf`, {
    waitUntil: ['networkidle0'],
    timeout: 50000,
  });

  const trace = createTraceparent();
  const runResult = (await page.evaluate(
    input =>
      fetch('/host-api/effect/trace/reset', {
        method: 'POST',
      }).then(resetHost =>
        fetch(
          `http://localhost:${input.remotePort}/remote-api/effect/trace/reset`,
          {
            method: 'POST',
          },
        ).then(resetRemote =>
          fetch('/host-api/effect/trace/run', {
            method: 'GET',
            headers: {
              traceparent: input.traceparent,
              'accept-language': input.acceptLanguage,
            },
          }).then(runResponse =>
            runResponse.json().then(runBody => ({
              resetHostStatus: resetHost.status,
              resetRemoteStatus: resetRemote.status,
              runStatus: runResponse.status,
              runBody,
            })),
          ),
        ),
      ),
    {
      traceparent: trace.traceparent,
      acceptLanguage,
      remotePort,
    },
  )) as {
    resetHostStatus: number;
    resetRemoteStatus: number;
    runStatus: number;
    runBody: {
      status?: 'ok';
      remoteStatus?: 'ok';
      traceparent?: string;
      locale?: string;
      remoteLocale?: string;
    };
  };

  expect(runResult.resetHostStatus).toBe(200);
  expect(runResult.resetRemoteStatus).toBe(200);
  expect(runResult.runStatus).toBe(200);
  expect(runResult.runBody).toMatchObject({
    status: 'ok',
    remoteStatus: 'ok',
    locale: acceptLanguage,
    remoteLocale: acceptLanguage,
  });
  expect(runResult.runBody.traceparent).toMatch(
    new RegExp(`^00-${trace.traceId}-[a-f0-9]{16}-01$`),
  );
  expect(runResult.runBody.traceparent).not.toBe(trace.traceparent);

  expect(errors.slice(initialErrorCount)).toEqual([]);
}

async function waitForTraceSpans(
  url: string,
  expectedNames: string[],
): Promise<TraceSpanSnapshot[]> {
  let lastSpanNames: string[] = [];
  for (let index = 0; index < 40; index++) {
    const response = await fetchJson(url);
    if (response.status === 200) {
      const spans =
        (response.json as { spans?: TraceSpanSnapshot[] }).spans || [];
      const spanNames = spans.map(span => span.name);
      lastSpanNames = spanNames;
      const hasAllExpected = expectedNames.every(name =>
        spanNames.includes(name),
      );
      if (hasAllExpected) {
        return spans;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for expected spans from ${url}. Last spans: ${lastSpanNames.join(
      ', ',
    )}`,
  );
}

async function assertModuleFederationAssets(remotePort: number) {
  const manifestResponse = await fetch(
    `http://localhost:${remotePort}/mf-manifest.json`,
  );
  expect(manifestResponse.status).toBe(200);
  const manifestContentType =
    manifestResponse.headers.get('content-type') || '';
  expect(manifestContentType).toContain('application/json');

  const manifest = (await manifestResponse.json()) as {
    metaData?: {
      remoteEntry?: {
        path?: string;
        name?: string;
      };
      publicPath?: string;
    };
    exposes?: Array<{
      name?: string;
      path?: string;
      assets?: {
        js?: {
          sync?: string[];
          async?: string[];
        };
      };
    }>;
  };
  const publicPath = manifest.metaData?.publicPath;
  expect(typeof publicPath).toBe('string');
  expect(publicPath).toBe(`http://localhost:${remotePort}/`);
  const exposes = manifest.exposes || [];
  expect(exposes.length).toBeGreaterThan(0);
  for (const expose of exposes) {
    expect(expose.path).toMatch(/^\.\//);
    expect((expose.assets?.js?.sync || []).length).toBeGreaterThan(0);
  }
  const mutatorExpose = exposes.find(expose => expose.name === 'Mutator');
  if (mutatorExpose) {
    expect((mutatorExpose.assets?.js?.async || []).length).toBeGreaterThan(0);
  }
  const remoteEntryName = manifest.metaData?.remoteEntry?.name;
  expect(remoteEntryName).toBeTruthy();
  if (!remoteEntryName) {
    throw new Error('Expected remoteEntry name in mf-manifest');
  }

  const remoteEntryPath = manifest.metaData?.remoteEntry?.path || '';
  const normalizedRemoteEntryPath =
    remoteEntryPath === '' || remoteEntryPath.endsWith('/')
      ? remoteEntryPath
      : `${remoteEntryPath}/`;
  const remoteEntryUrl = new URL(
    `${normalizedRemoteEntryPath}${remoteEntryName}`,
    `http://localhost:${remotePort}/`,
  );
  const remoteEntryResponse = await fetch(remoteEntryUrl);
  expect(remoteEntryResponse.status).toBe(200);
  const remoteEntryContentType =
    remoteEntryResponse.headers.get('content-type') || '';
  expect(remoteEntryContentType).toContain('javascript');

  await remoteEntryResponse.body?.cancel();
}

async function buildFederatedFixtureApp(
  appDir: string,
  env: Record<string, string>,
) {
  assertPluginDataLoaderRuntimeBuilt();
  let result:
    | {
        code: number | null;
        stdout?: string;
        stderr?: string;
      }
    | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    await fs.rm(path.join(appDir, 'dist'), {
      recursive: true,
      force: true,
    });
    result = await modernBuild(appDir, [], { env });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.code === 0 || !output.includes('ENOTEMPTY')) {
      break;
    }
  }

  if (!result || result.code !== 0) {
    throw new Error(
      `Failed to build ${path.basename(appDir)}.\n${result?.stdout || ''}\n${
        result?.stderr || ''
      }`,
    );
  }
  await waitForEffectEntry(appDir);
}

async function waitForEffectEntry(appDir: string) {
  const effectEntry = path.join(appDir, 'dist/api/effect/index.js');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.access(effectEntry);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Built ${path.basename(appDir)} without Effect entry: ${effectEntry}`,
  );
}

async function killAppBestEffort(app: unknown) {
  if (!app) {
    return;
  }
  try {
    await killApp(app);
  } catch (error) {
    if (isIgnorableWindowsTaskkillError(error)) {
      return;
    }
    throw error;
  }
}

async function stopFederatedApps(apps: unknown[]) {
  const results = await Promise.allSettled(apps.map(killAppBestEffort));
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) {
    throw rejected.reason;
  }
}

async function assertRemoteComponentInteraction(
  page: Page,
  hostPort: number,
  errors: string[],
) {
  await page.goto(`http://localhost:${hostPort}/mf`, {
    waitUntil: ['networkidle0'],
    timeout: 50000,
  });

  await page.waitForSelector('#remote-widget', { timeout: 50000 });
  const remoteText = await page.$eval('#remote-widget', el => el.textContent);
  expect(remoteText).toContain('remote-widget:ok');
  const remainingSsrFallbackNodes = await page.$$eval(
    [
      '#remote-ssr-fallback-contract',
      '#remote-ssr-placeholder',
      '#remote-mutator-ssr-placeholder',
      '#remote2-ssr-placeholder',
    ].join(','),
    nodes => nodes.length,
  );
  expect(remainingSsrFallbackNodes).toBe(0);
  const remoteWidgetStyle = await page.$eval('#remote-widget', el => {
    const style = window.getComputedStyle(el);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: style.fontWeight,
    };
  });
  expect(remoteWidgetStyle.color).toBe('rgb(124, 58, 237)');
  expect(remoteWidgetStyle.backgroundColor).toBe('rgb(243, 232, 255)');
  expect(remoteWidgetStyle.fontWeight).toBe('700');

  await page.waitForSelector('#remote-mutator', { timeout: 50000 });
  await page.waitForSelector('#remote2-panel', { timeout: 50000 });
  const remoteTwoText = await page.$eval(
    '#remote2-panel',
    el => el.textContent,
  );
  expect(remoteTwoText).toContain('remote2-panel:ok');
  const remoteTwoStyle = await page.$eval('#remote2-panel', el => {
    const style = window.getComputedStyle(el);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: style.fontWeight,
    };
  });
  expect(remoteTwoStyle.color).toBe('rgb(21, 128, 61)');
  expect(remoteTwoStyle.backgroundColor).toBe('rgb(240, 253, 244)');
  expect(remoteTwoStyle.fontWeight).toBe('700');

  const hostLoaderText = await page.$eval('#host-loader', el => el.textContent);
  expect(hostLoaderText).toBe('host-mf-loader');
  const hostLoaderStyle = await page.$eval('#host-loader', el => {
    const style = window.getComputedStyle(el);
    return {
      color: style.color,
      fontWeight: style.fontWeight,
    };
  });
  expect(hostLoaderStyle.color).toBe('rgb(3, 105, 161)');
  expect(hostLoaderStyle.fontWeight).toBe('700');
  await page.waitForFunction(
    () =>
      document.querySelector('#host-effect-message')?.textContent ===
      'host-effect:Hello from host Effect API',
    { timeout: 50000 },
  );

  const getHostCount = async () => {
    const text = await page.$eval('#host-mf-count', el => el.textContent || '');
    return Number(text.replace('host-mf-count:', ''));
  };

  const initialCount = await getHostCount();

  await page.click('[data-testid="remote-fetcher-submit"]');
  await page.waitForFunction(
    expected =>
      document.querySelector('#host-mf-count')?.textContent ===
      `host-mf-count:${expected}`,
    {},
    initialCount + 2,
  );

  await page.click('[data-testid="remote-fetcher-load"]');
  await page.waitForFunction(
    expected =>
      document.querySelector('#remote-fetcher-data')?.textContent ===
      `remote-fetcher:${expected}`,
    {},
    initialCount + 2,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('#remote-fetcher-state')?.textContent === 'idle',
    { timeout: 50000 },
  );
  expect(page.url()).toBe(`http://localhost:${hostPort}/mf`);

  const remoteFetcherState = await page.$eval(
    '#remote-fetcher-state',
    el => el.textContent,
  );
  expect(remoteFetcherState).toBe('idle');
  expect(errors).toEqual([]);
}

async function assertRemoteNativeBridgeNavigation(
  page: Page,
  hostPort: number,
  errors: string[],
) {
  await page.goto(`http://localhost:${hostPort}/mf`, {
    waitUntil: ['networkidle0'],
    timeout: 50000,
  });

  await page.waitForSelector('[data-testid="remote-one-native-link"]', {
    timeout: 50000,
  });
  await page.waitForSelector('[data-testid="remote-two-native-link"]', {
    timeout: 50000,
  });
  await page.waitForFunction(
    () =>
      document.querySelector('#host-boot-identity')?.textContent !== 'pending',
    { timeout: 50000 },
  );

  const readRealmState = () =>
    page.evaluate(() => ({
      hostBootIdentity: document.querySelector('#host-boot-identity')
        ?.textContent,
      navigationCount: performance.getEntriesByType('navigation').length,
      remoteOneIdentity: document
        .querySelector('#remote-one-runtime-realm')
        ?.getAttribute('data-router-realm'),
      remoteOneLocation: document.querySelector('#remote-one-router-location')
        ?.textContent,
      remoteTwoIdentity: document
        .querySelector('#remote-two-runtime-realm')
        ?.getAttribute('data-router-realm'),
      remoteTwoLocation: document.querySelector('#remote-two-router-location')
        ?.textContent,
      url: window.location.href,
    }));

  const initial = await readRealmState();
  expect(initial.hostBootIdentity).toEqual(expect.any(String));
  expect(initial.remoteOneIdentity).toEqual(expect.any(String));
  expect(initial.remoteTwoIdentity).toEqual(expect.any(String));
  expect(initial.remoteOneIdentity).not.toBe(initial.remoteTwoIdentity);
  expect(initial.navigationCount).toBe(1);

  await page.click('[data-testid="remote-one-native-link"]');
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get('remote') === 'one',
    { timeout: 50000 },
  );
  const afterRemoteOne = await readRealmState();
  expect(afterRemoteOne.url).toBe(`http://localhost:${hostPort}/mf?remote=one`);
  expect(afterRemoteOne.remoteOneLocation).toContain('remote=one');
  expect(afterRemoteOne.remoteTwoLocation).toContain('remote=one');
  expect(afterRemoteOne.hostBootIdentity).toBe(initial.hostBootIdentity);
  expect(afterRemoteOne.remoteOneIdentity).toBe(initial.remoteOneIdentity);
  expect(afterRemoteOne.remoteTwoIdentity).toBe(initial.remoteTwoIdentity);
  expect(afterRemoteOne.navigationCount).toBe(initial.navigationCount);

  await page.click('[data-testid="remote-two-native-link"]');
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get('remote') === 'two',
    { timeout: 50000 },
  );
  const afterRemoteTwo = await readRealmState();
  expect(afterRemoteTwo.url).toBe(`http://localhost:${hostPort}/mf?remote=two`);
  expect(afterRemoteTwo.remoteTwoLocation).toContain('remote=two');
  expect(afterRemoteTwo.remoteOneLocation).toContain('remote=two');
  expect(afterRemoteTwo.hostBootIdentity).toBe(initial.hostBootIdentity);
  expect(afterRemoteTwo.remoteOneIdentity).toBe(initial.remoteOneIdentity);
  expect(afterRemoteTwo.remoteTwoIdentity).toBe(initial.remoteTwoIdentity);
  expect(afterRemoteTwo.navigationCount).toBe(initial.navigationCount);
  expect(errors).toEqual([]);
}

async function assertDistributedTraceFromBrowser(
  page: Page,
  hostPort: number,
  remotePort: number,
  errors: string[],
) {
  const initialErrorCount = errors.length;

  await page.goto(`http://localhost:${hostPort}/mf`, {
    waitUntil: ['networkidle0'],
    timeout: 50000,
  });

  const trace = createTraceparent();
  const runResult = (await page.evaluate(
    input =>
      fetch('/host-api/effect/trace/reset', {
        method: 'POST',
      }).then(resetHost =>
        fetch(
          `http://localhost:${input.remotePort}/remote-api/effect/trace/reset`,
          {
            method: 'POST',
          },
        ).then(resetRemote =>
          fetch('/host-api/effect/trace/run', {
            method: 'GET',
            headers: {
              traceparent: input.traceparent,
            },
          }).then(runResponse =>
            runResponse.json().then(runBody => ({
              resetHostStatus: resetHost.status,
              resetRemoteStatus: resetRemote.status,
              runStatus: runResponse.status,
              runBody,
            })),
          ),
        ),
      ),
    {
      traceparent: trace.traceparent,
      remotePort,
    },
  )) as {
    resetHostStatus: number;
    resetRemoteStatus: number;
    runStatus: number;
    runBody: {
      status?: 'ok';
      remoteStatus?: 'ok';
      traceparent?: string;
      remoteLocale?: string;
    };
  };

  expect(runResult.resetHostStatus).toBe(200);
  expect(runResult.resetRemoteStatus).toBe(200);
  expect(runResult.runStatus).toBe(200);
  expect(runResult.runBody).toMatchObject({
    status: 'ok',
    remoteStatus: 'ok',
  });
  expect(runResult.runBody.remoteLocale).toEqual(expect.any(String));

  const hostSpans = await waitForTraceSpans(
    `http://localhost:${hostPort}/host-api/effect/trace/spans?traceId=${trace.traceId}`,
    ['mf.host.trace.run', 'mf.host.trace.remote.call'],
  );
  const remoteSpans = await waitForTraceSpans(
    `http://localhost:${remotePort}/remote-api/effect/trace/spans?traceId=${trace.traceId}`,
    ['mf.remote.trace.run', 'mf.remote.trace.db.query'],
  );

  const hostRunSpan = findLatestSpanByNameWhere(
    hostSpans,
    'mf.host.trace.run',
    span =>
      span.traceId === trace.traceId && span.parentSpanId === trace.rootSpanId,
  );
  const hostRemoteCallSpan = findLatestSpanByNameWhere(
    hostSpans,
    'mf.host.trace.remote.call',
    span =>
      span.traceId === trace.traceId &&
      span.parentSpanId === hostRunSpan?.spanId,
  );
  const remoteRunSpan = findLatestSpanByNameWhere(
    remoteSpans,
    'mf.remote.trace.run',
    span =>
      span.traceId === trace.traceId &&
      span.parentSpanId === hostRemoteCallSpan?.spanId,
  );
  const remoteDbSpan = findLatestSpanByNameWhere(
    remoteSpans,
    'mf.remote.trace.db.query',
    span =>
      span.traceId === trace.traceId &&
      span.parentSpanId === remoteRunSpan?.spanId,
  );

  expect(hostRunSpan).toBeDefined();
  expect(hostRemoteCallSpan).toBeDefined();
  expect(remoteRunSpan).toBeDefined();
  expect(remoteDbSpan).toBeDefined();

  if (!hostRunSpan || !hostRemoteCallSpan || !remoteRunSpan || !remoteDbSpan) {
    throw new Error('Expected distributed trace spans were not found');
  }

  expect(hostRunSpan.traceId).toBe(trace.traceId);
  expect(hostRemoteCallSpan.traceId).toBe(trace.traceId);
  expect(remoteRunSpan.traceId).toBe(trace.traceId);
  expect(remoteDbSpan.traceId).toBe(trace.traceId);

  expect(hostRunSpan.parentSpanId).toBe(trace.rootSpanId);
  expect(hostRemoteCallSpan.parentSpanId).toBe(hostRunSpan.spanId);
  expect(remoteRunSpan.parentSpanId).toBe(hostRemoteCallSpan.spanId);
  expect(remoteDbSpan.parentSpanId).toBe(remoteRunSpan.spanId);
  expect(runResult.runBody.traceparent).toBe(
    `00-${trace.traceId}-${hostRemoteCallSpan.spanId}-01`,
  );

  expect(errors.slice(initialErrorCount)).toEqual([]);
}

describe('routes-tanstack-mf', () => {
  let remoteApp: unknown;
  let remoteTwoApp: unknown;
  let hostApp: unknown;
  let browser: Browser;
  let page: Page;
  let ports: FederatedPorts;
  let releaseFixtureLock: ReleaseFixtureLock | undefined;
  const errors: string[] = [];

  beforeAll(async () => {
    releaseFixtureLock = await acquireFixtureLock(fixtureRoot);
    ports = await createFederatedPorts();
    const env = createFederatedEnv(ports);

    assertPluginDataLoaderRuntimeBuilt();

    remoteApp = await launchApp(remoteDir, ports.remote, { env });
    await waitForAppReady(`http://localhost:${ports.remote}/mf-manifest.json`);

    remoteTwoApp = await launchApp(remoteTwoDir, ports.remoteTwo, { env });
    await waitForAppReady(
      `http://localhost:${ports.remoteTwo}/mf-manifest.json`,
    );

    hostApp = await launchApp(hostDir, ports.host, { env });
    await waitForAppReady(`http://localhost:${ports.host}/`);

    browser = await puppeteer.launch(launchOptions as any);
    page = await browser.newPage();
    await collectBrowserErrors(page, errors);
  });

  afterAll(async () => {
    try {
      if (browser) {
        await browser.close();
      }
      await stopFederatedApps([hostApp, remoteTwoApp, remoteApp]);
    } finally {
      await releaseFixtureLock?.();
    }
  });

  test('renders the shell SSR fallback boundary', async () => {
    const { status, html } = await fetchHtml(
      `http://localhost:${ports.host}/mf`,
    );
    expect(status).toBe(200);
    expect(html).not.toContain('<!--<?- html ?>-->');
    expect(html).toContain('id="host-loader"');
    expect(html).toContain('host-mf-loader');
    expect(html).toContain('host-mf-count:');
    expect(html).toContain('id="remote-ssr-fallback-contract"');
    expect(html).toContain(
      'data-ssr-contract="typed-ssr-fallback-client-hydration"',
    );
    expect(html).toContain(
      'data-runtime-boundary="tanstack-mf-client-hydration"',
    );
    expect(html).toContain('data-hydration-owner="client"');
    expect(html).toContain('remote-widget:pending');
    expect(html).toContain('remote-mutator:pending');
    expect(html).toContain('remote2-panel:pending');
  });

  test('maps MF loader redirects and notFound responses through TanStack SSR', async () => {
    await assertRedirectAndNotFoundHandoff(ports.host);
  });

  test('exposes Effect BFF endpoints in the MF setup', async () => {
    for (const endpoint of [
      {
        port: ports.host,
        prefix: 'host-api',
        message: 'Hello from host Effect API',
        runtime: 'host',
      },
      {
        port: ports.remote,
        prefix: 'remote-api',
        message: 'Hello from remote Effect API',
        runtime: 'remote',
      },
    ]) {
      const effectResponse = await fetchJson(
        `http://localhost:${endpoint.port}/${endpoint.prefix}/effect/hello`,
      );
      expect(effectResponse.status).toBe(200);
      expect(effectResponse.json).toEqual({
        message: endpoint.message,
        runtime: endpoint.runtime,
      });

      const openapiResponse = await fetchJson(
        `http://localhost:${endpoint.port}/${endpoint.prefix}/openapi.json`,
      );
      expect(openapiResponse.status).toBe(200);
      expect(openapiResponse.json.paths['/effect/hello']).toBeDefined();
    }
  });

  test('publishes the live MF manifest ABI used by native remotes', async () => {
    const hostManifest = await fetchJson(
      `http://localhost:${ports.host}/mf-manifest.json`,
    );
    const remoteManifest = await fetchJson(
      `http://localhost:${ports.remote}/mf-manifest.json`,
    );
    const remoteTwoManifest = await fetchJson(
      `http://localhost:${ports.remoteTwo}/mf-manifest.json`,
    );

    expect(hostManifest.status).toBe(200);
    expect(remoteManifest.status).toBe(200);
    expect(remoteTwoManifest.status).toBe(200);
    expect(hostManifest.json.remotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: 'remote',
          entry: `http://localhost:${ports.remote}/mf-manifest.json`,
        }),
        expect.objectContaining({
          alias: 'remote2',
          entry: `http://localhost:${ports.remoteTwo}/mf-manifest.json`,
        }),
      ]),
    );
    expect(
      remoteManifest.json.exposes.map(
        (expose: { name?: string }) => expose.name,
      ),
    ).toEqual(expect.arrayContaining(['App', 'Widget', 'Mutator']));
    expect(
      remoteTwoManifest.json.exposes.map(
        (expose: { name?: string }) => expose.name,
      ),
    ).toEqual(expect.arrayContaining(['App', 'Panel']));

    // Hosts govern React by its own package names. Redact must publish under
    // those keys, once each, as a strict singleton carrying Redact's version.
    // Neither package exports package.json; the Redact entry is dist/react/index.js.
    const frameworkRequire = createRequire(
      createRequire(path.join(hostDir, 'package.json')).resolve(
        '@modern-js/ultramodern-app-tools',
      ),
    );
    const { version: redactVersion } = JSON.parse(
      await fs.readFile(
        path.resolve(
          path.dirname(frameworkRequire.resolve('@tanstack/redact')),
          '../../package.json',
        ),
        'utf8',
      ),
    ) as { version: string };
    type SharedEntry = {
      name: string;
      singleton?: boolean;
      requiredVersion?: string;
    };
    const runtimeShares = (manifest: { shared: SharedEntry[] }) =>
      manifest.shared.filter(({ name }) =>
        /^(?:react|react-dom|@tanstack\/redact)(?:\/|$)/.test(name),
      );
    for (const [manifest, required] of [
      [hostManifest.json, ['react', 'react-dom', 'react-dom/client']],
      [remoteManifest.json, ['react']],
      [remoteTwoManifest.json, ['react']],
    ] as const) {
      const shares = runtimeShares(manifest);
      expect(shares.map(({ name }) => name)).toEqual(
        expect.arrayContaining([...required]),
      );
      expect(new Set(shares.map(({ name }) => name)).size).toBe(shares.length);
      for (const share of shares)
        expect(share).toMatchObject({
          name: expect.not.stringMatching(/^@tanstack\//),
          singleton: true,
          requiredVersion: redactVersion,
        });
    }
  });

  test('supports remote component fetcher with host loader/action', async () => {
    await assertRemoteComponentInteraction(page, ports.host, errors);
  });

  test('routes native TanStack navigation from both remotes without reloading the host', async () => {
    await assertRemoteNativeBridgeNavigation(page, ports.host, errors);
  });

  test('captures browser -> host -> remote distributed otel trace', async () => {
    await assertDistributedTraceFromBrowser(
      page,
      ports.host,
      ports.remote,
      errors,
    );
  });

  test('propagates accept-language through host -> remote effect trace run', async () => {
    await assertEffectLocalePropagation(page, ports.host, ports.remote, errors);
  });
});

describe('routes-tanstack-mf serve mode', () => {
  let remoteApp: unknown;
  let remoteTwoApp: unknown;
  let hostApp: unknown;
  let ports: FederatedPorts;
  let releaseFixtureLock: ReleaseFixtureLock | undefined;

  beforeAll(async () => {
    releaseFixtureLock = await acquireFixtureLock(fixtureRoot);
    ports = await createFederatedPorts();
    const env = createFederatedEnv(ports);

    await buildFederatedFixtureApp(remoteDir, env);
    await buildFederatedFixtureApp(remoteTwoDir, env);
    await buildFederatedFixtureApp(hostDir, env);

    remoteApp = await modernServe(remoteDir, ports.remote, { env });
    await waitForAppReady(`http://localhost:${ports.remote}/mf-manifest.json`);

    remoteTwoApp = await modernServe(remoteTwoDir, ports.remoteTwo, {
      env,
    });
    await waitForAppReady(
      `http://localhost:${ports.remoteTwo}/mf-manifest.json`,
    );

    hostApp = await modernServe(hostDir, ports.host, { env });
    await waitForAppReady(`http://localhost:${ports.host}/`);
  });

  afterAll(async () => {
    try {
      await stopFederatedApps([hostApp, remoteTwoApp, remoteApp]);
    } finally {
      await releaseFixtureLock?.();
    }
  });

  test('serves module federation assets as static files', async () => {
    await assertModuleFederationAssets(ports.remote);
    await assertModuleFederationAssets(ports.remoteTwo);
  });
});
