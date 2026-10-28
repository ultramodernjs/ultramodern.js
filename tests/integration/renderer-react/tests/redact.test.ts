import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import {
  acquireFixtureLock,
  type ReleaseFixtureLock,
} from '../../../utils/fixtureLock';
import {
  getPort,
  killApp,
  launchOptions,
  modernBuild,
  modernServe,
  runModernCommand,
} from '../../../utils/modernTestUtils';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';

setSuiteTimeout(5 * 60_000);
const appDir = path.resolve(__dirname, '..');
const modernBin = path.resolve(
  __dirname,
  '../../../../packages/solutions/ultramodern-app-tools/bin/ultramodern.mjs',
);
const outputDirectory = path.join(appDir, '.output');
const usesRedact = process.env.REDACT_ACCEPTANCE_OPTOUT !== 'true';
const probes = [
  'outside',
  'slow',
  'fast',
  'row',
  'svg',
  ...Array.from({ length: 8 }, (_, i) => `segment-${i}`),
];

function successful(
  label: string,
  result: { code: number | null; stdout?: string; stderr?: string },
) {
  if (result.code !== 0)
    throw new Error(
      `${label} failed (${result.code})\n${result.stdout}\n${result.stderr}`,
    );
}

async function holdApplicationEntry(page: Page, errors: string[]) {
  let blockedEntries = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      if (
        request.resourceType() === 'script' &&
        /\/static\/js\/index\.[^/]+\.js$/.test(new URL(request.url()).pathname)
      ) {
        blockedEntries++;
        await ready;
      }
      if (!request.isInterceptResolutionHandled()) await request.continue();
    })().catch(error => errors.push(String(error)));
  });
  return {
    release,
    get blockedEntries() {
      return blockedEntries;
    },
  };
}

async function startWorker() {
  const wrangler = JSON.parse(
    await readFile(path.join(outputDirectory, 'wrangler.json'), 'utf8'),
  );
  const modules = new Set<string>([path.join(outputDirectory, wrangler.main)]);
  for (const directory of ['server', 'worker']) {
    for (const entry of await readdir(path.join(outputDirectory, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile() && /\.(?:c|m)?js$/u.test(entry.name))
        modules.add(path.join(entry.parentPath, entry.name));
    }
  }
  return new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: wrangler.name,
          modules: [...modules].map(file => ({
            path: file,
            type: file.endsWith('.cjs') ? 'CommonJS' : 'ESModule',
          })),
          modulesRoot: outputDirectory,
          compatibilityDate: wrangler.compatibility_date,
          compatibilityFlags: wrangler.compatibility_flags,
          assets: {
            binding: wrangler.assets.binding,
            directory: path.resolve(outputDirectory, wrangler.assets.directory),
            routerConfig: {
              has_user_worker: true,
              invoke_user_worker_ahead_of_assets: true,
            },
          },
        },
      ],
    }),
  );
}

for (const runtime of ['node', 'workerd'] as const) {
  describe(`${usesRedact ? 'default Redact' : 'real React control'} ${runtime}`, () => {
    let release: ReleaseFixtureLock | undefined;
    let app: ChildProcess | undefined;
    let worker: Miniflare | undefined;
    let browser: Browser | undefined;
    let page: Page;
    let origin: string;
    let errors: string[];

    beforeAll(async () => {
      release = await acquireFixtureLock(appDir);
      const env =
        runtime === 'workerd' ? { MODERNJS_DEPLOY: 'cloudflare' } : {};
      successful('build', await modernBuild(appDir, [], { modernBin, env }));
      if (runtime === 'workerd') {
        successful(
          'deploy',
          await runModernCommand(['deploy', '--skip-build'], {
            cwd: appDir,
            modernBin,
            env: { ...env, NODE_ENV: 'production' },
          }),
        );
        worker = await startWorker();
        origin = (await worker.ready).origin;
      } else {
        const port = await getPort();
        app = await modernServe(appDir, port, { modernBin });
        origin = `http://localhost:${port}`;
      }
      browser = await puppeteer.launch(launchOptions as any);
    });

    afterAll(async () => {
      // Release the fixture only after every owned process has stopped, even
      // when compilation, browser startup or an assertion fails.
      try {
        await browser?.close();
      } finally {
        try {
          await worker?.dispose();
        } finally {
          try {
            if (app) await killApp(app);
          } finally {
            await release?.();
          }
        }
      }
    });

    beforeEach(async () => {
      errors = [];
      page = await browser!.newPage();
      page.on('pageerror', error => errors.push(String(error)));
      page.on('response', response => {
        if (response.status() >= 400)
          errors.push(`${response.status()} ${response.url()}`);
      });
      page.on('console', message => {
        if (
          message.type() === 'error' ||
          /hydration|did not match|server rendered/i.test(message.text())
        )
          errors.push(message.text());
      });
    });
    afterEach(async () => {
      try {
        expect(errors).toEqual([]);
      } finally {
        await page?.close();
      }
    });

    test('client and server compile only the selected runtime', async () => {
      const compilations = JSON.parse(
        await readFile(path.join(appDir, 'dist/redact-modules.json'), 'utf8'),
      ) as Array<{ name: string; modules?: unknown[] }>;
      expect(compilations.length).toBeGreaterThanOrEqual(2);
      expect(compilations.some(c => c.name === 'client')).toBe(true);
      expect(
        compilations.some(
          c => c.name === (runtime === 'workerd' ? 'workerSSR' : 'server'),
        ),
      ).toBe(true);
      for (const compilation of compilations) {
        const modules = JSON.stringify(compilation.modules);
        const redactModule = /@tanstack[\\/]redact[\\/]dist/;
        const reactDomModule =
          /node_modules[\\/](?:\.pnpm[\\/]react-dom@[^\\/]+[\\/]node_modules[\\/])?react-dom[\\/]/;
        const reactDomExternal =
          /external[^"\n]*["\\]+react-dom(?:[\\/]|["\\])/;
        if (usesRedact) {
          expect(modules, compilation.name).toMatch(redactModule);
          expect(modules, compilation.name).not.toMatch(reactDomModule);
          expect(modules, compilation.name).not.toMatch(reactDomExternal);
        } else {
          expect(modules, compilation.name).not.toMatch(redactModule);
          expect(
            reactDomModule.test(modules) || reactDomExternal.test(modules),
            compilation.name,
          ).toBe(true);
        }
      }
    });

    test('streams reversed siblings and prefixed hexadecimal transport ids', async () => {
      const request = {
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: 'text/html',
          // Compression may coalesce otherwise progressive HTTP chunks.
          'accept-encoding': 'identity',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
      };
      const response = worker
        ? await worker.dispatchFetch(`${origin}/redact`, request)
        : await fetch(`${origin}/redact`, request);
      expect(response.status).toBe(200);
      let html = '';
      let shellBeforeSlow = false;
      const chunks: number[] = [];
      for await (const chunk of response.body!) {
        chunks.push(chunk.length);
        html += new TextDecoder().decode(chunk);
        if (
          html.includes('data-pending="slow"') &&
          !html.includes('data-probe="slow"')
        )
          shellBeforeSlow = true;
      }
      expect(
        shellBeforeSlow,
        JSON.stringify({ chunks, headers: [...response.headers] }),
      ).toBe(true);
      expect(html).toMatch(/id="_modern-js-R_[^"]+_"/);
      const segments = [...html.matchAll(/id="modern-js-S:([0-9a-f]+)"/g)].map(
        match => match[1],
      );
      expect(segments.length).toBeGreaterThanOrEqual(12);
      expect(segments).toContain('a');
      expect(segments).toContain('b');
      expect(html).not.toMatch(/id="[BS]:/);
      expect(html.indexOf('data-probe="fast"')).toBeLessThan(
        html.indexOf('data-probe="slow"'),
      );
      expect(html).toContain('data-probe="row"');
      expect(html).toContain('data-probe="svg"');
      expect(html).toContain('$_TSR.e()');
      expect(html.indexOf('$tsr-stream-boundary')).toBeGreaterThan(
        html.indexOf('<body'),
      );
    });

    test('hydrates and activates a server subtree revealed after the client entry runs', async () => {
      const request = {
        headers: {
          accept: 'text/html',
          'accept-encoding': 'identity',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(20_000),
      };
      const response = worker
        ? await worker.dispatchFetch(`${origin}/redact`, request)
        : await fetch(`${origin}/redact`, request);
      expect(response.status).toBe(200);
      const html = await response.text();
      const slow = html.indexOf('data-probe="slow"');
      const segment = html.indexOf('<div hidden id="modern-js-S:');
      const reveal = html.indexOf('<script', slow);
      expect(slow).toBeGreaterThan(0);
      expect(segment).toBeGreaterThan(0);
      expect(reveal).toBeGreaterThan(slow);
      expect(html.slice(0, segment)).toContain('data-pending="slow"');
      expect(html.slice(0, segment)).not.toContain('data-probe="slow"');

      // Replay the actual server response unchanged, but gate its delivery.
      // Unlike a timer, this guarantees hydration starts before the late
      // transport arrives on even the slowest CI browser. Assets still come
      // from the ordinary production server (Node or workerd).
      let releaseSegment!: () => void;
      let releaseReveal!: () => void;
      const segmentReady = new Promise<void>(resolve => {
        releaseSegment = resolve;
      });
      const revealReady = new Promise<void>(resolve => {
        releaseReveal = resolve;
      });
      const entry = await holdApplicationEntry(page, errors);
      const transport = createServer((request, result) => {
        if (request.url === '/redact') {
          result.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          result.write(html.slice(0, segment));
          void (async () => {
            await segmentReady;
            result.write(html.slice(segment, reveal));
            await revealReady;
            result.end(html.slice(reveal));
          })().catch(error => result.destroy(error));
          return;
        }
        const upstream = proxyRequest(
          new URL(request.url!, origin),
          { method: request.method, headers: request.headers },
          upstreamResponse => {
            result.writeHead(
              upstreamResponse.statusCode!,
              upstreamResponse.headers,
            );
            upstreamResponse.pipe(result);
          },
        );
        upstream.on('error', error => result.destroy(error));
        result.on('close', () => upstream.destroy());
        request.pipe(upstream);
      });
      let navigation: ReturnType<Page['goto']> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          transport.once('error', reject);
          transport.listen(0, '127.0.0.1', () => {
            transport.off('error', reject);
            resolve();
          });
        });
        const port = (transport.address() as AddressInfo).port;
        navigation = page.goto(`http://127.0.0.1:${port}/redact`, {
          waitUntil: 'networkidle0',
        });
        void navigation.catch(() => {});
        await page.waitForSelector('[data-testid="mount-id"]');
        await page.waitForSelector('[data-pending="slow"]');
        if (usesRedact) {
          await page.waitForFunction(
            () => typeof (window as any).$RH === 'function',
          );
        }
        expect(entry.blockedEntries).toBeGreaterThan(0);
        entry.release();
        // This effect and interaction prove the application entry actually
        // hydrated the shell; merely releasing a request would not prove it.
        await page.waitForSelector(
          '[data-testid="redact-hydration"][data-hydrated="true"]',
        );
        await page.click('[data-probe="outside-button"]');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-probe="outside-button"]')
              ?.textContent === '1',
        );
        expect(await page.$('[data-pending="slow"]')).not.toBeNull();
        expect(await page.$('[data-probe="slow"]')).toBeNull();

        releaseSegment();
        await page.waitForSelector('[data-probe="slow"]');
        const serverId = await page.$eval('[data-probe="slow"]', node => {
          (window as any).__lateServerNode = node;
          return { id: node.id, clientId: node.getAttribute('data-client-id') };
        });
        expect(serverId.id).toMatch(/^_modern-js-R_.+_$/);
        expect(serverId.clientId).toBeNull();
        expect(await page.$('[data-pending="slow"]')).not.toBeNull();

        releaseReveal();
        await navigation;
        await page.waitForSelector('[data-probe="slow"][data-client-id]', {
          timeout: 15_000,
        });
        const hydrated = await page.$eval('[data-probe="slow"]', node => ({
          id: node.id,
          clientId: node.getAttribute('data-client-id'),
          adopted: node === (window as any).__lateServerNode,
        }));
        expect(hydrated).toEqual({
          id: serverId.id,
          clientId: serverId.id,
          adopted: true,
        });
        expect(await page.$('[data-pending="slow"]')).toBeNull();
        await page.click('[data-probe="slow-button"]');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-probe="slow-button"]')
              ?.textContent === '1',
        );
      } finally {
        entry.release();
        releaseSegment();
        releaseReveal();
        try {
          await navigation;
        } finally {
          if (transport.listening) {
            transport.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              transport.close(error => (error ? reject(error) : resolve()));
            });
          }
        }
      }
    });

    test('hydrates the original nodes and ids, preserves table/SVG contexts and mounts a unique client id', async () => {
      // Hold only the async application entry, not parser-blocking route
      // preloads. Inline reveal scripts can finish before hydration starts.
      const entry = await holdApplicationEntry(page, errors);
      const navigation = page.goto(`${origin}/redact`, {
        waitUntil: 'networkidle0',
      });
      // Attach a rejection handler immediately; the original promise is still
      // awaited below, including when the pre-hydration checks fail.
      void navigation.catch(() => {});
      try {
        await page.waitForFunction(
          names =>
            names.every(name =>
              document.querySelector(`[data-probe="${name}"]`),
            ),
          { timeout: 30_000 },
          probes,
        );
        await page.waitForFunction(
          () => (window as any).$_TSR?.streamEnded === true,
          { timeout: 15_000 },
        );
        const before = await page.evaluate(names => {
          const nodes = names.map(
            name => document.querySelector(`[data-probe="${name}"]`)!,
          );
          (window as any).__redactServerNodes = nodes;
          (window as any).__redactServerIds = nodes.map(node => node.id);
          return {
            ids: nodes.map(node => node.id),
            clientIds: nodes.map(node => node.getAttribute('data-client-id')),
            hydrated: document
              .querySelector('[data-testid="redact-hydration"]')
              ?.getAttribute('data-hydrated'),
          };
        }, probes);
        expect(entry.blockedEntries).toBeGreaterThan(0);
        expect(before.hydrated).toBe('false');
        expect(before.clientIds).toEqual(probes.map(() => null));
        expect(before.ids.every(id => /^_modern-js-R_.+_$/.test(id))).toBe(
          true,
        );
        expect(new Set(before.ids).size).toBe(before.ids.length);
        entry.release();
        await navigation;
        await page.waitForSelector(
          '[data-testid="redact-hydration"][data-hydrated="true"]',
        );
        // Each streamed subtree must commit its own client effect. Merely
        // finding its server DOM (or settling loader promises) cannot prove
        // hydration, even when the outer component is already interactive.
        await page.waitForFunction(
          names =>
            names.every(name =>
              document.querySelector(`[data-probe="${name}"][data-client-id]`),
            ),
          { timeout: 15_000 },
          probes,
        );
        const after = await page.evaluate(names => {
          const nodes = names.map(
            name => document.querySelector(`[data-probe="${name}"]`)!,
          );
          return {
            ids: nodes.map(node => node.id),
            clientIds: nodes.map(node => node.getAttribute('data-client-id')),
            adopted: nodes.every(
              (node, i) => node === (window as any).__redactServerNodes[i],
            ),
            labels: [
              ...document.querySelectorAll<HTMLLabelElement>(
                '[data-probe$="-label"]',
              ),
            ].every(
              label =>
                label.htmlFor ===
                label.parentElement?.querySelector('input')?.id,
            ),
            row: document.querySelector('[data-probe="row"]')?.parentElement
              ?.tagName,
            circle: document.querySelector('[data-probe="svg"]')?.namespaceURI,
            svgParent:
              document.querySelector('[data-probe="svg"]')?.parentElement
                ?.tagName,
          };
        }, probes);
        expect(after.ids).toEqual(before.ids);
        expect(after.clientIds).toEqual(before.ids);
        expect(after.adopted).toBe(true);
        expect(
          await page.evaluate(async () => {
            const matches = (window as any).$_TSR.router.matches;
            const data = matches
              .map((match: any) => match.l)
              .find((value: any) => value?.slow);
            return Promise.all([data.slow, data.fast, data.row, data.svg]);
          }),
        ).toEqual(['slow', 'fast', 'row', 'svg']);
        expect(after.labels).toBe(true);
        expect(after.row).toBe('TBODY');
        expect(after.circle).toBe('http://www.w3.org/2000/svg');
        expect(after.svgParent).toBe('svg');
        await page.click('[data-testid="mount-id"]');
        await page.waitForSelector('[data-probe="client"]');
        const client = await page.$eval('[data-probe="client"]', element => ({
          id: element.id,
          labelFor: element.parentElement?.querySelector('label')?.htmlFor,
        }));
        expect(client.id).toMatch(/^_modern-js-r_.+_$/);
        expect(client.labelFor).toBe(client.id);
        expect(before.ids).not.toContain(client.id);
        expect(
          await page.evaluate(() => {
            const ids = [...document.querySelectorAll('[id]')].map(
              element => element.id,
            );
            return new Set(ids).size === ids.length;
          }),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        entry.release();
        await navigation;
      }
    });
  });
}
