import type { Middleware } from '@modern-js/server-core';
import { fs } from '@modern-js/utils';

type SupportedEncoding = 'br' | 'gzip';

type ResolvePreCompressedAssetResult = {
  selected: {
    filepath: string;
    encoding: SupportedEncoding;
  } | null;
  hasVariant: boolean;
  acceptable: boolean;
};

const PRE_COMPRESSED_ASSET_EXTENSIONS: Record<SupportedEncoding, string> = {
  br: '.br',
  gzip: '.gz',
};

const PRE_COMPRESSED_SUPPORTED_ENCODINGS: SupportedEncoding[] = ['br', 'gzip'];

const QUALITY_VALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

const parseAcceptEncoding = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const [rawName, ...params] = item.split(';');
      const name = rawName.trim().toLowerCase();
      let q = 1;
      let qualitySeen = false;

      for (const param of params) {
        const [key, rawValue] = param.split('=').map(v => v.trim());
        if (key.toLowerCase() !== 'q') {
          continue;
        }

        if (
          qualitySeen ||
          rawValue == null ||
          !QUALITY_VALUE_PATTERN.test(rawValue)
        ) {
          q = 0;
          break;
        }

        qualitySeen = true;
        q = Number(rawValue);
      }

      return {
        name,
        q,
      };
    });

const getAcceptedRepresentations = (
  value: string | null | undefined,
): Array<SupportedEncoding | 'identity'> => {
  if (!value) {
    return ['identity'];
  }

  const parsed = parseAcceptEncoding(value);
  const qualityByEncoding = new Map<string, number>();
  let wildcardQuality: number | undefined;

  for (const { name, q } of parsed) {
    if (name === '*') {
      wildcardQuality = q;
      continue;
    }
    qualityByEncoding.set(name, q);
  }

  const getQuality = (encoding: SupportedEncoding) => {
    const explicit = qualityByEncoding.get(encoding);
    if (explicit !== undefined) {
      return explicit;
    }
    return wildcardQuality ?? 0;
  };

  const identityQuality =
    qualityByEncoding.get('identity') ?? wildcardQuality ?? 1;

  return [
    ...PRE_COMPRESSED_SUPPORTED_ENCODINGS.map(encoding => ({
      encoding,
      quality: getQuality(encoding),
    })),
    {
      encoding: 'identity' as const,
      quality: identityQuality,
    },
  ]
    .filter(item => item.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map(item => item.encoding);
};

const appendVaryHeader = (
  c: Parameters<Middleware>[0],
  value: string,
): void => {
  const current = c.res.headers.get('Vary');

  if (!current) {
    c.header('Vary', value);
    return;
  }

  const values = current
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);

  if (!values.includes(value.toLowerCase())) {
    c.header('Vary', `${current}, ${value}`);
  }
};

export const resolvePreCompressedAsset = async (
  c: Parameters<Middleware>[0],
  filepath: string,
  probeVariants: boolean,
): Promise<ResolvePreCompressedAssetResult> => {
  const brPath = `${filepath}${PRE_COMPRESSED_ASSET_EXTENSIONS.br}`;
  const gzipPath = `${filepath}${PRE_COMPRESSED_ASSET_EXTENSIONS.gzip}`;

  // Without variants only identity negotiation remains, including its 406.
  const [hasBr, hasGzip] = probeVariants
    ? await Promise.all([fs.pathExists(brPath), fs.pathExists(gzipPath)])
    : [false, false];

  const hasVariant = hasBr || hasGzip;
  const acceptedRepresentations = getAcceptedRepresentations(
    c.req.header('accept-encoding'),
  );

  for (const encoding of acceptedRepresentations) {
    if (encoding === 'identity') {
      return {
        selected: null,
        hasVariant,
        acceptable: true,
      };
    }

    if (encoding === 'br' && hasBr) {
      return {
        selected: {
          filepath: brPath,
          encoding,
        },
        hasVariant: true,
        acceptable: true,
      };
    }

    if (encoding === 'gzip' && hasGzip) {
      return {
        selected: {
          filepath: gzipPath,
          encoding,
        },
        hasVariant: true,
        acceptable: true,
      };
    }
  }

  return {
    selected: null,
    hasVariant,
    acceptable: false,
  };
};

export const applyPreCompressedAssetHeaders = (
  c: Parameters<Middleware>[0],
  preCompressedAsset: ResolvePreCompressedAssetResult,
) => {
  if (preCompressedAsset.hasVariant || !preCompressedAsset.acceptable) {
    appendVaryHeader(c, 'Accept-Encoding');
  }

  if (preCompressedAsset.selected) {
    c.header('Content-Encoding', preCompressedAsset.selected.encoding);
  }
};
