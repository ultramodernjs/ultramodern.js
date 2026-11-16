import { detectLanguageWithPriority } from '../src/runtime/i18n/detection';
import { interpolateRouteParams } from '../src/runtime/Link';
import { canonicalPath, localizePath } from '../src/runtime/localizedPaths';
import { buildLocalizedUrl, splitUrlTarget } from '../src/runtime/utils';
import { createI18nInstance } from './helpers/i18nInstance';

const languages = ['en', 'cs'];

describe('splitUrlTarget public compatibility export', () => {
  test('retains the shared suffix splitter', () => {
    expect(splitUrlTarget('/a?q=1#x')).toEqual({
      pathname: '/a',
      search: '?q=1',
      hash: '#x',
    });
  });
});

describe('buildLocalizedUrl suffix handling', () => {
  test('hash-only target keeps the hash and drops the trailing slash', () => {
    expect(buildLocalizedUrl('/#work-with-me', 'en', languages)).toBe(
      '/en#work-with-me',
    );
  });

  test('query-only target keeps the query', () => {
    expect(buildLocalizedUrl('/products?tag=x', 'en', languages)).toBe(
      '/en/products?tag=x',
    );
  });

  test('root path', () => {
    expect(buildLocalizedUrl('/', 'cs', languages)).toBe('/cs');
  });
});

describe('interpolateRouteParams', () => {
  test('interpolates $param and :param segments', () => {
    expect(interpolateRouteParams('/talks/$slug', { slug: 'ai slop' })).toBe(
      '/talks/ai%20slop',
    );
    expect(interpolateRouteParams('/talks/:slug', { slug: 'x' })).toBe(
      '/talks/x',
    );
  });

  test('drops missing optional segments', () => {
    expect(interpolateRouteParams('/opt/{-$slug}', {})).toBe('/opt');
    expect(interpolateRouteParams('/opt/:slug?', {})).toBe('/opt');
    expect(interpolateRouteParams('/opt/{-$slug}', { slug: 'v' })).toBe(
      '/opt/v',
    );
  });

  test('expands splat params', () => {
    expect(interpolateRouteParams('/files/$', { _splat: 'a/b' })).toBe(
      '/files/a/b',
    );
    expect(interpolateRouteParams('/files/*', { '*': 'a' })).toBe('/files/a');
  });
});

describe('native URL strategy helpers', () => {
  test('preserves suffixes when adding or stripping only a language prefix', () => {
    expect(localizePath('/products?q=1#x', 'cs', { languages })).toBe(
      '/cs/products?q=1#x',
    );
    expect(canonicalPath('/CS/products?q=1#x', { languages })).toBe(
      '/products?q=1#x',
    );
  });
});

describe('language detection priority', () => {
  test('path locale overrides stale SSR data', async () => {
    const previousSsrData = (window as any)._SSR_DATA;
    (window as any)._SSR_DATA = { data: { i18nData: { lng: 'en' } } };

    try {
      await expect(
        detectLanguageWithPriority(createI18nInstance('en'), {
          languages,
          fallbackLanguage: 'en',
          localePathRedirect: true,
          i18nextDetector: false,
          detection: {},
          userInitOptions: {},
          pathname: '/cs/produkty',
          ssrContext: undefined,
        }),
      ).resolves.toEqual({ detectedLanguage: 'cs', finalLanguage: 'cs' });
    } finally {
      if (previousSsrData === undefined) {
        delete (window as any)._SSR_DATA;
      } else {
        (window as any)._SSR_DATA = previousSsrData;
      }
    }
  });

  test('regional SSR language resolves to supported base language', async () => {
    const previousSsrData = (window as any)._SSR_DATA;
    (window as any)._SSR_DATA = { data: { i18nData: { lng: 'en-US' } } };

    try {
      await expect(
        detectLanguageWithPriority(createI18nInstance('cs'), {
          languages,
          fallbackLanguage: 'cs',
          localePathRedirect: true,
          i18nextDetector: false,
          detection: {},
          userInitOptions: {},
          pathname: '/products',
          ssrContext: undefined,
        }),
      ).resolves.toEqual({ detectedLanguage: 'en', finalLanguage: 'en' });
    } finally {
      if (previousSsrData === undefined) {
        delete (window as any)._SSR_DATA;
      } else {
        (window as any)._SSR_DATA = previousSsrData;
      }
    }
  });
});
