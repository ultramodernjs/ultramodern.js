import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installPackedGenerator } from '../../../utils/generatedWorkspaceDependencies';
import { generatorTestTempParent } from '../../../utils/generatorTestTemp.mjs';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';

setSuiteTimeout(600_000);

const repoRoot = path.resolve(__dirname, '../../../../');
let createBin: string;
const testFrameworkVersion = '3.2.0-ultramodern.108';
const frameworkVersionEnv = 'ULTRAMODERN_CREATE_FRAMEWORK_VERSION';
type ExecSyncError = Error & {
  stderr?: Buffer | string;
};

function runCreate(projectDir: string, args: string[], bin = createBin) {
  const packageSourceArgs =
    bin === createBin ? ['--ultramodern-package-source', 'workspace'] : [];
  execFileSync(
    process.execPath,
    [bin, projectDir, ...packageSourceArgs, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_PATH: '',
        [frameworkVersionEnv]: testFrameworkVersion,
        FORCE_COLOR: '0',
      },
      stdio: 'pipe',
    },
  );
}

function captureCreateFailure(
  projectDir: string,
  args: string[],
  bin = createBin,
) {
  try {
    runCreate(projectDir, args, bin);
  } catch (error) {
    const stderr = (error as ExecSyncError).stderr;
    return typeof stderr === 'string' ? stderr : stderr?.toString() || '';
  }
  throw new Error(`Expected create to reject: ${args.join(' ')}`);
}

function readText(root: string, relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), 'utf-8');
}

function readJson<T = any>(root: string, relativePath: string): T {
  return JSON.parse(readText(root, relativePath));
}

function writeText(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function expectNoPath(root: string, relativePath: string) {
  expect(fs.existsSync(path.join(root, relativePath))).toBe(false);
}

describe('create-ultramodern-workspace', () => {
  let tempRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(
      path.join(
        generatorTestTempParent(repoRoot),
        'modern-create-ultramodern-workspace-',
      ),
    );
    console.log(`create-ultramodern-workspace scratch directory: ${tempRoot}`);
    createBin = installPackedGenerator(tempRoot);
  });

  afterAll(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects install-backed package source from a local source checkout', () => {
    const workspaceDir = path.join(tempRoot, 'ultra-install-workspace');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    const stderr = captureCreateFailure(
      workspaceDir,
      [
        '--ultramodern-package-source',
        'install',
        '--ultramodern-package-version',
        '3.2.0-ultramodern.0',
        '--ultramodern-package-registry',
        'https://registry.example.test/',
        '--lang',
        'en',
      ],
      path.join(repoRoot, 'packages/toolkit/ultramodern-create/bin/run.js'),
    );

    expect(stderr).toContain(
      'local @modern-js/ultramodern-create source checkout cannot satisfy an explicit install',
    );
    expectNoPath(tempRoot, 'ultra-install-workspace');
  });

  test('generates public surface assets from route-owned content sources', () => {
    const workspaceDir = path.join(tempRoot, 'ultra-public-content-workspace');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    runCreate(workspaceDir, ['--lang', 'en']);

    const topology = readJson<Record<string, any>>(
      workspaceDir,
      'topology/reference-topology.json',
    );
    const shellApp = topology.shell;
    expect(shellApp.id).toBe('shell-super-app');
    shellApp.routes = {
      ...(shellApp.routes ?? {}),
      publicSurface: {
        artifactLifecycle: 'build-and-deploy-output',
        authoring: 'colocated-route-meta',
        cloudflareOutputRoot: 'dist-cloudflare/public',
        concreteUrlPaths: [],
        contentExpansion: {
          authoring: 'route-owned-esm-provider',
          defaultProviderFile: 'route.sitemap.mjs',
          draftPolicy: 'omit-draft-by-default',
          entryExport: 'default-or-entries',
          indexablePolicy: 'omit-indexable-false',
          lifecycle: 'executed-during-public-surface-generation',
          paramsSource: 'params-or-localeParams',
        },
        contentSources: [
          {
            entryExport: 'default-or-entries',
            module: 'src/routes/[lang]/talks/[slug]/route.sitemap.mjs',
            routeId: 'talk-detail',
          },
        ],
        files: ['robots.txt', 'sitemap.xml', 'site.webmanifest'],
        generatedManifest: './src/routes/ultramodern-route-metadata',
        generator: 'scripts/generate-public-surface-assets.mts',
        languages: ['en', 'cs'],
        metadataExport: './src/routes/ultramodern-route-metadata',
        omittedByDefault: ['api-catalog.json', 'llms.txt', 'security.txt'],
        outputRoot: 'dist/public',
        privateRoutePolicy: 'omit-from-generated-public-surface',
        publicRoutes: [
          {
            canonicalPath: '/talks/:slug',
            descriptionKey: 'shell.talks.detail.meta.description',
            id: 'talk-detail',
            localisedPaths: {
              en: '/talks/:slug',
              cs: '/prednasky/:slug',
            },
            namespace: 'shell',
            ownerAppId: 'shell-super-app',
            titleKey: 'shell.talks.detail.title',
          },
          {
            canonicalPath: '/sessions/:slug',
            descriptionKey: 'shell.sessions.detail.meta.description',
            id: 'session-detail',
            localisedPaths: {
              en: '/sessions/:slug',
              cs: '/sezeni/:slug',
            },
            namespace: 'shell',
            ownerAppId: 'shell-super-app',
            titleKey: 'shell.sessions.detail.title',
          },
          {
            canonicalPath: '/optional/:slug?',
            descriptionKey: 'shell.optional.detail.meta.description',
            id: 'optional-detail',
            localisedPaths: {
              en: '/optional/:slug?',
              cs: '/volitelne/:slug?',
            },
            namespace: 'shell',
            ownerAppId: 'shell-super-app',
            titleKey: 'shell.optional.detail.title',
          },
        ],
        routeEntries: [],
        source: 'route-owned-public-routes',
      },
    };
    writeText(
      workspaceDir,
      'topology/reference-topology.json',
      JSON.stringify(topology, null, 2) + '\n',
    );

    writeText(
      workspaceDir,
      'apps/shell-super-app/src/routes/[lang]/talks/[slug]/route.sitemap.mjs',
      `/** @type {import('@ultra-public-content-workspace/shared-contracts').UltramodernPublicSitemapEntry[]} */
export const entries = [
  {
    params: { slug: 'building-public-web' },
    localeParams: { cs: { slug: 'verejny-web' } },
    lastModified: '2026-06-10',
    changeFrequency: 'monthly',
    priority: 0.7,
  },
  {
    params: { slug: 'draft-talk' },
    draft: true,
  },
  {
    params: { slug: 'noindex-talk' },
    indexable: false,
  },
];
`,
    );
    writeText(
      workspaceDir,
      'apps/shell-super-app/src/routes/[lang]/sessions/[slug]/route.sitemap.mjs',
      `export default function loadSessionEntries(context) {
  if (context.appId !== 'shell-super-app') {
    throw new Error('Unexpected appId ' + context.appId);
  }
  if (context.routeId !== 'session-detail') {
    throw new Error('Unexpected routeId ' + context.routeId);
  }
  if (!Array.isArray(context.languages) || context.languages.join(',') !== 'en,cs') {
    throw new Error('Unexpected languages ' + context.languages);
  }
  return [
    {
      params: { slug: 'provider-loader' },
      localeParams: { cs: { slug: 'nacist-poskytovatele' } },
      lastModified: '2026-06-11',
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
`,
    );
    writeText(
      workspaceDir,
      'apps/shell-super-app/src/routes/[lang]/optional/[slug$]/route.sitemap.mjs',
      `export const entries = [
  {
    params: { slug: 'route-owned-optional' },
    localeParams: { cs: { slug: 'volitelny-segment' } },
  },
];
`,
    );

    execFileSync(
      process.execPath,
      [
        createBin,
        'ultramodern',
        'public-surface',
        '--app',
        'shell-super-app',
        '--target',
        'dist',
        '--require-public-origin',
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          NODE_PATH: '',
          ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: 'https://example.com',
        },
        stdio: 'pipe',
      },
    );

    const sitemap = readText(
      workspaceDir,
      'apps/shell-super-app/dist/public/sitemap.xml',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/en/talks/building-public-web</loc>',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/cs/prednasky/verejny-web</loc>',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/en/sessions/provider-loader</loc>',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/cs/sezeni/nacist-poskytovatele</loc>',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/en/optional/route-owned-optional</loc>',
    );
    expect(sitemap).toContain(
      '<loc>https://example.com/cs/volitelne/volitelny-segment</loc>',
    );
    expect(sitemap).toContain('hreflang="x-default"');
    expect(sitemap).toContain('<lastmod>2026-06-10</lastmod>');
    expect(sitemap).toContain('<lastmod>2026-06-11</lastmod>');
    expect(sitemap).toContain('<changefreq>monthly</changefreq>');
    expect(sitemap).toContain('<changefreq>weekly</changefreq>');
    expect(sitemap).toContain('<priority>0.7</priority>');
    expect(sitemap).toContain('<priority>1</priority>');
    expect(sitemap).not.toContain('draft-talk');
    expect(sitemap).not.toContain('noindex-talk');

    const robots = readText(
      workspaceDir,
      'apps/shell-super-app/dist/public/robots.txt',
    );
    expect(robots).toContain('Allow: /en/talks/building-public-web$');
    expect(robots).toContain('Allow: /cs/prednasky/verejny-web$');
    expect(robots).toContain('Allow: /en/sessions/provider-loader$');
    expect(robots).toContain('Allow: /cs/sezeni/nacist-poskytovatele$');
    expect(robots).toContain('Allow: /en/optional/route-owned-optional$');
    expect(robots).toContain('Allow: /cs/volitelne/volitelny-segment$');
    expect(robots).toContain('Sitemap: https://example.com/sitemap.xml');

    const webManifest = readJson(
      workspaceDir,
      'apps/shell-super-app/dist/public/site.webmanifest',
    );
    expect(webManifest.scope).toBe('/');
    expect(webManifest.start_url).toMatch(/^\/(cs|en)\//u);

    // Site-wide MODERN_PUBLIC_SITE_URL must win over per-app ULTRAMODERN_PUBLIC_URL_*
    // for SEO output (sitemap/robots origins), regardless of per-app env being set.
    execFileSync(
      process.execPath,
      [
        createBin,
        'ultramodern',
        'public-surface',
        '--app',
        'shell-super-app',
        '--target',
        'cloudflare-dist',
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          NODE_PATH: '',
          MODERN_PUBLIC_SITE_URL: 'https://global.example/path-is-ignored',
          ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP:
            'https://per-app.example.workers.dev',
        },
        stdio: 'pipe',
      },
    );
    const cloudflareSitemap = readText(
      workspaceDir,
      'apps/shell-super-app/dist-cloudflare/public/sitemap.xml',
    );
    expect(cloudflareSitemap).toContain(
      '<loc>https://global.example/en/sessions/provider-loader</loc>',
    );
    const cloudflareRobots = readText(
      workspaceDir,
      'apps/shell-super-app/dist-cloudflare/public/robots.txt',
    );
    expect(cloudflareRobots).toContain(
      'Sitemap: https://global.example/sitemap.xml',
    );
  });
});
