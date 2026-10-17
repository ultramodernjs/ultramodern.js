import { isIPv6 } from 'node:net';
import type { RsbuildContext } from '@rsbuild/core';

const invalid = (message: string): Error =>
  new Error(`Native Module Federation: ${message}`);

/**
 * A dev remote must publish its own origin, rather than the consuming host's.
 * Rsbuild resolves its live address before creating compiler configuration.
 */
export function resolveNativeFederationDevPublicPath(
  publicPath: string,
  devServer: RsbuildContext['devServer'],
  assetPrefix?: string | boolean,
): string {
  if (!publicPath || publicPath === 'auto')
    throw invalid('development containers require a resolved publicPath.');
  if (
    !devServer ||
    !Number.isInteger(devServer.port) ||
    devServer.port < 1 ||
    devServer.port > 65535
  )
    throw invalid(
      'development containers require the resolved dev server address.',
    );

  const protocol = devServer.https ? 'https:' : 'http:';
  const hostname = devServer.hostname || 'localhost';
  const host =
    hostname === '0.0.0.0' || hostname === 'localhost'
      ? 'localhost'
      : hostname === '::'
        ? '[::1]'
        : isIPv6(hostname)
          ? `[${hostname}]`
          : hostname;
  const origin = `${protocol}//${host}:${devServer.port}`;
  let prefix = publicPath;
  if (assetPrefix === true) {
    // Rsbuild's boolean prefix currently omits IPv6 brackets. Repair only its
    // generated address, preserving server.base and any explicit compiler URL.
    const generatedHost = hostname === '0.0.0.0' ? 'localhost' : hostname;
    const generatedOrigin = `${protocol}//${generatedHost}:${devServer.port}`;
    if (
      publicPath === generatedOrigin ||
      publicPath.startsWith(`${generatedOrigin}/`)
    )
      prefix = origin + publicPath.slice(generatedOrigin.length);
  }
  let url: URL;
  try {
    url = new URL(prefix, `${origin}/`);
  } catch (error) {
    throw Object.assign(
      invalid('development publicPath must be a valid URL or path prefix.'),
      { cause: error },
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw invalid('development publicPath must use HTTP or HTTPS.');
  // Absolute authored prefixes already passed through Rsbuild's formatting.
  return /^https?:\/\//u.test(prefix) ? prefix : url.href;
}

const graphDirectory = '__ultramodern_mf__';

/** Rspack owns the hash and its runtime getter; no emitted JS is rewritten. */
export function nativeFederationDevGraphPublicPath(
  publicPath: string,
  fullHash?: string,
): string {
  const prefix = new URL(publicPath);
  if (
    !['http:', 'https:'].includes(prefix.protocol) ||
    prefix.username ||
    prefix.password ||
    prefix.search ||
    prefix.hash
  )
    throw invalid('completed graphs require a safe HTTP publicPath.');
  if (fullHash !== undefined && !/^[a-f0-9]+$/iu.test(fullHash))
    throw invalid('completed graphs require the compiler full hash.');
  if (!prefix.pathname.endsWith('/')) prefix.pathname += '/';
  return `${prefix.href}${graphDirectory}/${fullHash === undefined ? '' : `${fullHash}/`}`;
}

/** Native HMR deltas belong to the live compiler, never a frozen graph. */
export function nativeFederationDevHotUpdateTarget(
  publicPath: string,
  target: string,
  origin: string,
): string | undefined {
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('#')
  )
    return;
  const pathname = target.split('?')[0];
  const url = URL.parse(target, origin);
  const prefix = new URL(nativeFederationDevGraphPublicPath(publicPath));
  if (
    !url ||
    url.pathname !== pathname ||
    url.origin !== prefix.origin ||
    !url.pathname.startsWith(prefix.pathname)
  )
    return;
  const relative = url.pathname.slice(prefix.pathname.length);
  const match =
    /^[a-f0-9]+\/(.+\.hot-update\.(?:json(?:\.mjs)?|[cm]?js))$/iu.exec(
      relative,
    );
  if (!match) return;
  try {
    if (
      match[1].split('/').some(segment => {
        const decoded = decodeURIComponent(segment);
        return (
          !decoded ||
          decoded === '.' ||
          decoded === '..' ||
          /[\\/\0]/u.test(decoded)
        );
      })
    )
      return;
  } catch {
    return;
  }
  return `${new URL(match[1], publicPath.endsWith('/') ? publicPath : `${publicPath}/`).pathname}${url.search}`;
}
