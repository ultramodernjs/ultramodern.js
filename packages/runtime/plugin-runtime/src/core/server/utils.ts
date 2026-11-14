// @effect-diagnostics processEnv:off strictBooleanExpressions:off

import type { StaticHandlerContext } from '@modern-js/runtime-utils/router';
import type { ServerUserConfig } from '@modern-js/server-core';
import { isRouteErrorResponse } from '../../router/runtime/routerHelper';
import type { SSRConfig } from './shared';

export function attributesToString(attributes: Record<string, any>) {
  // Iterate through the properties and convert them into a string, only including properties that are not undefined.
  return Object.entries(attributes).reduce(
    (str, [key, value]) =>
      value === undefined || !/^[^\u0000-\u0020"'<>/=]+$/u.test(key)
        ? str
        : `${str} ${key}="${String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')}"`,
    '',
  );
}

/**
 * @param source
 * @param searchValue
 * @param replaceValue
 * @returns
 */
export function safeReplace(
  source: string,
  searchValue: string | RegExp,
  replaceValue: string,
) {
  return source.replace(searchValue, () => replaceValue);
}

export function checkIsNode(): boolean {
  return typeof process !== 'undefined' && process.release?.name === 'node';
}

// Holds each inlined build output once, so its size is bounded by the build.
const assetCache = new Map<string, Promise<string>>();

/**
 * Read a build output file (e.g. an inlined css / js chunk) by its absolute path.
 * Inlining only applies in production, where build outputs don't change at
 * runtime, so the content is cached. Failed reads are not cached.
 */
export function readAssetWithCache(filepath: string): Promise<string> {
  const cached = assetCache.get(filepath);
  if (cached) {
    return cached;
  }

  const content = import('fs/promises').then(fs =>
    fs.readFile(filepath, 'utf-8'),
  );
  assetCache.set(filepath, content);
  // Only drops the failed entry, callers still receive the rejection.
  content.catch(() => {
    if (assetCache.get(filepath) === content) {
      assetCache.delete(filepath);
    }
  });
  return content;
}

/**
 * forked from https://github.com/remix-run/remix/blob/main/packages/remix-server-runtime/errors.ts
 * license at https://github.com/remix-run/remix/blob/main/LICENSE.md
 */
export function serializeErrors(
  errors: StaticHandlerContext['errors'],
): StaticHandlerContext['errors'] {
  if (!errors) {
    return null;
  }
  const entries = Object.entries(errors);
  const serialized: StaticHandlerContext['errors'] = {};
  for (const [key, val] of entries) {
    // Hey you!  If you change this, please change the corresponding logic in
    // deserializeErrors
    if (isRouteErrorResponse(val)) {
      serialized[key] = serializeRouteErrorResponse(val);
    } else if (val instanceof Error) {
      serialized[key] = serializeError(val);
    } else {
      serialized[key] = val;
    }
  }
  return serialized;
}

export function shouldRedactServerError() {
  return (
    process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'
  );
}

function serializeError(error: Error) {
  if (shouldRedactServerError()) {
    return {
      message: 'Unexpected Server Error',
      stack: undefined,
      __type: 'Error',
    };
  }

  return {
    message: error.message,
    stack: error.stack,
    __type: 'Error',
  };
}

function serializeRouteErrorResponse(error: unknown) {
  if (!isRouteErrorResponse(error)) {
    return error;
  }

  if (error.status >= 500 && shouldRedactServerError()) {
    return {
      status: error.status,
      statusText: 'Internal Server Error',
      data: 'Unexpected Server Error',
      internal: error.internal,
      __type: 'RouteErrorResponse',
    };
  }

  return {
    status: error.status,
    statusText: error.statusText,
    data: error.data,
    internal: error.internal,
    __type: 'RouteErrorResponse',
  };
}

export function getSSRConfigByEntry(
  entryName: string,
  ssr?: ServerUserConfig['ssr'],
  ssrByEntries?: ServerUserConfig['ssrByEntries'],
) {
  if (ssrByEntries?.[entryName]) {
    return ssrByEntries[entryName];
  }

  return ssr || true;
}

export function getSSRMode(ssrConfig?: SSRConfig): 'string' | 'stream' | false {
  if (typeof ssrConfig === 'boolean') {
    const result = ssrConfig ? 'stream' : false;
    return result;
  }

  const result = ssrConfig?.mode === 'string' ? 'string' : 'stream';
  return result;
}

const getLinkAttributes = (linkTag: string) => {
  const attributes = new Map<string, string>();
  const attributeRegExp =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attributeRegExp.exec(linkTag))) {
    const [, name, doubleQuotedValue, singleQuotedValue, unquotedValue] = match;
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'link' || attributes.has(normalizedName)) {
      continue;
    }
    attributes.set(
      normalizedName,
      doubleQuotedValue ?? singleQuotedValue ?? unquotedValue ?? '',
    );
  }

  return attributes;
};

/**
 * Whether the template already contains a `<link rel="stylesheet">` for `href`.
 * Other link rels (e.g. `<link rel="prefetch">` emitted by `performance.prefetch`,
 * or `<link rel="preload" as="style">`) may reference the same css URL but do not
 * apply styles, so they must not block stylesheet injection during SSR.
 */
export const hasStylesheetLink = (template: string, href: string) => {
  const linkTags = template.match(/<link\b[^>]*>/gi) ?? [];
  return linkTags.some(linkTag => {
    const attributes = getLinkAttributes(linkTag);
    const linkHref = attributes.get('href');
    const rel = attributes.get('rel');

    return (
      linkHref === href &&
      rel
        ?.split(/\s+/)
        .some(relToken => relToken.toLowerCase() === 'stylesheet')
    );
  });
};
