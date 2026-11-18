#!/usr/bin/env node
// Two-locale native i18n proof, built from workspace source.
//
//   /Users/satan/bin/owned-temp-dir --run i18n-proof -- \
//     node tests/ultramodern-renderers/i18n/proof.mjs [solid|octane ...]
//
// Copies each renderer fixture app (tests/integration/renderer-<r>) into the
// owned temporary directory, adds i18nPlugin() with en/cs translations, builds
// it with the UltraModern CLI, serves it, and checks redirects, Czech SSR,
// hydration without a language flash, client-side language switching, and
// per-request isolation in a headless agent-browser session.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = process.env.OWNED_TEMP_DIR;
assert.ok(temporary, 'Run through owned-temp-dir so the apps have an owner.');
const fixtures = path.join(root, 'tests/integration');
const appTools = path.join(root, 'packages/solutions/ultramodern-app-tools');
const renderers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['solid', 'octane'];
const real = (from, request) =>
  fs.realpath(path.join(from, 'node_modules', request));

// Link the one @solidjs/signals that the installed solid-js resolves; the
// renderer's own declaration must select that same installed copy.
async function solidRuntime(rendererDirectory) {
  const solid = await real(rendererDirectory, 'solid-js');
  const signals = path.dirname(
    await fs.realpath(
      createRequire(path.join(solid, 'package.json')).resolve(
        '@solidjs/signals/package.json',
      ),
    ),
  );
  assert.equal(
    await real(rendererDirectory, '@solidjs/signals'),
    signals,
    'The renderer and solid-js must install one @solidjs/signals',
  );
  return {
    'solid-js': solid,
    '@solidjs/web': await real(rendererDirectory, '@solidjs/web'),
    '@solidjs/signals': signals,
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function linkDependencies(directory, renderer) {
  const rendererDirectory = path.join(
    root,
    `packages/runtime/renderer-${renderer}`,
  );
  const links = {
    '@modern-js/ultramodern-app-tools': appTools,
    [`@modern-js/renderer-${renderer}`]: rendererDirectory,
    '@modern-js/renderer-core': path.join(
      root,
      'packages/runtime/renderer-core',
    ),
    '@modern-js/i18n-runtime-extensions': path.join(
      root,
      'packages/runtime/i18n-extensions',
    ),
    i18next: await real(
      path.join(root, 'packages/runtime/plugin-i18n'),
      'i18next',
    ),
    typescript: await real(appTools, 'typescript'),
    '@types/node': await real(appTools, '@types/node'),
    ...(renderer === 'solid'
      ? await solidRuntime(rendererDirectory)
      : {
          octane: await real(rendererDirectory, 'octane'),
          '@octanejs/tanstack-router': await real(
            rendererDirectory,
            '@octanejs/tanstack-router',
          ),
          '@octanejs/rspack-plugin': await real(
            rendererDirectory,
            '@octanejs/rspack-plugin',
          ),
        }),
  };
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, 'dir');
  }
}

const translations = {
  en: {
    nav: { home: 'Home', about: 'About' },
    switch: 'Switch language',
    about: { title: 'About the native app', body: 'Rendered in English' },
  },
  cs: {
    nav: { home: 'Domů', about: 'O aplikaci' },
    switch: 'Přepnout jazyk',
    about: { title: 'O nativní aplikaci', body: 'Vykresleno česky' },
  },
};

const sources = {
  solid: {
    'src/routes/layout.tsx': `import { Outlet } from '@modern-js/renderer-solid/router';
import { LocalizedLink, useI18n } from '@modern-js/renderer-solid/i18n';
import type { JSX } from '@solidjs/web';
import './index.css';

export default function Layout(): JSX.Element {
  const { t, language, changeLanguage } = useI18n();
  return (
    <main data-testid="native-layout">
      <nav aria-label="Fixture navigation">
        <LocalizedLink to="/">{t('nav.home')}</LocalizedLink>
        <LocalizedLink to="/about">{t('nav.about')}</LocalizedLink>
        <LocalizedLink to="/about" language="cs">Česky</LocalizedLink>
        <button type="button" data-testid="i18n-switch" onClick={() => void changeLanguage(language() === 'cs' ? 'en' : 'cs')}>{t('switch')}</button>
      </nav>
      <output data-testid="i18n-language">{language()}</output>
      <Outlet />
    </main>
  );
}
`,
    'src/routes/about/page.tsx': `import { useI18n } from '@modern-js/renderer-solid/i18n';
import type { JSX } from '@solidjs/web';

export default function About(): JSX.Element {
  const { t } = useI18n();
  return (
    <section data-testid="native-about">
      <h1 data-testid="i18n-title">{t('about.title')}</h1>
      <p data-testid="i18n-body">{t('about.body')}</p>
    </section>
  );
}
`,
  },
  octane: {
    'src/routes/layout.tsx': `import { Outlet } from '@modern-js/renderer-octane/router';
import { LocalizedLink, useI18n } from '@modern-js/renderer-octane/i18n';
import './index.css';

export default function Layout() {
  const { t, language, changeLanguage } = useI18n();
  return (
    <main data-testid="native-layout">
      <nav aria-label="Fixture navigation">
        <LocalizedLink to="/">{t('nav.home')}</LocalizedLink>
        <LocalizedLink to="/about">{t('nav.about')}</LocalizedLink>
        <LocalizedLink to="/about" language="cs">Česky</LocalizedLink>
        <button type="button" data-testid="i18n-switch" onClick={() => void changeLanguage(language === 'cs' ? 'en' : 'cs')}>{t('switch')}</button>
      </nav>
      <output data-testid="i18n-language">{language}</output>
      <Outlet />
    </main>
  );
}
`,
    'src/routes/about/page.tsx': `import { useI18n } from '@modern-js/renderer-octane/i18n';

export default function About() {
  const { t } = useI18n();
  return (
    <section data-testid="native-about">
      <h1 data-testid="i18n-title">{t('about.title')}</h1>
      <p data-testid="i18n-body">{t('about.body')}</p>
    </section>
  );
}
`,
  },
};

async function createApp(renderer) {
  const directory = path.join(temporary, renderer);
  for (const entry of ['src', 'tsconfig.json'])
    await fs.cp(
      path.join(fixtures, `renderer-${renderer}`, entry),
      path.join(directory, entry),
      { recursive: true },
    );
  // The acceptance harness authors these ambient types and typed-route
  // registrations; this standalone copy patches the same spots so the native
  // type checker still runs over the generated i18n entry code.
  for (const [file, from, to] of [
    [
      'src/routes/error.tsx',
      'props.error.message',
      '(props.error as Error).message',
    ],
    [
      'src/routes/page.tsx',
      'search={previous =>',
      'search={(previous: Record<string, unknown>) =>',
    ],
  ]) {
    const target = path.join(directory, file);
    const source = await fs.readFile(target, 'utf8').catch(() => undefined);
    if (source !== undefined)
      await fs.writeFile(target, source.replace(from, to));
  }
  const files = {
    'src/env.d.ts': "declare module '*.css';\n",
    ...sources[renderer],
    'package.json': JSON.stringify({
      name: `i18n-proof-${renderer}`,
      private: true,
      type: 'module',
      dependencies: {
        '@modern-js/ultramodern-app-tools': 'workspace',
        [`@modern-js/renderer-${renderer}`]: 'workspace',
        '@modern-js/renderer-core': 'workspace',
        '@modern-js/i18n-runtime-extensions': 'workspace',
        i18next: '26.4.6',
        ...(renderer === 'solid'
          ? {
              'solid-js': '2.0.0',
              '@solidjs/web': '2.0.0',
              '@solidjs/signals': '2.0.0',
            }
          : {
              octane: 'maintained',
              '@octanejs/tanstack-router': 'maintained',
            }),
      },
    }),
    'modern.config.ts': `import { defineConfig, i18nPlugin } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  renderer: '${renderer}',
  server: { ssr: true },
  plugins: [i18nPlugin({ localeDetection: { languages: ['en', 'cs'], fallbackLanguage: 'en' } })],
});
`,
    'locales/en/translation.json': JSON.stringify(translations.en),
    'locales/cs/translation.json': JSON.stringify(translations.cs),
  };
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await linkDependencies(directory, renderer);
  return directory;
}

async function ultramodern(directory, command) {
  return execute(
    process.execPath,
    [path.join(appTools, 'bin/ultramodern.mjs'), command],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '' },
      maxBuffer: 32 * 1024 * 1024,
    },
  ).catch(error => {
    process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`);
    throw error;
  });
}

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`,
  );
}

const textOf = (html, testId) =>
  new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`, 'u').exec(html)?.[1];

async function proveHttp(url, check) {
  const redirect = async (pathname, headers) => {
    const response = await fetch(`${url}${pathname}`, {
      headers,
      redirect: 'manual',
    });
    return `${response.status} ${response.headers.get('location')}`;
  };
  check.redirectCs = await redirect('/', {
    'accept-language': 'cs-CZ,cs;q=0.9',
  });
  check.redirectEn = await redirect('/about', { 'accept-language': 'en-US' });
  check.redirectCookie = await redirect('/about', {
    'accept-language': 'en',
    cookie: 'i18next=cs',
  });
  assert.equal(check.redirectCs, '302 /cs');
  assert.equal(check.redirectEn, '302 /en/about');
  assert.equal(check.redirectCookie, '302 /cs/about');

  const html = await (await fetch(`${url}/cs/about`)).text();
  check.ssr = {
    lang: /<html[^>]*lang="([^"]+)"/u.exec(html)?.[1],
    title: textOf(html, 'i18n-title'),
    handoff: html.includes('id="__modernjs_i18n_ssr__"'),
    aboutHref: /href="(\/cs\/about)"/u.test(html),
  };
  assert.deepEqual(check.ssr, {
    lang: 'cs',
    title: translations.cs.about.title,
    handoff: true,
    aboutHref: true,
  });

  // Interleaved concurrent requests: each document keeps its own language.
  const requests = Array.from({ length: 24 }, (_, index) =>
    index % 2 ? 'cs' : 'en',
  );
  const documents = await Promise.all(
    requests.map(async language => ({
      language,
      html: await (await fetch(`${url}/${language}/about`)).text(),
    })),
  );
  check.isolation = documents.every(
    ({ language, html }) =>
      textOf(html, 'i18n-title') === translations[language].about.title &&
      html.includes(`lang="${language}"`),
  );
  check.isolationRequests = documents.length;
  assert.ok(check.isolation, 'every concurrent document kept its language');
}

async function proveBrowser(url, renderer, check) {
  const session = `i18n-proof-${renderer}-${process.pid}`;
  // Runs before any page script: records every text the SSR title ever shows
  // and keeps the server-rendered node, so a language flash or a re-created
  // (non-hydrated) title is observable after the fact.
  const initScript = path.join(temporary, `${renderer}-observe-title.js`);
  await fs.writeFile(
    initScript,
    `window.__i18nErrors = [];
addEventListener('error', event => window.__i18nErrors.push(String(event.error?.stack ?? event.message)));
addEventListener('unhandledrejection', event => window.__i18nErrors.push(String(event.reason?.stack ?? event.reason)));
window.__i18nTitleHistory = [];
new MutationObserver(() => {
  const title = document.querySelector('[data-testid="i18n-title"]');
  if (!title) return;
  window.__i18nSsrTitle ??= title;
  const text = title.textContent;
  if (window.__i18nTitleHistory.at(-1) !== text) window.__i18nTitleHistory.push(text);
}).observe(document, { childList: true, subtree: true, characterData: true });
`,
  );
  const browser = async (...args) => {
    const { stdout } = await execute('agent-browser', args, {
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_HEADED: 'false',
        AGENT_BROWSER_INIT_SCRIPTS: initScript,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout.trim();
  };
  const evaluate = async expression => {
    let value = JSON.parse(
      await browser('eval', `JSON.stringify(${expression})`),
    );
    // agent-browser prints the evaluated string as JSON.
    if (typeof value === 'string') value = JSON.parse(value);
    return value;
  };
  try {
    await browser('open', `${url}/cs/about`);
    // Hydrated when the switch button reacts; the title never left Czech.
    await waitFor(
      async () =>
        (await browser('get', 'text', '[data-testid="i18n-title"]')) ===
        translations.cs.about.title,
      'Czech title',
    );
    await browser('eval', 'window.__i18nProofDocument = "original"');
    await browser('wait', '1500');
    // Hydrated once the language switch reacts (checked below); until then
    // the server node must stay in place and only ever show Czech.
    check.hydration = await evaluate(`{
      lang: document.documentElement.lang,
      titleHistory: window.__i18nTitleHistory,
      sameTitleNode: window.__i18nSsrTitle === document.querySelector('[data-testid="i18n-title"]'),
    }`);
    assert.deepEqual(check.hydration, {
      lang: 'cs',
      titleHistory: [translations.cs.about.title],
      sameTitleNode: true,
    });

    // changeLanguage: client-side navigation to the English URL.
    await browser('click', '[data-testid="i18n-switch"]');
    await waitFor(
      async () =>
        (await evaluate('location.pathname')) === '/en/about' &&
        (await browser('get', 'text', '[data-testid="i18n-title"]')) ===
          translations.en.about.title,
      'English after changeLanguage',
    );
    check.changeLanguage = await evaluate(`{
      path: location.pathname,
      title: document.querySelector('[data-testid="i18n-title"]').textContent,
      language: document.querySelector('[data-testid="i18n-language"]').textContent,
      sameDocument: window.__i18nProofDocument === 'original',
      cookie: document.cookie.includes('i18next=en'),
      lang: document.documentElement.lang,
    }`);
    assert.deepEqual(check.changeLanguage, {
      path: '/en/about',
      title: translations.en.about.title,
      language: 'en',
      lang: 'en',
      sameDocument: true,
      cookie: true,
    });

    // LocalizedLink to another language switches and navigates in place.
    await browser('click', 'nav a[hreflang="cs"]');
    await waitFor(
      async () =>
        (await evaluate('location.pathname')) === '/cs/about' &&
        (await browser('get', 'text', '[data-testid="i18n-title"]')) ===
          translations.cs.about.title,
      'Czech after cross-language LocalizedLink',
    );
    // Same-language LocalizedLink: home keeps the Czech prefix.
    check.homeHref = await evaluate(
      `[...document.querySelectorAll('nav a')].map(link => link.getAttribute('href'))`,
    );
    await browser('click', 'nav a[href="/cs"], nav a[href="/cs/"]');
    await waitFor(
      async () =>
        (await evaluate('location.pathname')).replace(/\/$/u, '') === '/cs',
      'Czech home',
    );
    // History back restores /cs/about; history to /en/about re-syncs i18n.
    await browser('back');
    await waitFor(
      async () => (await evaluate('location.pathname')) === '/cs/about',
      'back to Czech about',
    );
    await browser('back');
    await waitFor(
      async () =>
        (await evaluate('location.pathname')) === '/en/about' &&
        (await browser('get', 'text', '[data-testid="i18n-language"]')) ===
          'en',
      'history back re-syncs the language',
    );
    check.navigation = await evaluate(`{
      path: location.pathname,
      title: document.querySelector('[data-testid="i18n-title"]').textContent,
      sameDocument: window.__i18nProofDocument === 'original',
    }`);
    assert.deepEqual(check.navigation, {
      path: '/en/about',
      title: translations.en.about.title,
      sameDocument: true,
    });
    check.pageErrors = await browser('errors');
    assert.ok(
      !/hydrat|mismatch/iu.test(check.pageErrors),
      `no hydration errors: ${check.pageErrors}`,
    );
  } finally {
    if (!check.navigation) {
      check.clientErrors = await evaluate('window.__i18nErrors').catch(String);
      check.console = await browser('console').catch(String);
      check.pageErrors ??= await browser('errors').catch(String);
    }
    await browser('close').catch(() => {});
  }
}

const results = {};
let failed = false;
for (const renderer of renderers) {
  const check = (results[renderer] = {});
  let server;
  let serverLog = '';
  try {
    const directory = await createApp(renderer);
    await ultramodern(directory, 'build');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [path.join(appTools, 'bin/ultramodern.mjs'), 'serve'],
      {
        cwd: directory,
        env: {
          ...process.env,
          NODE_PATH: '',
          PORT: String(port),
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    server.stdout.on('data', chunk => (serverLog += chunk));
    server.stderr.on('data', chunk => (serverLog += chunk));
    await waitFor(
      async () => (await fetch(`${url}/en/about`)).ok,
      `${renderer} server`,
      60_000,
    );
    await proveHttp(url, check);
    if (process.env.I18N_PROOF_HOLD) {
      // Debugging: keep the server up until this process is terminated.
      process.stdout.write(`${JSON.stringify({ url, directory })}\n`);
      await new Promise(resolve => process.once('SIGTERM', resolve));
    }
    await proveBrowser(url, renderer, check);
    check.verdict = 'PASS';
  } catch (error) {
    failed = true;
    check.verdict = 'FAIL';
    check.error = error.stack ?? String(error);
    check.serverLog = serverLog.slice(-4000);
  } finally {
    server?.kill('SIGTERM');
  }
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
