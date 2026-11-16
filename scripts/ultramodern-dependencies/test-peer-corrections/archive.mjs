import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
export function readArchive(bytes) {
  assert(bytes instanceof Uint8Array, 'archive bytes required');
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  files.modes = new Map();
  let extended = {};
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      assert(
        tar.subarray(offset).every(byte => byte === 0),
        'nonzero data after tar terminator',
      );
      break;
    }
    const storedChecksum = Number.parseInt(
      text(header.subarray(148, 156)).trim(),
      8,
    );
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert.equal(checksum, storedChecksum, 'invalid tar checksum');
    const size = Number.parseInt(
      text(header.subarray(124, 136)).trim() || '0',
      8,
    );
    assert(
      Number.isSafeInteger(size) && size >= 0 && offset + size <= tar.length,
      'invalid tar size',
    );
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = text(header.subarray(156, 157));
    if (type === 'x') {
      extended = {};
      for (let cursor = 0; cursor < body.length; ) {
        const space = body.indexOf(32, cursor);
        const length = Number(body.subarray(cursor, space).toString());
        assert(
          Number.isSafeInteger(length) &&
            length > space - cursor + 1 &&
            cursor + length <= body.length,
          'invalid PAX',
        );
        const record = body.subarray(space + 1, cursor + length - 1).toString();
        const equal = record.indexOf('=');
        extended[record.slice(0, equal)] = record.slice(equal + 1);
        cursor += length;
      }
      continue;
    }
    assert(['', '0', '5'].includes(type), `unsupported tar entry type ${type}`);
    const prefix = text(header.subarray(345, 500));
    const entry =
      extended.path ??
      `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`;
    assert(
      !('size' in extended) && !('linkpath' in extended),
      'unsupported PAX override',
    );
    extended = {};
    assert(
      !entry.includes('\\') &&
        !entry.startsWith('/') &&
        !entry.split('/').includes('..'),
      'unsafe archive path',
    );
    if (type === '5') continue;
    const parts = entry.replace(/^\.\//, '').split('/');
    assert(parts.length > 1 && parts[0], 'archive requires a package root');
    const relative = parts.slice(1).join('/');
    assert(
      relative && !relative.split('/').includes('') && !files.has(relative),
      'duplicate/invalid archive member',
    );
    files.set(relative, Buffer.from(body));
    files.modes.set(
      relative,
      Number.parseInt(text(header.subarray(100, 108)).trim(), 8) & 0o777,
    );
  }
  assert(files.has('package.json'), 'archive missing package.json');
  return files;
}
export function packArchive(files) {
  const chunks = [];
  for (const [relative, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const full = `package/${relative}`;
    const header = Buffer.alloc(512);
    let name = full;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = full.lastIndexOf('/');
      name = full.slice(split + 1);
      prefix = full.slice(0, split);
    }
    assert(
      Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155,
      'tar path too long',
    );
    header.write(name, 0);
    header.write(
      `${(files.modes?.get(relative) ?? 0o644).toString(8).padStart(7, '0')}\0`,
      100,
    );
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(prefix, 345);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
export function assertSameFiles(actual, expected) {
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    'payload member set differs from owning correction',
  );
  for (const [name, bytes] of expected) {
    assert(actual.get(name)?.equals(bytes), `payload changed ${name}`);
    assert.equal(
      actual.modes?.get(name) ?? 0o644,
      expected.modes?.get(name) ?? 0o644,
      `payload mode changed ${name}`,
    );
  }
}
