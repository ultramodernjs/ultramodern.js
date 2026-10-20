import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { checkBundle } from '../../../scripts/ultramodern-renderers/bundle-check.mjs';
import {
  getPort,
  killApp,
  launchApp,
  launchOptions,
  modernBuild,
  modernServe,
  runModernCommand,
} from '../../utils/modernTestUtils';

export type Renderer = 'react' | 'solid' | 'octane';

export type SpecName =
  | 'ssr-html'
  | 'ssr-css'
  | 'hydration'
  | 'lazy'
  | 'client-nav'
  | 'back-forward'
  | 'loader-data'
  | 'action'
  | 'not-found'
  | 'loader-not-found'
  | 'redirect'
  | 'error-route'
  | 'head'
  | 'deferred'
  | 'no-react-bundle'
  | 'no-hmr-client'
  | 'node-deploy'
  | 'dev-hmr'
  | 'csr-shell'
  | 'csr-navigation'
  | 'csr-errors';

export interface RendererSpecOptions {
  renderer: Renderer;
  /** The fixture app. RENDERER_TARGET_DIR replaces it for packed-release runs. */
  appDir: string;
  /** HTML that marks the not-found UI; React renders the framework default. */
  notFoundMarker?: string;
  /** Specs this renderer cannot meet yet, with the reason. */
  skip?: Partial<Record<SpecName, string>>;
}

const workspaceBin = path.resolve(
  __dirname,
  '../../../packages/solutions/ultramodern-app-tools/bin/ultramodern.mjs',
);

const browserUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const id = (testId: string) => `[data-testid="${testId}"]`;

// Watchers must see either complete source revision, never a truncated module.
function replaceSourceFile(file: string, source: string) {
  const stagingDirectory = fs.mkdtempSync(
    path.join(path.dirname(file), '.renderer-hmr-'),
  );
  try {
    const stagedFile = path.join(stagingDirectory, 'source.tmp');
    fs.writeFileSync(stagedFile, source, { mode: fs.statSync(file).mode });
    fs.renameSync(stagedFile, file);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * One behavior contract for every renderer. Fixtures share the data-testid
 * names, loader cases and action intents, so each spec runs unchanged.
 */
export function defineRendererSpecs(options: RendererSpecOptions) {
  const { renderer } = options;
  const notFoundMarker =
    options.notFoundMarker ?? 'data-testid="native-not-found"';
  const appDir = process.env.RENDERER_TARGET_DIR ?? options.appDir;
  const modernBin = process.env.RENDERER_TARGET_BIN ?? workspaceBin;
  if (
    renderer !== 'react' &&
    process.env.RENDERER_TARGET_DIR &&
    (!process.env.RENDERER_NODE_DEPLOY_DIR ||
      !process.env.RENDERER_NODE_DEPLOY_BIN)
  )
    throw new Error(
      'Packed native specs require RENDERER_NODE_DEPLOY_DIR and RENDERER_NODE_DEPLOY_BIN for an ordinary packed deployment fixture',
    );
  const nodeDeployDir = process.env.RENDERER_NODE_DEPLOY_DIR ?? appDir;
  const nodeDeployBin = process.env.RENDERER_NODE_DEPLOY_BIN ?? modernBin;
  const spec = (
    name: SpecName,
    body: () => Promise<void>,
    timeout?: number,
  ) => {
    const reason = options.skip?.[name];
    if (reason) test.skip(`${name} (${reason})`, body);
    else test(name, body, timeout);
  };

  let origin: string;
  let browser: Browser;
  let page: Page;
  let pageErrors: string[];
  let documentRequests: string[];
  let sockets: string[];

  /** Owns one block's browser, server and temporary deploy directories. */
  function useApp(
    start: (
      port: number,
      ownServer: (app: ChildProcess) => void,
    ) => Promise<unknown>,
    ownedDirectories: () => string[] = () => [],
  ) {
    let app: ChildProcess | undefined;
    let appClosed: Promise<void> | undefined;
    let ownedBrowser: Browser | undefined;
    const ownServer = (instance: unknown) => {
      if (!(instance instanceof ChildProcess))
        throw new TypeError('Renderer server must return a child process');
      app = instance;
      appClosed = new Promise(resolve =>
        instance.once('close', () => resolve()),
      );
    };
    beforeAll(async () => {
      const port = await getPort();
      const started = await start(port, ownServer);
      if (!app) ownServer(started);
      origin = `http://localhost:${port}`;
      ownedBrowser = await puppeteer.launch(launchOptions as any);
      browser = ownedBrowser;
    });
    afterAll(async () => {
      const errors: unknown[] = [];
      try {
        await ownedBrowser?.close();
        ownedBrowser = undefined;
      } catch (error) {
        errors.push(error);
      }
      try {
        if (app) {
          if (app.exitCode === null && app.signalCode === null && app.pid)
            await killApp(app);
          // tree-kill's callback can precede close, especially on Windows.
          await appClosed;
          app = undefined;
        }
      } catch (error) {
        errors.push(error);
      }
      for (const directory of ownedDirectories()) {
        if (app || ownedBrowser) {
          errors.push(
            new Error(
              `Retained ${directory}: renderer resources did not close`,
            ),
          );
          continue;
        }
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Renderer teardown failed');
    });

    beforeEach(async () => {
      pageErrors = [];
      documentRequests = [];
      page = await browser.newPage();
      page.on('pageerror', error => pageErrors.push(String(error)));
      page.on('console', message => {
        if (message.type() === 'error') pageErrors.push(message.text());
      });
      page.on('request', request => {
        if (request.resourceType() === 'document')
          documentRequests.push(request.url());
      });
      sockets = [];
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.webSocketCreated', event => sockets.push(event.url));
      // Keep the first native-layout and native-lazy the document gets: the
      // server ones arrive before any bundle can render its own, so
      // hydration must leave those same nodes in place.
      await page.evaluateOnNewDocument(() => {
        const nodes: Record<string, Element> = {};
        (window as any).__ssrNodes = nodes;
        const observer = new MutationObserver(records => {
          for (const record of records)
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              for (const testId of ['native-layout', 'native-lazy']) {
                const selector = `[data-testid="${testId}"]`;
                const found = node.matches(selector)
                  ? node
                  : node.querySelector(selector);
                if (found) nodes[testId] ??= found;
              }
              if (nodes['native-layout'] && nodes['native-lazy'])
                return observer.disconnect();
            }
        });
        observer.observe(document, { childList: true, subtree: true });
      });
    });

    afterEach(async () => {
      await page?.close();
    });
  }

  async function build(env: Record<string, string> = {}) {
    const result = await modernBuild(appDir, [], { modernBin, env });
    if (result.code !== 0)
      throw new Error(`build failed\n${result.stdout}\n${result.stderr}`);
  }

  const text = (testId: string) =>
    page.$eval(id(testId), element => element.textContent ?? '');

  const waitForText = (testId: string, expected: string, timeout = 15_000) =>
    page.waitForFunction(
      (selector, value) =>
        document.querySelector(selector)?.textContent?.includes(value),
      { timeout },
      id(testId),
      expected,
    );

  const waitForStyle = (testId: string, property: string, value: string) =>
    page.waitForFunction(
      (selector, name, expected) => {
        const element = document.querySelector(selector);
        return (
          element !== null &&
          getComputedStyle(element).getPropertyValue(name) === expected
        );
      },
      { timeout: 15_000 },
      id(testId),
      property,
      value,
    );

  /**
   * Clicking the counter only updates once the page is hydrated, which the
   * counter marks. A click before then is not guaranteed to be replayed. A
   * cold dev server compiles the client on first request, so dev specs allow
   * it longer.
   */
  async function openHydrated(pathname: string, timeout = 15_000) {
    const response = await page.goto(`${origin}${pathname}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector(`${id('native-increment')}[data-hydrated]`, {
      timeout,
    });
    await page.click(id('native-increment'));
    await waitForText('native-count', '1', timeout);
    return response;
  }

  async function clickAndWait(testId: string, target: string) {
    await page.click(id(testId));
    await page.waitForSelector(id(target), { timeout: 15_000 });
  }

  /** Hydration kept the node the server rendered for this test id. */
  const adopted = (testId: string) =>
    page.$eval(
      id(testId),
      (element, key) => element === (window as any).__ssrNodes[key],
      testId,
    );

  /** The stylesheets a server document links, with their offsets in it. */
  const linkedStyles = (html: string) =>
    Promise.all(
      [...html.matchAll(/<link\b[^>]*>/g)]
        .filter(([tag]) => /\brel="stylesheet"/.test(tag))
        .map(async ({ 0: tag, index }) => ({
          index,
          css: await fetch(
            new URL(/\bhref="([^"]+)"/.exec(tag)![1], origin),
          ).then(response => response.text()),
        })),
    );

  const fetchHtml = async (pathname: string) => {
    const response = await fetch(`${origin}${pathname}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    return { response, html: await response.text() };
  };

  describe(`renderer ${renderer}`, () => {
    useApp(async port => {
      await build();
      return modernServe(appDir, port, { modernBin });
    });

    if (renderer !== 'react')
      spec('no-react-bundle', async () => {
        expect(checkBundle(path.join(appDir, 'dist'))).toEqual([]);
      });

    spec('no-hmr-client', async () => {
      await openHydrated('/');
      expect(sockets).toEqual([]);
    });

    spec('ssr-html', async () => {
      const { response, html } = await fetchHtml('/');
      expect(response.status).toBe(200);
      expect(html).toContain('data-testid="native-layout"');
      expect(html).toContain(`data-renderer="${renderer}"`);
      // The loader value is also in the hydration data script, so match the
      // rendered element.
      expect(html).toMatch(
        /data-testid="native-loader-value"[^>]*>[^<]*Native loader value/,
      );
    });

    spec('hydration', async () => {
      await openHydrated('/');
      expect(await adopted('native-layout')).toBe(true);
      await waitForStyle('native-layout', 'color', 'rgb(20, 40, 60)');
      expect(pageErrors).toEqual([]);
    });

    spec('ssr-css', async () => {
      // The layout and route stylesheets are linked from the server document
      // ahead of the markup they style, so the first paint is styled before
      // any bundle runs.
      for (const [pathname, selector, testId] of [
        ['/', 'native-layout', 'native-layout'],
        ['/about', 'native-about-route', 'native-about'],
      ]) {
        const { html } = await fetchHtml(pathname);
        const markup = html.indexOf(`data-testid="${testId}"`);
        expect(markup).toBeGreaterThan(-1);
        const style = (await linkedStyles(html)).find(({ css }) =>
          css.includes(selector),
        );
        expect(style).toBeDefined();
        expect(style!.index).toBeLessThan(markup);
        // Native documents also link styles ahead of every script. React's
        // document puts its async entry scripts in the head first.
        if (renderer !== 'react')
          expect(style!.index).toBeLessThan(
            html.search(/<script\b[^>]*\bsrc=/),
          );
      }
    });

    spec('lazy', async () => {
      // The server renders the lazy component and links its stylesheet
      // ahead of it, so it is styled before any bundle runs.
      const { html } = await fetchHtml('/');
      const lazy = html.search(/data-testid=\\?"native-lazy\\?"/);
      expect(lazy).toBeGreaterThan(-1);
      const style = (await linkedStyles(html)).find(({ css }) =>
        css.includes('native-lazy-detail'),
      );
      expect(style).toBeDefined();
      expect(style!.index).toBeLessThan(lazy);

      await openHydrated('/');
      await page.waitForSelector(id('native-lazy'), { timeout: 15_000 });
      await waitForStyle('native-lazy', 'border-inline-start-width', '2px');
      // Hydration adopts the server's lazy subtree and makes it interactive.
      // The eager counter can hydrate before Octane's lazy boundary.
      if (renderer === 'octane') {
        await page.waitForSelector(
          `${id('native-lazy-increment')}[data-hydrated]`,
          { timeout: 15_000 },
        );
      }
      await page.click(id('native-lazy-increment'));
      await waitForText('native-lazy-count', '1');
      expect(await adopted('native-lazy')).toBe(true);
      expect(pageErrors).toEqual([]);
    });

    spec('client-nav', async () => {
      await openHydrated('/');
      await page.evaluate(() => {
        (window as any).__sameWindow = true;
      });
      const before = documentRequests.length;
      await clickAndWait('nav-about', 'native-about');
      expect(new URL(page.url()).pathname).toBe('/about');
      expect(documentRequests.length).toBe(before);
      expect(await page.evaluate(() => (window as any).__sameWindow)).toBe(
        true,
      );
      expect(pageErrors).toEqual([]);
    });

    spec('back-forward', async () => {
      await openHydrated('/');
      await clickAndWait('nav-about', 'native-about');
      const before = documentRequests.length;
      await page.goBack();
      await page.waitForSelector(id('native-route'));
      await page.goForward();
      await page.waitForSelector(id('native-about'));
      expect(documentRequests.length).toBe(before);
    });

    spec('loader-data', async () => {
      const { html } = await fetchHtml('/items/1');
      expect(html).toMatch(/data-testid="native-item-value"[^>]*>[^<]*Item 1/);
      await openHydrated('/');
      await clickAndWait('nav-item', 'native-item');
      await waitForText('native-item-value', 'Item 1');
      expect(new URL(page.url()).pathname).toBe('/items/1');
    });

    spec('action', async () => {
      await openHydrated('/');
      await page.type('input[name="name"]', 'Ada');
      await page.click(id('native-submit'));
      await waitForText('native-action-value', 'Ada');

      await page.$eval('input[name="name"]', input => {
        (input as HTMLInputElement).value = '';
      });
      // The 422 validation outcome reaches the page; each fixture shows its
      // status through the renderer's own action API.
      await page.click(id('native-submit'));
      await page.waitForFunction(
        selector =>
          [...document.querySelectorAll(selector)].some(element =>
            element.textContent?.includes('422'),
          ),
        { timeout: 15_000 },
        `${id('native-action-value')}, ${id('native-action-error')}`,
      );

      await page.type('input[name="name"]', 'Grace');
      await clickAndWait('native-submit-redirect', 'native-about');
      expect(new URL(page.url()).pathname).toBe('/about');
      const cookies = await browser.cookies();
      expect(cookies.some(cookie => cookie.name === 'renderer-saved')).toBe(
        true,
      );
    });

    spec('not-found', async () => {
      const { response, html } = await fetchHtml('/no-such-route');
      expect(response.status).toBe(404);
      expect(html).toContain(notFoundMarker);
    });

    spec('loader-not-found', async () => {
      const { response, html } = await fetchHtml('/?case=not-found');
      expect(response.status).toBe(404);
      expect(html).toContain(notFoundMarker);
    });

    spec('redirect', async () => {
      const { response } = await fetchHtml('/?case=redirect');
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(new URL(response.headers.get('location')!, origin).pathname).toBe(
        '/about',
      );
    });

    spec('error-route', async () => {
      const { response } = await fetchHtml('/?case=error');
      expect(response.status).toBe(500);
      await page.goto(`${origin}/?case=error`);
      await page.waitForSelector(id('native-error'), { timeout: 15_000 });
    });

    spec('head', async () => {
      const { html } = await fetchHtml('/');
      expect(html).toMatch(new RegExp(`<title[^>]*>${renderer} fixture home<`));
      expect(html).toContain('content="Renderer fixture"');
      await openHydrated('/');
      await clickAndWait('nav-about', 'native-about');
      await page.waitForFunction(
        expected => document.title === expected,
        { timeout: 15_000 },
        `${renderer} fixture about`,
      );
    });

    spec('deferred', async () => {
      // The late value resolves 1.5s after the shell, so the stream must
      // carry the fallback first and the value afterwards.
      // Bots get the fully resolved document, so ask as a browser would.
      const response = await fetch(`${origin}/?case=deferred`, {
        headers: { 'user-agent': browserUserAgent },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let pendingBeforeLate = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (
          html.includes('native-deferred-pending') &&
          !html.includes('Native late value')
        )
          pendingBeforeLate = true;
      }
      expect(pendingBeforeLate).toBe(true);
      // The resolved value also arrives in a data script, so match the
      // streamed boundary markup (Octane streams it JSON-encoded).
      const late = html.search(
        /data-testid=\\?"native-deferred-late\\?"[^>]*>Native late value/,
      );
      expect(late).toBeGreaterThan(html.indexOf('native-deferred-pending'));

      await openHydrated('/');
      await clickAndWait('nav-about', 'native-about');
      await page.click(id('nav-deferred'));
      await page.waitForSelector(id('native-deferred-pending'));
      await waitForText('native-deferred-late', 'Native late value');
      expect(pageErrors).toEqual([]);
    });
  });

  // A CSR build of the same app: an empty shell the client renders into.
  if (renderer !== 'react')
    describe(`renderer ${renderer} csr`, () => {
      useApp(async port => {
        const env = { RENDERER_CSR: 'true' };
        await build(env);
        return modernServe(appDir, port, { modernBin, env });
      });

      spec('csr-shell', async () => {
        const { response, html } = await fetchHtml('/');
        expect(response.status).toBe(200);
        expect(html).not.toContain('data-testid="native-layout"');
        expect(html.match(/id="root"/g)).toHaveLength(1);
        await openHydrated('/');
        expect(await page.$$eval('#root', roots => roots.length)).toBe(1);
        expect(await page.$$eval(id('native-layout'), all => all.length)).toBe(
          1,
        );
        await waitForText('native-loader-value', 'Native loader value');
        await waitForStyle('native-layout', 'color', 'rgb(20, 40, 60)');
        expect(pageErrors).toEqual([]);
      });

      spec('csr-navigation', async () => {
        await openHydrated('/');
        const before = documentRequests.length;
        await clickAndWait('nav-about', 'native-about');
        await page.goBack();
        await page.waitForSelector(id('native-route'));
        await page.goForward();
        await page.waitForSelector(id('native-about'));
        await clickAndWait('nav-item', 'native-item');
        await waitForText('native-item-value', 'Item 1');
        await clickAndWait('nav-deferred', 'native-deferred-pending');
        await waitForText('native-deferred-late', 'Native late value');
        expect(documentRequests.length).toBe(before);
        expect(pageErrors).toEqual([]);
      });

      spec('csr-errors', async () => {
        // The server only sends the shell, so these answer 200 and the
        // client renders the outcome.
        for (const [pathname, testId] of [
          ['/no-such-route', 'native-not-found'],
          ['/?case=not-found', 'native-not-found'],
          ['/?case=error', 'native-error'],
        ]) {
          const { response, html } = await fetchHtml(pathname);
          expect(response.status).toBe(200);
          expect(html).toContain('id="root"');
          await page.goto(`${origin}${pathname}`);
          await page.waitForSelector(id(testId), { timeout: 15_000 });
        }
      });
    });

  describe(`renderer ${renderer} dev`, () => {
    const messageFile = path.join(appDir, 'src/components/Message.tsx');
    const original = fs.readFileSync(messageFile, 'utf8');
    useApp(port => launchApp(appDir, port, { modernBin }));
    afterAll(() => replaceSourceFile(messageFile, original));

    spec(
      'dev-hmr',
      async () => {
        await openHydrated('/', 60_000);
        await page.evaluate(() => {
          (window as any).__sameWindow = true;
        });
        const before = documentRequests.length;
        try {
          replaceSourceFile(
            messageFile,
            original.replace('Native message', 'Native message edited'),
          );
          // A dev rebuild can take tens of seconds on a busy machine.
          await page.waitForFunction(
            selector =>
              document.querySelector(selector)?.textContent ===
              'Native message edited',
            { timeout: 60_000 },
            id('native-message'),
          );
          // Counter is a sibling of the edited module and keeps its state.
          expect(await text('native-count')).toBe('1');
          expect(documentRequests.length).toBe(before);
          expect(await page.evaluate(() => (window as any).__sameWindow)).toBe(
            true,
          );
          await waitForStyle('native-layout', 'color', 'rgb(20, 40, 60)');
          expect(sockets.length).toBeGreaterThan(0);
          expect(pageErrors).toEqual([]);
        } finally {
          replaceSourceFile(messageFile, original);
        }
      },
      // Cold dev compilation plus a rebuild can each take tens of seconds.
      150_000,
    );
  });

  // The node deploy output must serve from any directory: it may only use
  // what deploy traced into it, never the app's own node_modules.
  // Packed runs provide a separate ordinary app. The generated shell keeps
  // its delivery-unit release gate; this fixture proves plain Node deployment.
  if (renderer !== 'react')
    describe(`renderer ${renderer} node deploy`, () => {
      const output = path.join(nodeDeployDir, '.output');
      let isolated: string | undefined;
      let ownsOutput = false;
      let deployedServerLog = '';
      useApp(
        async (port, ownServer) => {
          if (fs.existsSync(output))
            throw new Error(
              `Refusing to replace an existing deploy output: ${output}`,
            );
          ownsOutput = true;
          const result = await runModernCommand(['deploy'], {
            cwd: nodeDeployDir,
            modernBin: nodeDeployBin,
            env: { NODE_ENV: 'production', MODERNJS_DEPLOY: 'node' },
          });
          if (result.code !== 0)
            throw new Error(
              `deploy failed\n${result.stdout}\n${result.stderr}`,
            );
          isolated = fs.realpathSync(
            fs.mkdtempSync(
              path.join(os.tmpdir(), `renderer-${renderer}-deploy-`),
            ),
          );
          fs.cpSync(output, isolated, {
            recursive: true,
            verbatimSymlinks: true,
          });
          for (const entry of fs.readdirSync(isolated, {
            recursive: true,
            withFileTypes: true,
          })) {
            if (!entry.isSymbolicLink()) continue;
            const resolved = fs.realpathSync(
              path.join(entry.parentPath, entry.name),
            );
            expect(resolved.startsWith(`${isolated}${path.sep}`)).toBe(true);
          }
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'production',
          };
          delete env.NODE_PATH;
          const server = spawn(
            process.execPath,
            [
              '--permission',
              `--allow-fs-read=${isolated}`,
              `--allow-fs-write=${isolated}`,
              '--allow-net',
              'index',
            ],
            { cwd: isolated, env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          ownServer(server);
          let spawnError: Error | undefined;
          server.once('error', error => {
            spawnError = error;
          });
          server.stdout.on('data', chunk => (deployedServerLog += chunk));
          server.stderr.on('data', chunk => (deployedServerLog += chunk));
          const deadline = Date.now() + 60_000;
          for (;;) {
            if (spawnError) throw spawnError;
            if (server.exitCode !== null)
              throw new Error(`deployed server exited\n${deployedServerLog}`);
            try {
              await fetch(`http://localhost:${port}/`, {
                signal: AbortSignal.timeout(2_000),
              });
              return server;
            } catch {
              if (spawnError) throw spawnError;
              if (Date.now() > deadline)
                throw new Error(
                  `deployed server did not start\n${deployedServerLog}`,
                );
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          }
        },
        () =>
          [isolated, ownsOutput ? output : undefined].filter(
            (directory): directory is string => directory !== undefined,
          ),
      );

      spec('node-deploy', async () => {
        const failedClientRequests: string[] = [];
        page.on('requestfailed', request => {
          if (request.resourceType() === 'script')
            failedClientRequests.push(
              `${request.url()}: ${request.failure()?.errorText}`,
            );
        });
        page.on('response', response => {
          if (
            response.status() >= 400 &&
            response.request().resourceType() === 'script'
          )
            failedClientRequests.push(
              `${response.url()}: HTTP ${response.status()}`,
            );
        });
        const { response, html } = await fetchHtml('/');
        expect(response.status).toBe(200);
        expect(html).toContain('data-testid="native-layout"');
        expect(html).toContain(`data-renderer="${renderer}"`);
        expect(html).toMatch(
          /data-testid="native-loader-value"[^>]*>[^<]*Native loader value/,
        );
        try {
          await openHydrated('/');
        } catch (error) {
          console.error(
            'Node deploy hydration diagnostics',
            JSON.stringify({
              url: page.url(),
              pageErrors,
              failedClientRequests,
              serverLog: deployedServerLog.slice(-16_384),
            }),
          );
          throw error;
        }
        expect(await adopted('native-layout')).toBe(true);
        await waitForStyle('native-layout', 'color', 'rgb(20, 40, 60)');
        await page.type('input[name="name"]', 'Ada');
        await page.click(id('native-submit'));
        await waitForText('native-action-value', 'Ada');
        const before = documentRequests.length;
        await clickAndWait('nav-about', 'native-about');
        expect(documentRequests.length).toBe(before);
        await waitForStyle('native-about', 'border-block-start-width', '3px');
        await clickAndWait('nav-item', 'native-item');
        await waitForText('native-item-value', 'Item 1');
        expect((await fetchHtml('/no-such-route')).response.status).toBe(404);
        expect((await fetchHtml('/?case=error')).response.status).toBe(500);
        const redirect = (await fetchHtml('/?case=redirect')).response;
        expect(redirect.status).toBeGreaterThanOrEqual(300);
        expect(redirect.status).toBeLessThan(400);
        expect(
          new URL(redirect.headers.get('location')!, origin).pathname,
        ).toBe('/about');
        expect(pageErrors).toEqual([]);
        expect(sockets).toEqual([]);
      });
    });
}
