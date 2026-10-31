export type UltramodernSandpackFiles = Readonly<Record<`/${string}`, string>>;

const packageJson = `${JSON.stringify(
  {
    name: 'ultramodern-sandpack-app',
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@12.11.2',
    scripts: {
      dev: 'modern dev',
      start: 'modern dev --host 0.0.0.0',
      build: 'modern build',
    },
    engines: {
      node: '>=26.12.0',
      pnpm: '>=12.11.2',
    },
    dependencies: {
      '@modern-js/i18n-integration':
        'npm:@bleedingdev/modern-js-i18n-integration@latest',
      '@modern-js/runtime-renderer-extensions':
        'npm:@bleedingdev/modern-js-runtime-renderer-extensions@latest',
      '@modern-js/plugin-i18n': 'npm:@bleedingdev/modern-js-plugin-i18n@latest',
      '@modern-js/plugin-tanstack':
        'npm:@bleedingdev/modern-js-plugin-tanstack@latest',
      '@modern-js/runtime': 'npm:@bleedingdev/modern-js-runtime@latest',
      effect: '4.0.7',
      i18next: '26.4.6',
      react: '19.3.1',
      'react-dom': '19.3.1',
    },
    devDependencies: {
      '@effect/tsgo': '0.63.0',
      '@modern-js/ultramodern-app-tools':
        'npm:@bleedingdev/modern-js-ultramodern-app-tools@latest',
      '@modern-js/app-tools': 'npm:@bleedingdev/modern-js-app-tools@latest',
      '@modern-js/tsconfig': 'npm:@bleedingdev/modern-js-tsconfig@latest',
      '@rsbuild/plugin-tailwindcss': '2.0.3',
      '@types/node': '^26.6.5',
      '@types/react': '^19.3.0',
      '@types/react-dom': '^19.3.0',
      tailwindcss: '4.3.3',
      typescript: '7.0.2',
      tsrs: '0.20.1-ts7.1.0-beta',
    },
  },
  null,
  2,
)}\n`;

const codeSandboxTasks = `${JSON.stringify(
  {
    $schema: 'https://codesandbox.io/schemas/tasks.json',
    setupTasks: [
      {
        name: 'Installing dependencies',
        command: 'pnpm install',
      },
    ],
    tasks: {
      start: {
        name: 'UltraModern.js application',
        command: 'pnpm start',
        runAtStart: true,
        preview: {
          port: 8080,
          prLink: 'direct',
        },
      },
    },
  },
  null,
  2,
)}\n`;

const modernConfig = `import { defineConfig } from '@modern-js/app-tools';
import { ultramodernAppTools } from '@modern-js/ultramodern-app-tools';
import { i18nPlugin } from '@modern-js/plugin-i18n';
import { tanstackRouterPlugin } from '@modern-js/plugin-tanstack';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';

export default defineConfig({
  builderPlugins: [pluginTailwindcss()],
  output: {
    disableTsChecker: false,
    polyfill: 'off',
  },
  performance: {
    buildCache: false,
  },
  plugins: [
    ultramodernAppTools(),
    tanstackRouterPlugin(),
    i18nPlugin({
      htmlLangAttr: true,
      localeDetection: {
        fallbackLanguage: 'en',
        languages: ['en', 'cs'],
        localePathRedirect: false,
      },
      reactI18next: false,
    }),
  ],
  server: {
    ssr: false,
  },
});
`;

const runtimeConfig = `import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';

const i18nInstance = createInstance();

export default defineRuntimeConfig({
  i18n: {
    i18nInstance,
    initOptions: {
      defaultNS: 'translation',
      fallbackLng: 'en',
      lng: 'en',
      resources: {
        en: {
          translation: {
            language: 'Language',
            welcome: 'Build a fast, typed UltraModern.js application.',
          },
        },
        cs: {
          translation: {
            language: 'Jazyk',
            welcome: 'Vytvořte rychlou a typově bezpečnou UltraModern.js aplikaci.',
          },
        },
      },
      supportedLngs: ['en', 'cs'],
    },
  },
  router: {
    framework: 'tanstack',
  },
});
`;

const layout = `import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Link, Outlet } from '@modern-js/plugin-tanstack/runtime';

export default function Layout() {
  const { changeLanguage, language, t } = useModernI18n();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="mx-auto flex max-w-4xl items-center justify-between p-6">
        <Link className="font-semibold" prefetch="render" to="/">
          UltraModern.js
        </Link>
        <label className="flex items-center gap-2 text-sm">
          {t('language')}
          <select
            aria-label={t('language')}
            className="rounded bg-slate-800 px-2 py-1"
            onChange={event => void changeLanguage(event.currentTarget.value)}
            value={language}
          >
            <option value="en">English</option>
            <option value="cs">Čeština</option>
          </select>
        </label>
      </header>
      <Outlet />
    </div>
  );
}
`;

const page = `import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Effect, pipe } from 'effect';
import './index.css';

export default function HomePage() {
  const { language, t } = useModernI18n();
  const message = Effect.runSync(
    pipe(
      Effect.succeed(t('welcome')),
      Effect.map(text => \`\${text} [\${language}]\`),
    ),
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-20">
      <p className="text-sm font-medium uppercase tracking-widest text-cyan-300">
        Effect · TanStack Router · Tailwind · i18n
      </p>
      <h1 className="mt-4 text-5xl font-bold tracking-tight">{message}</h1>
      <p className="mt-6 text-slate-300">
        Edit <code>src/routes/page.tsx</code> to get started.
      </p>
    </main>
  );
}
`;

export const ultramodernSandpackFiles: UltramodernSandpackFiles = {
  '/.browserslistrc':
    'chrome >= 144\nedge >= 144\nfirefox >= 147\nsafari >= 27\n',
  '/.codesandbox/environment.json': '{\n  "nodeVersion": "26"\n}\n',
  '/.codesandbox/tasks.json': codeSandboxTasks,
  '/modern.config.ts': modernConfig,
  '/package.json': packageJson,
  '/src/modern-app-env.d.ts':
    '/// <reference types="@modern-js/app-tools/types" />\n',
  '/src/modern.runtime.ts': runtimeConfig,
  '/src/routes/index.css': `@import 'tailwindcss' source(none);
@source '..';

html {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body {
  margin: 0;
}

* {
  box-sizing: border-box;
}
`,
  '/src/routes/layout.tsx': layout,
  '/src/routes/page.tsx': page,
  '/tsconfig.json': `${JSON.stringify(
    {
      extends: '@modern-js/tsconfig/base',
      compilerOptions: {
        jsx: 'react-jsx',
        noUncheckedIndexedAccess: true,
        strict: true,
      },
      include: ['src', 'modern.config.ts'],
    },
    null,
    2,
  )}\n`,
};
