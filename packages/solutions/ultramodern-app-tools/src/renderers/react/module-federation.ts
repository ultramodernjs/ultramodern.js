import { createRequire } from 'node:module';
import {
  type RendererFederationCompatibility,
  readRendererFederationCompatibility,
  rendererFederationError,
} from '@modern-js/federation-runtime/renderer-contract';
import {
  type ReactRuntimeConfig,
  usesRedact,
} from '../../native-composition/redact-config';
import { readRendererFrameworkPackage } from '../../native-composition/renderer-installed-profile';
import { resolveRendererProfileMetadata } from '../../native-composition/renderer-profile';
import {
  REDACT_ALIASES,
  resolveRedactAliases,
} from './redact-integration-plugin';

export function resolveReactFederationCompatibility(
  config: ReactRuntimeConfig = {},
  require = createRequire(import.meta.url),
): RendererFederationCompatibility {
  const metadata = resolveRendererProfileMetadata('react');
  const redacted = usesRedact(config);
  const runtimeRequire = redacted
    ? require
    : createRequire(require.resolve('@modern-js/runtime/cli'));
  const specifier = redacted ? '@tanstack/redact' : 'react';
  const runtime = readRendererFrameworkPackage({
    specifier,
    filename: runtimeRequire.resolve(specifier),
  });
  // Aliases select the public Redact runtime even when its physical npm owner
  // is @bleedingdev/tanstack-redact. Keep the installed version, but describe
  // the identity shared by the integration's React and direct Redact imports.
  const effectiveRuntime = {
    name: redacted ? specifier : runtime.name,
    version: runtime.version,
  };
  const bootstrap = metadata.frameworkPackages.find(
    owner => owner.specifier === '@modern-js/runtime',
  );
  if (!bootstrap)
    throw rendererFederationError(
      'the installed React bootstrap owner is absent.',
    );
  const { renderer, protocolVersion, compiler, hydration, router } =
    metadata.profile;
  return readRendererFederationCompatibility({
    // Profile pins describe the selectable React API/compiler. Federation must
    // describe the effective runtime instead, including real React opt-out/RSC.
    profile: {
      renderer,
      protocolVersion,
      compiler,
      hydration: redacted ? effectiveRuntime : hydration,
      router,
    },
    runtime: effectiveRuntime,
    bootstrap: { name: bootstrap.name, version: bootstrap.version },
  });
}

/** Redact keeps React's share keys, so hosts that govern `react`, `react-dom`
 * and JSX singletons see one entry each. Each key carries Redact's own version
 * with strict matching: a real React container (or another Redact version)
 * fails the version check, and the manifest contract rejects mixed runtimes
 * before remote init. Direct `@tanstack/redact*` imports consume the same
 * singleton as their first React spelling.
 */
export function withReactRuntimeShared(
  shared: unknown,
  compatibility: RendererFederationCompatibility,
  require = createRequire(import.meta.url),
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of Array.isArray(shared) ? shared : [shared]) {
    if (typeof entry === 'string') result[entry] = {};
    else if (entry && typeof entry === 'object') Object.assign(result, entry);
  }
  const redacted = compatibility.runtime.name === '@tanstack/redact';
  const aliases = redacted ? resolveRedactAliases(require) : {};
  const reactSpelling = new Map<string, string>();
  for (const [request, target] of Object.entries(REDACT_ALIASES))
    if (!reactSpelling.has(target)) reactSpelling.set(target, request);
  const requests = redacted
    ? Object.keys(aliases).map(key => key.slice(0, -1))
    : [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ];
  for (const request of requests) {
    const shareKey = redacted
      ? (reactSpelling.get(
          REDACT_ALIASES[request as keyof typeof REDACT_ALIASES] ?? request,
        ) ?? request)
      : request;
    const version =
      !redacted && request.startsWith('react-dom')
        ? compatibility.profile.hydration.version
        : compatibility.runtime.version;
    const previous = result[request];
    if (
      previous &&
      typeof previous === 'object' &&
      'shareKey' in previous &&
      previous.shareKey !== request &&
      previous.shareKey !== shareKey
    ) {
      throw rendererFederationError(
        `conflicting runtime shareKey for ${request}; React and Redact containers cannot mix.`,
      );
    }
    result[request] = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...(redacted
        ? {
            import: aliases[`${request}$`],
            shareKey,
          }
        : {}),
      version,
      requiredVersion: version,
      strictVersion: true,
      singleton: true,
      treeShaking: false,
    };
  }
  return result;
}
