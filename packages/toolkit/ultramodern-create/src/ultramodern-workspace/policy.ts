import { rpcPath } from './api/rpc';
import {
  appEmitsBrowserUi,
  appHasApi,
  appI18nNamespace,
  createCloudflarePublicUrlEnv,
  createCloudflareWorkerName,
  resolveApiPrefix,
  resolveApiProtocol,
  resolveApiStem,
} from './descriptors';
import { createLocalisedUrlsMap } from './routes';
import type { JsonValue, WorkspaceApp } from './types';
import { isRecord } from './types';
import {
  BRACES_FORK_VERSION,
  CLOUDFLARE_COMPATIBILITY_DATE,
  COMPILER_RELEASE_AGE_EXCEPTIONS,
  EFFECT_VERSION,
  NODE_VERSION,
  PNPM_VERSION,
  SHARP_VERSION,
  ULTRAMODERN_PACKAGE_PINS,
} from './versions';

function createCloudflareProofRoute(app: WorkspaceApp): JsonValue {
  if (app.kind === 'shell') {
    return {
      ssr: '/en',
      mfManifest: '/mf-manifest.json',
      locale: `/locales/en/${appI18nNamespace(app)}.json`,
    };
  }

  const languageRoutes = createLocalisedUrlsMap(app);
  const firstCanonicalPath = Object.keys(languageRoutes)[0];
  const localizedPath =
    firstCanonicalPath && isRecord(languageRoutes[firstCanonicalPath])
      ? (languageRoutes[firstCanonicalPath].en as string | undefined)
      : undefined;

  return {
    ...(appEmitsBrowserUi(app)
      ? {
          ssr: localizedPath ?? '/en',
          mfManifest: '/mf-manifest.json',
          locale: `/locales/en/${appI18nNamespace(app)}.json`,
        }
      : {}),
    ...(appHasApi(app)
      ? resolveApiProtocol(app) === 'rpc'
        ? { rpc: rpcPath(app) }
        : {
            apiReadiness: `${resolveApiPrefix(app)}/${resolveApiStem(app)}/readiness`,
          }
      : {}),
  };
}

function createApiSmokeCheck(app: WorkspaceApp): JsonValue {
  const stem = resolveApiStem(app);
  if (resolveApiProtocol(app) === 'rpc') {
    const id = `${app.id}-cloudflare-proof`;
    return {
      id: `${app.id}-rpc-smoke`,
      method: 'POST',
      route: rpcPath(app),
      body: { jsonrpc: '2.0', id, method: 'list', params: { limit: 1 } },
      expect: { id, 'result.items.0.id': `starter-${stem}` },
    };
  }
  return {
    id: `${app.id}-readiness-smoke`,
    route: `${resolveApiPrefix(app)}/${stem}/readiness`,
    expect: {
      status: 'ready',
      'checks.api': 'ready',
      'checks.moduleFederation': 'ready',
      'checks.ssr': 'ready',
    },
  };
}

export function createCloudflareSecurityContract(): JsonValue {
  return {
    enabled: true,
    headers: {
      referrerPolicy: 'strict-origin-when-cross-origin',
      contentTypeOptions: 'nosniff',
      permissionsPolicy:
        'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    },
    contentSecurityPolicy: {
      mode: 'report-only',
      directives: {
        'base-uri': [`'self'`],
        'connect-src': [`'self'`, 'https:', 'http:', 'wss:', 'ws:'],
        'default-src': [`'self'`],
        'font-src': [`'self'`, 'data:', 'https:', 'http:'],
        'form-action': [`'self'`],
        'frame-ancestors': [`'self'`],
        'img-src': [`'self'`, 'data:', 'blob:', 'https:', 'http:'],
        'manifest-src': [`'self'`, 'https:', 'http:'],
        'object-src': [`'none'`],
        'script-src': [
          `'self'`,
          `'unsafe-inline'`,
          `'unsafe-eval'`,
          'https:',
          'http:',
          'blob:',
        ],
        'style-src': [`'self'`, `'unsafe-inline'`, 'https:', 'http:'],
        'worker-src': [`'self'`, 'blob:'],
      },
      reason:
        'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.',
    },
    noindex: {
      workersDev: true,
      localhost: true,
      previewHostnames: [],
    },
    // No `cookies` block: deploy.worker.security.cookies is a deprecated
    // no-op (the worker never owned Set-Cookie); CORS defaults are correct
    // for federated workspaces (assets wildcard, BFF/SSR same-origin).
  };
}

const PUBLIC_WEBSITE_POLICY = {
  qualityGates: {
    publicRoutes: {
      requireSitemapWhenPresent: true,
      requireRobotsSitemapConsistency: true,
      requireWebManifestWhenPresent: true,
    },
    statusCodes: {
      notFoundRoute: '/__ultramodern-smoke-missing/nope',
      unknownRouteStatus: 404,
    },
    indexing: {
      previewNoindex: true,
      productionPublicRoutesIndexable: true,
    },
    assets: {
      cssPreloadRequired: true,
      cssResponseRequired: true,
      cacheControlRequiredForCss: true,
      sourcemapsPubliclyReferenced: false,
    },
    budgets: {
      ssrHtmlMaxBytes: 250_000,
      mfManifestMaxBytes: 500_000,
      localeJsonMaxBytes: 100_000,
      sitemapXmlMaxBytes: 500_000,
      cssAssetMaxBytes: 750_000,
    },
    csp: {
      finalMode: 'report-only-dogfood',
      decision:
        'Report-only remains the generated final mode until public smoke proof records MF SSR script/style/connect compatibility for the deployed surface.',
    },
  },
  publicHead: {
    indexableRobots: 'index, follow',
    privateRouteRobots: 'noindex, nofollow',
  },
  publicSurface: {
    defaultProviderFile: 'route.sitemap.mjs',
    draftPolicy: 'omit-draft-by-default',
    indexablePolicy: 'omit-indexable-false',
  },
};

function createPublicWebsiteQualityGateContract(): JsonValue {
  return PUBLIC_WEBSITE_POLICY.qualityGates;
}

export function createPublicHeadRobotsPolicy() {
  return PUBLIC_WEBSITE_POLICY.publicHead;
}

export function createPublicSurfaceContentExpansionPolicy() {
  return PUBLIC_WEBSITE_POLICY.publicSurface;
}

export function createCloudflareDeployContract(
  scope: string,
  app: WorkspaceApp,
): JsonValue {
  return {
    target: 'cloudflare',
    workerName: createCloudflareWorkerName(scope, app),
    publicUrlEnv: createCloudflarePublicUrlEnv(app),
    compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
    // Required so a deployed Worker's `request.signal` actually fires on
    // client disconnect (see CLOUDFLARE_REQUIRED_COMPATIBILITY_FLAGS in
    // app-tools-extensions/src/cloudflare-output-contract.ts, the generator's
    // own output verifier).
    compatibilityFlags: [
      'nodejs_compat',
      'global_fetch_strictly_public',
      'enable_request_signal',
    ],
    assetsBinding: 'ASSETS',
    routes: createCloudflareProofRoute(app),
    security: createCloudflareSecurityContract(),
    qualityGates: createPublicWebsiteQualityGateContract(),
    // Exercise the actual public protocol rather than treating generated files
    // as proof that the worker route is callable.
    ...(app.api
      ? {
          jsonSmokeChecks: [createApiSmokeCheck(app)],
        }
      : {}),
  };
}

export const ULTRAMODERN_WORKSPACE_POLICY = {
  schemaVersion: 1,
  dependencies: ULTRAMODERN_PACKAGE_PINS,
  toolchain: {
    node: {
      version: NODE_VERSION,
      engineRange: '>=26',
    },
    packageManager: {
      name: 'pnpm',
      version: PNPM_VERSION,
      engineRange: '>=12',
    },
  },
  pnpm: {
    // Published native dependency edges do not inherit repository overrides.
    // Apply the fixes to every vulnerable edge in generated workspaces.
    overrides: {
      'braces@>=3.0.0 <3.0.4': `npm:@bleedingdev/braces@${BRACES_FORK_VERSION}`,
      'sharp@>=0.35.0 <0.35.5': SHARP_VERSION,
      'undici@>=7.0.0 <7.30.1': '7.30.1',
      'undici@>=8.0.0 <8.12.2': '8.12.2',
      'body-parser@>=2.0.0 <2.4.0': '2.4.0',
      'dompurify@>=3.0.0 <3.4.17': '3.4.17',
    },
    minimumReleaseAge: 1440,
    minimumReleaseAgeExclude: COMPILER_RELEASE_AGE_EXCEPTIONS,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
    blockExoticSubdeps: true,
    engineStrict: true,
    pmOnFail: 'error',
    verifyDepsBeforeRun: 'error',
    strictDepBuilds: true,
    peerDependencyRules: {
      allowedVersions: {
        react: '>=19.0.0',
        '@effect/vitest>effect': EFFECT_VERSION,
      },
    },
    allowBuilds: {
      '@parcel/watcher': true,
      '@swc/core': true,
      'core-js': true,
      esbuild: true,
      lefthook: true,
      sharp: true,
      workerd: true,
    },
  },
} as const;
