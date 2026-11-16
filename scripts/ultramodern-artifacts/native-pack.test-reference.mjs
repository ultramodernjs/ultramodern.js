// Fabricated controls only; never a production release receipt.
// Verbatim packFiles extraction, not an import of the implementation under test.
// Source: 5f221b36c9e5a4fbdf6520320993daac1ad9fcba:scripts/ultramodern-renderers/native-artifacts/reconstruct.mjs
// Source Git blob: 7576850cda39efb62d028f4d7ff572aff0fa51cd
// Full source SHA-256: 6299de946ed96439d4abc45ed24fdf168418d480e05046a9cd67d32ad48bd7c0
// packFiles source SHA-256 (without trailing newline): 2c5f595e7776fb67e898a3b92c35dfe7a02d4ac4a2663b5f7ebb19caf6fb58d2
// Tar SHA-256 pins below were captured with this historical function and checked
// against both untouched manifest goldens using Homebrew Node 26.13.1/zlib 1.2.12.
// They cover complete tar bytes: file contents, inventory, headers and padding.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

export function packFiles(files) {
  const chunks = [];
  for (const [relative, { bytes, mode }] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const filename = `package/${relative}`;
    assert(!filename.includes('..') && !filename.includes('\\'));
    const header = Buffer.alloc(512);
    let name = filename;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf('/');
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    assert(
      Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155,
      `Tar path too long: ${filename}`,
    );
    header.write(name);
    const octal = (offset, length, number) =>
      header.write(
        `${number.toString(8).padStart(length - 1, '0')}\0`,
        offset,
        length,
        'ascii',
      );
    octal(100, 8, mode & 0o777);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(prefix, 345);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
      'ascii',
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export const canonicalTarSha256 = {
  fixture: {
    '@octanejs/rspack-plugin':
      'a1687ff28435739a65c81ba8adb4e45917cfb7f5b991a771ced654a1e9008667',
    '@octanejs/tanstack-router':
      '00ee3fa4e36debd23b8235f1bd5c9a8b61238a097ca4f80cfa89cdb7a524eebb',
    '@tanstack/router-core':
      '6cd5b4c50554fe310d0040b074716cc0a844ec4786b1d80433eb4187d1012e5d',
    octane: 'ecacb67addf2887fa2c1c17e6390f5fe8616efb49cda1ad08c6c22a5fb7ff340',
  },
  reconstructed: {
    '@octanejs/rspack-plugin':
      'bf63f816f9ed80e52961720f0abd3215381e8431bc0e6e2075b3cd23658f1ce4',
    '@octanejs/tanstack-router':
      '82a7b8f384db9a4cb4c7d5d1c86d728345c1ef9e1810f2cbf1db1817185c8234',
    '@tanstack/router-core':
      '97c669aba97fab7e6837dc62caf2de947558e6bb6d15b2c06e4b6c8835e49f51',
    octane: '3196e0968bbcd75966968292b424ab3f25b068ac7e95415fd915f6f94013cd20',
  },
};
