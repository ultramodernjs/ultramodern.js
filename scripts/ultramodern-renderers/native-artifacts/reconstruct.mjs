import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { inspectNpmTarball } from '../../ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs';
import {
  assetFilename,
  cohort,
  exactKeys,
  hash,
  integrity,
  manifestBytes,
  protocol,
  releaseUrl,
  sha256,
  validateProducer,
  validateUpstream,
} from './protocol.mjs';
import { readBytes } from './transport.mjs';

// Deterministic npm tar layout: no host paths, timestamps, owners or gzip time.
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
export function validateRecipe(recipe) {
  exactKeys(recipe, ['packages', 'qualifySource', 'qualifyPacked'], 'recipe');
  exactKeys(recipe.packages, Object.keys(cohort), 'recipe cohort');
  assert.equal(
    typeof recipe.qualifySource,
    'function',
    'Owning source qualification required',
  );
  assert.equal(
    typeof recipe.qualifyPacked,
    'function',
    'Actual packed behavior qualification required',
  );
  for (const [name, version] of Object.entries(cohort)) {
    const item = recipe.packages[name];
    exactKeys(item, ['upstream', 'patchPath', 'patchSha256'], name);
    validateUpstream(item.upstream, name, version);
    assert.equal(typeof item.patchPath, 'string');
    hash(item.patchSha256);
  }
}
export function verifySourceQualification(recipe, evidence) {
  exactKeys(evidence, Object.keys(cohort), 'source qualification cohort');
  for (const [name, item] of Object.entries(recipe.packages)) {
    const proof = evidence[name];
    exactKeys(
      proof,
      ['sourceArchiveBytes', 'builtPatchBytes', 'licenseBytes'],
      'owning source qualification bytes',
    );
    for (const bytes of Object.values(proof))
      assert(Buffer.isBuffer(bytes), 'Qualification must return actual bytes');
    assert.equal(
      integrity(proof.sourceArchiveBytes),
      item.upstream.sourceArchiveIntegrity,
      `${name}: actual source archive digest`,
    );
    assert.equal(
      sha256(proof.builtPatchBytes),
      item.patchSha256,
      `${name}: actual built npm-layout patch digest`,
    );
    assert.equal(
      sha256(proof.licenseBytes),
      item.upstream.licenseSha256,
      `${name}: source/npm license coherence`,
    );
  }
}
export function applyExactPatch(patch, directory) {
  const text = patch.toString('utf8');
  assert.equal(Buffer.from(text).equals(patch), true, 'Patch must be UTF-8');
  const lines = text.split('\n');
  const updates = new Map();
  const safe = filename => {
    if (filename === '/dev/null') return null;
    assert.match(
      filename,
      /^[ab]\/[A-Za-z0-9_@./-]+$/u,
      'Unsafe patch filename',
    );
    const parts = filename.split('/').slice(1);
    assert(
      parts.every(part => part && !['..', '.', '.git'].includes(part)),
      'Unsafe patch traversal',
    );
    return parts.join('/');
  };
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    assert(
      !/^(?:GIT binary patch|Binary files|old mode|new mode|rename |copy )/u.test(
        line,
      ),
      'Unsupported patch operation',
    );
    if (line.startsWith('new file mode'))
      assert.equal(line, 'new file mode 100644');
    if (!line.startsWith('--- ')) continue;
    const before = safe(line.slice(4).split('\t')[0]);
    assert(lines[++i]?.startsWith('+++ '), 'Missing paired patch header');
    const after = safe(lines[i].slice(4).split('\t')[0]);
    assert(before || after);
    assert(
      !before || !after || before === after,
      'Patch must not rename files',
    );
    const file = before ?? after;
    assert(!updates.has(file), 'Repeated patch file');
    const absolute = path.join(directory, file);
    const original = before ? fs.readFileSync(absolute, 'utf8') : '';
    if (!before)
      assert(!fs.existsSync(absolute), 'New patch file already exists');
    const source = original.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const result = [];
    let cursor = 0;
    let count = 0;
    while (lines[i + 1]?.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(
        lines[++i],
      );
      assert(match, 'Malformed hunk');
      const oldCount = Number(match[2] ?? 1);
      const newCount = Number(match[4] ?? 1);
      const start = Number(match[1]) - (oldCount ? 1 : 0);
      assert(start >= cursor && start <= source.length, 'Patch hunk position');
      result.push(...source.slice(cursor, start));
      assert.equal(
        result.length,
        Number(match[3]) - (newCount ? 1 : 0),
        'Patch new hunk position',
      );
      const old = [];
      const next = [];
      while (old.length < oldCount || next.length < newCount) {
        const content = lines[++i];
        assert(
          content && [' ', '-', '+'].includes(content[0]),
          'Malformed hunk body',
        );
        const value = `${content.slice(1)}\n`;
        if (content[0] !== '+') old.push(value);
        if (content[0] !== '-') next.push(value);
        if (lines[i + 1] === '\\ No newline at end of file') {
          i++;
          if (content[0] !== '+') old[old.length - 1] = old.at(-1).slice(0, -1);
          if (content[0] !== '-')
            next[next.length - 1] = next.at(-1).slice(0, -1);
        }
      }
      assert.equal(old.length, oldCount);
      assert.equal(next.length, newCount);
      assert.deepEqual(
        source.slice(start, start + oldCount),
        old,
        'Non-exact patch context (no offset/fuzz allowed)',
      );
      result.push(...next);
      cursor = start + oldCount;
      count++;
    }
    assert(count > 0, 'Missing npm-layout patch hunks');
    result.push(...source.slice(cursor));
    if (!after) assert.equal(result.join(''), '', 'Deleted file retains bytes');
    updates.set(file, after ? result.join('') : null);
    hunks += count;
  }
  assert(hunks > 0, 'Missing npm-layout patch hunks');
  for (const [file, content] of updates) {
    const absolute = path.join(directory, file);
    if (content === null) fs.unlinkSync(absolute);
    else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
  }
}
function collect(directory, relative = '', result = new Map()) {
  for (const entry of fs.readdirSync(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = path.posix.join(relative, entry.name);
    assert(!entry.isSymbolicLink(), 'Symlink in reconstructed archive');
    if (entry.isDirectory()) collect(directory, file, result);
    else {
      assert(entry.isFile(), 'Non-file in reconstructed archive');
      const absolute = path.join(directory, file);
      result.set(file, {
        bytes: fs.readFileSync(absolute),
        mode: fs.statSync(absolute).mode,
      });
    }
  }
  return result;
}
export async function reconstruct({
  recipe,
  producer,
  directory,
  fetchArtifact = fetch,
  signal,
}) {
  validateRecipe(recipe);
  validateProducer(producer);
  fs.mkdirSync(directory);
  const packages = {};
  for (const [name, version] of Object.entries(cohort)) {
    const item = recipe.packages[name];
    const patch = fs.readFileSync(item.patchPath);
    assert.equal(
      sha256(patch),
      item.patchSha256,
      `${name}: canonical patch digest`,
    );
    const bytes = await readBytes(item.upstream.request, {
      fetchArtifact,
      signal,
    });
    assert.equal(
      integrity(bytes),
      item.upstream.integrity,
      `${name}: upstream npm integrity`,
    );
    const original = inspectNpmTarball(bytes);
    assert.equal(original.packageJson.name, name);
    assert.equal(original.packageJson.version, version);
    assert.equal(
      sha256(original.fileContents.get('LICENSE')),
      item.upstream.licenseSha256,
      `${name}: upstream license`,
    );
    const unpacked = path.join(directory, name.replaceAll('/', '__'));
    fs.mkdirSync(unpacked);
    try {
      for (const file of original.files) {
        const absolute = path.join(unpacked, file.path);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, original.fileContents.get(file.path), {
          flag: 'wx',
          mode: file.mode & 0o777,
        });
      }
      applyExactPatch(patch, unpacked);
      const corrected = collect(unpacked);
      assert.equal(
        sha256(corrected.get('LICENSE').bytes),
        item.upstream.licenseSha256,
        `${name}: preserve upstream license`,
      );
      const archive = packFiles(corrected);
      const packed = inspectNpmTarball(archive);
      assert.equal(packed.packageJson.name, name);
      assert.equal(packed.packageJson.version, version);
      fs.writeFileSync(
        path.join(directory, assetFilename(name, version)),
        archive,
        { flag: 'wx' },
      );
      packages[name] = {
        version,
        request: releaseUrl(producer, assetFilename(name, version)),
        integrity: integrity(archive),
        upstream: item.upstream,
        patchSha256: item.patchSha256,
      };
    } finally {
      fs.rmSync(unpacked, { recursive: true, force: true });
    }
  }
  const manifest = { protocol, producer, packages };
  fs.writeFileSync(
    path.join(directory, 'native-artifacts.json'),
    manifestBytes(manifest),
    { flag: 'wx' },
  );
  return manifest;
}
