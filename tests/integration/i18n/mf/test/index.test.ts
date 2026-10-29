// Register the cold build in this file so it runs before the browser suite
// against the same fixture, without competing test-file workers.
import './ssr-startup';
import path from 'path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { collectBrowserErrors } from '../../../../utils/browserErrors';
import {
  killApp,
  launchApp,
  launchOptions,
} from '../../../../utils/modernTestUtils';
import {
  acquireTestLock,
  clearI18nTestState,
  conditionalTest,
  waitForText,
} from '../../test-utils';

rstest.setConfig({ testTimeout: 1000 * 60 * 5, hookTimeout: 1000 * 60 * 5 });

async function waitForAppReady(
  port: number,
  pathname = '/en',
  maxRetries = 30,
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}${pathname}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Application on port ${port} did not become ready`);
}

const componentProviderDir = path.resolve(
  __dirname,
  '../mf-component-provider',
);
const appProviderDir = path.resolve(__dirname, '../mf-app-provider');
const consumerDir = path.resolve(__dirname, '../mf-consumer');

const COMPONENT_PROVIDER_PORT = 3006;
const APP_PROVIDER_PORT = 3005;
const CONSUMER_PORT = 3007;
const APP_MF_SSR_ENV = {
  MODERN_MF_APP_SSR: 'true',
  MODERN_FAST_TEST: 'true',
};
const MULTIPLE_RENDERERS_WARNING =
  'Detected multiple renderers concurrently rendering the same context provider.';

function expectNoRendererWarnings(output: string[]) {
  expect(output.join('')).not.toContain(MULTIPLE_RENDERERS_WARNING);
}

async function fetchHtml(port: number, pathname: string) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    headers: {
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  });

  return {
    status: response.status,
    html: await response.text(),
  };
}

describe('mf-i18n-tests', () => {
  let releaseLock: (() => Promise<void>) | undefined;
  let componentProviderApp: unknown;
  let appProviderApp: unknown;
  let componentProviderPage: Page;
  let componentProviderBrowser: Browser;
  let appProviderPage: Page;
  let appProviderBrowser: Browser;
  const componentProviderBrowserErrors: string[] = [];
  const appProviderBrowserErrors: string[] = [];
  const componentProviderOutput: string[] = [];
  const appProviderOutput: string[] = [];

  beforeAll(async () => {
    releaseLock = await acquireTestLock('i18n-mf');
    componentProviderApp = await launchApp(
      componentProviderDir,
      COMPONENT_PROVIDER_PORT,
      {
        onStdout: (message: string) => componentProviderOutput.push(message),
        onStderr: (message: string) => componentProviderOutput.push(message),
      },
    );
    await waitForAppReady(COMPONENT_PROVIDER_PORT, '/mf-manifest.json');

    appProviderApp = await launchApp(
      appProviderDir,
      APP_PROVIDER_PORT,
      {
        onStdout: (message: string) => appProviderOutput.push(message),
        onStderr: (message: string) => appProviderOutput.push(message),
      },
      APP_MF_SSR_ENV,
    );
    await waitForAppReady(APP_PROVIDER_PORT, '/mf-manifest.json');

    componentProviderBrowser = await puppeteer.launch(launchOptions as any);
    componentProviderPage = await componentProviderBrowser.newPage();
    await collectBrowserErrors(
      componentProviderPage,
      componentProviderBrowserErrors,
    );
    await componentProviderPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    appProviderBrowser = await puppeteer.launch(launchOptions as any);
    appProviderPage = await appProviderBrowser.newPage();
    await collectBrowserErrors(appProviderPage, appProviderBrowserErrors);
    await appProviderPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });
  });

  afterAll(async () => {
    if (componentProviderBrowser) {
      await componentProviderBrowser.close();
    }
    if (appProviderBrowser) {
      await appProviderBrowser.close();
    }
    if (componentProviderApp) {
      await killApp(componentProviderApp);
    }
    if (appProviderApp) {
      await killApp(appProviderApp);
    }
    if (releaseLock) {
      await releaseLock();
    }
  });

  describe('mf-component-provider standalone', () => {
    beforeEach(async () => {
      componentProviderBrowserErrors.length = 0;
      await clearI18nTestState(componentProviderPage);
    });

    afterEach(() => {
      expect(componentProviderBrowserErrors).toEqual([]);
      expectNoRendererWarnings(componentProviderOutput);
    });

    conditionalTest('should render home page with i18n correctly', async () => {
      await componentProviderPage.goto(
        `http://localhost:${COMPONENT_PROVIDER_PORT}/en`,
        {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        },
      );
      const root = await componentProviderPage.$('#key');
      const targetText = await componentProviderPage.evaluate(
        el => el?.textContent,
        root,
      );
      expect(targetText?.trim()).toEqual('Hello World(provider)');
    });

    conditionalTest(
      'should render about page with i18n correctly',
      async () => {
        await componentProviderPage.goto(
          `http://localhost:${COMPONENT_PROVIDER_PORT}/en/about`,
          {
            waitUntil: ['networkidle0'],
            timeout: 50000,
          },
        );
        const root = await componentProviderPage.$('#about');
        const targetText = await componentProviderPage.evaluate(
          el => el?.textContent,
          root,
        );
        expect(targetText?.trim()).toEqual('About(provider)');
      },
    );

    conditionalTest('should support zh locale', async () => {
      await componentProviderPage.goto(
        `http://localhost:${COMPONENT_PROVIDER_PORT}/zh`,
        {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        },
      );
      const root = await componentProviderPage.$('#key');
      const targetText = await componentProviderPage.evaluate(
        el => el?.textContent,
        root,
      );
      expect(targetText?.trim()).toEqual('你好，世界(provider)');
    });
  });

  describe('mf-app-provider standalone', () => {
    beforeEach(async () => {
      appProviderBrowserErrors.length = 0;
      await clearI18nTestState(appProviderPage);
    });

    afterEach(() => {
      expect(appProviderBrowserErrors).toEqual([]);
      expectNoRendererWarnings(appProviderOutput);
    });

    conditionalTest('should render home page correctly', async () => {
      await appProviderPage.setCookie({
        name: 'i18next',
        value: 'en',
        domain: 'localhost',
        path: '/',
      });
      await appProviderPage.goto(`http://localhost:${APP_PROVIDER_PORT}`, {
        waitUntil: ['networkidle0'],
        timeout: 50000,
      });
      const body = await appProviderPage.$('body');
      expect(body).toBeTruthy();
    });

    conditionalTest('should render test page with i18n correctly', async () => {
      await appProviderPage.goto(
        `http://localhost:${APP_PROVIDER_PORT}/en/test`,
        {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        },
      );
      const root = await appProviderPage.$('#key');
      const targetText = await appProviderPage.evaluate(
        el => el?.textContent,
        root,
      );
      expect(targetText?.trim()).toEqual('Hello World(provider)');
    });

    conditionalTest('should support zh locale', async () => {
      await appProviderPage.goto(
        `http://localhost:${APP_PROVIDER_PORT}/zh/test`,
        {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        },
      );
      const root = await appProviderPage.$('#key');
      const targetText = await appProviderPage.evaluate(
        el => el?.textContent,
        root,
      );
      expect(targetText?.trim()).toEqual('你好，世界(provider)');
    });

    conditionalTest(
      'should render custom page with i18n correctly',
      async () => {
        await appProviderPage.goto(`http://localhost:${APP_PROVIDER_PORT}`, {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        });
        await appProviderPage.evaluate(() => {
          localStorage.setItem('i18nextLng', 'en');
          localStorage.setItem('i18next', 'en');
        });
        await appProviderPage.goto(
          `http://localhost:${APP_PROVIDER_PORT}/custom`,
          {
            waitUntil: ['networkidle0'],
            timeout: 50000,
          },
        );
        const root = await appProviderPage.$('#key');
        const targetText = await appProviderPage.evaluate(
          el => el?.textContent,
          root,
        );
        expect(targetText?.trim()).toEqual('Hello World(provider-custom)');
      },
    );

    conditionalTest('should support zh locale for custom page', async () => {
      await appProviderPage.setCookie({
        name: 'i18next',
        value: 'zh',
        domain: 'localhost',
        path: '/',
      });
      await appProviderPage.goto(
        `http://localhost:${APP_PROVIDER_PORT}/custom`,
        {
          waitUntil: ['networkidle0'],
          timeout: 50000,
        },
      );
      const root = await appProviderPage.$('#key');
      const targetText = await appProviderPage.evaluate(
        el => el?.textContent,
        root,
      );
      expect(targetText?.trim()).toEqual('你好，世界(provider-custom)');
    });
  });

  describe('mf-consumer with mf-component', () => {
    let consumerApp: unknown;
    let page: Page;
    let browser: Browser;
    const browserErrors: string[] = [];
    const consumerOutput: string[] = [];

    beforeAll(async () => {
      consumerApp = await launchApp(
        consumerDir,
        CONSUMER_PORT,
        {
          onStdout: (message: string) => consumerOutput.push(message),
          onStderr: (message: string) => consumerOutput.push(message),
        },
        APP_MF_SSR_ENV,
      );
      await waitForAppReady(CONSUMER_PORT);

      browser = await puppeteer.launch(launchOptions as any);
      page = await browser.newPage();
      await collectBrowserErrors(page, browserErrors);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });
    });

    beforeEach(async () => {
      browserErrors.length = 0;
      await clearI18nTestState(page);
    });

    afterEach(() => {
      expect(browserErrors).toEqual([]);
      expectNoRendererWarnings(consumerOutput);
      expectNoRendererWarnings(componentProviderOutput);
      expectNoRendererWarnings(appProviderOutput);
    });

    afterAll(async () => {
      if (browser) {
        await browser.close();
      }
      if (consumerApp) {
        await killApp(consumerApp);
      }
    });

    conditionalTest('should load remote component correctly', async () => {
      await page.goto(`http://localhost:${CONSUMER_PORT}/en`, {
        waitUntil: ['networkidle0'],
        timeout: 60000,
      });
      const consumerKey = await page.$('#key');
      const consumerText = await page.evaluate(
        el => el?.textContent,
        consumerKey,
      );
      expect(consumerText?.trim()).toContain('Hello World(consumer)');
      await page.waitForSelector('#about', { timeout: 30000 });
      const remoteComponent = await page.$('#about');
      expect(remoteComponent).toBeTruthy();
      await page.waitForFunction(
        () => {
          const aboutEl = document.querySelector('#about');
          if (!aboutEl) return false;
          const paragraphs = aboutEl.querySelectorAll('p');
          return paragraphs.length >= 2;
        },
        { timeout: 30000 },
      );
      const remoteText2Content = await page.evaluate(() => {
        const aboutEl = document.querySelector('#about');
        if (!aboutEl) return null;
        const paragraphs = aboutEl.querySelectorAll('p');
        if (paragraphs.length >= 2) {
          return paragraphs[1].textContent?.trim() || null;
        }
        return null;
      });
      expect(remoteText2Content).toBeTruthy();
      expect(remoteText2Content?.trim()).toEqual('About(consumer)');
    });

    conditionalTest(
      'should support zh locale with remote component',
      async () => {
        await page.goto(`http://localhost:${CONSUMER_PORT}/zh`, {
          waitUntil: ['networkidle0'],
          timeout: 60000,
        });
        const consumerKey = await page.$('#key');
        const consumerText = await page.evaluate(
          el => el?.textContent,
          consumerKey,
        );
        expect(consumerText?.trim()).toContain('你好，世界(consumer)');
        await page.waitForSelector('#about', { timeout: 30000 });
        await page.waitForFunction(
          () => {
            const aboutEl = document.querySelector('#about');
            if (!aboutEl) return false;
            const paragraphs = aboutEl.querySelectorAll('p');
            return paragraphs.length >= 2;
          },
          { timeout: 30000 },
        );
        const remoteText2Content = await page.evaluate(() => {
          const aboutEl = document.querySelector('#about');
          if (!aboutEl) return null;
          const paragraphs = aboutEl.querySelectorAll('p');
          if (paragraphs.length >= 2) {
            return paragraphs[1].textContent?.trim() || null;
          }
          return null;
        });
        expect(remoteText2Content).toBeTruthy();
        expect(remoteText2Content?.trim()).toEqual('关于(consumer)');
      },
    );
  });

  describe('mf-consumer with mf-app', () => {
    let consumerApp: unknown;
    let page: Page;
    let browser: Browser;
    const browserErrors: string[] = [];
    const consumerOutput: string[] = [];

    beforeAll(async () => {
      consumerApp = await launchApp(
        consumerDir,
        CONSUMER_PORT,
        {
          onStdout: (message: string) => consumerOutput.push(message),
          onStderr: (message: string) => consumerOutput.push(message),
        },
        APP_MF_SSR_ENV,
      );
      await waitForAppReady(CONSUMER_PORT);

      browser = await puppeteer.launch(launchOptions as any);
      page = await browser.newPage();
      await collectBrowserErrors(page, browserErrors);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });
    });

    beforeEach(async () => {
      browserErrors.length = 0;
      await clearI18nTestState(page);
    });

    afterEach(() => {
      expect(browserErrors).toEqual([]);
      expectNoRendererWarnings(consumerOutput);
      expectNoRendererWarnings(componentProviderOutput);
      expectNoRendererWarnings(appProviderOutput);
    });

    afterAll(async () => {
      if (browser) {
        await browser.close();
      }
      if (consumerApp) {
        await killApp(consumerApp);
      }
    });

    conditionalTest('should load remote app correctly', async () => {
      await page.goto(`http://localhost:${CONSUMER_PORT}/en/remote`, {
        waitUntil: ['networkidle0'],
        timeout: 60000,
      });
      await waitForText(page, 'h2', '远程应用页面');
      const body = await page.$('body');
      expect(body).toBeTruthy();
    });

    conditionalTest('should support zh locale with remote app', async () => {
      await page.goto(`http://localhost:${CONSUMER_PORT}/zh/remote`, {
        waitUntil: ['networkidle0'],
        timeout: 60000,
      });
      await waitForText(page, 'h2', '远程应用页面');
    });

    conditionalTest('should load remote-2 app correctly', async () => {
      await page.goto(`http://localhost:${CONSUMER_PORT}/en/remote-2`, {
        waitUntil: ['networkidle0'],
        timeout: 60000,
      });
      await waitForText(page, 'h2', '远程应用页面');
      await page.waitForSelector('#key', { timeout: 30000 });
      const remoteKey = await page.$('#key');
      const remoteText = await page.evaluate(el => el?.textContent, remoteKey);
      expect(remoteText?.trim()).toEqual('Hello World(provider-custom)');
    });

    conditionalTest('should support zh locale with remote-2 app', async () => {
      await page.goto(`http://localhost:${CONSUMER_PORT}/zh/remote-2`, {
        waitUntil: ['networkidle0'],
        timeout: 60000,
      });
      await waitForText(page, 'h2', '远程应用页面');
      await page.waitForSelector('#key', { timeout: 30000 });
      const remoteKey = await page.$('#key');
      const remoteText = await page.evaluate(el => el?.textContent, remoteKey);
      expect(remoteText?.trim()).toEqual('你好，世界(provider-custom)');
    });
  });

  describe('mf-consumer with unavailable app-level remote', () => {
    let consumerApp: unknown;

    beforeAll(async () => {
      consumerApp = await launchApp(
        consumerDir,
        CONSUMER_PORT,
        {},
        APP_MF_SSR_ENV,
      );
      await waitForAppReady(CONSUMER_PORT);
    });

    afterAll(async () => {
      if (consumerApp) {
        await killApp(consumerApp);
      }
    });

    conditionalTest(
      'should fallback to client boundary when app-level remote is unavailable',
      async () => {
        const { status, html } = await fetchHtml(
          CONSUMER_PORT,
          '/en/remote-unavailable',
        );
        expect(status).toBe(200);
        expect(html).toContain('data-mf-app-loading="app-remote-unavailable"');
        // A boundary that fails before the first read is inlined client-rendered
        // (React `<!--$!-->`, Redact `<!--$E1-->`); a later failure streams a
        // `<template>` instruction that switches the pending boundary.
        expect(html).toMatch(/<!--\$[!E]\d*-->|<template/);
        expect(html).toContain('"renderLevel":0');
      },
    );
  });
});
