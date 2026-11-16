import type { LocalizedLinkProps } from '../../../src/i18n/LocalizedLink';

export const dataAttributes: LocalizedLinkProps = {
  to: '/products',
  'data-testid': 'products-link',
  'data-index': 1,
  'data-current': true,
};

export const invalidDataAttribute: LocalizedLinkProps = {
  to: '/products',
  // @ts-expect-error Data attributes follow Solid's DOM attribute value contract.
  'data-payload': { id: 1 },
};
