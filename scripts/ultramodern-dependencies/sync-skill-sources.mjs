import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const template = fileURLToPath(
  new URL(
    '../../packages/toolkit/ultramodern-create/template-workspace/',
    import.meta.url,
  ),
);
export const publicSources = [
  {
    id: 'rstack-agent-skills',
    repository: 'rstackjs/agent-skills',
    commit: '2ee8100ab8efb6d6c3c4c6d901fcb665b10163fc',
  },
  {
    id: 'module-federation-agent-skills',
    repository: 'module-federation/agent-skills',
    commit: 'cfba18cc15d84fce52f36a147a2bb79d81049972',
  },
];

function files(root, prefix = '') {
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = path.join(prefix, entry.name);
      assert(
        entry.isDirectory() || entry.isFile(),
        `Unsupported source entry: ${relative}`,
      );
      return entry.isDirectory() ? files(root, relative) : [relative];
    });
}

export function assertSameTree(actual, expected) {
  const names = files(expected);
  assert.deepEqual(files(actual), names, `File inventory differs: ${actual}`);
  for (const name of names)
    assert.deepEqual(
      fs.readFileSync(path.join(actual, name)),
      fs.readFileSync(path.join(expected, name)),
      `Bytes differ: ${name}`,
    );
}

// Source roots are unpacked immutable public archives, never executed.
export function syncSkillSources({
  templateDir = template,
  roots,
  identities,
  check = false,
}) {
  const lockPath = path.join(templateDir, '.codex/skills-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const spec of publicSources) {
    assert.equal(
      identities[spec.id],
      spec.commit,
      `Wrong source identity: ${spec.id}`,
    );
    const source = lock.sources.find(item => item.id === spec.id);
    assert.equal(source.repository, `https://github.com/${spec.repository}`);
    const root = roots[spec.id];
    const explicit = new Set(
      lock.sources.flatMap(item =>
        (item.baseline ?? []).map(skill => skill.name),
      ),
    );
    const baseline =
      source.baseline ??
      lock.baseline.filter(skill => !explicit.has(skill.name));
    for (const skill of baseline) {
      assert.match(skill.name, /^[a-z0-9-]+$/u);
      const sourceDir = path.join(root, 'skills', skill.name);
      assert(
        fs.existsSync(path.join(sourceDir, 'SKILL.md')),
        `Missing baseline: ${skill.name}`,
      );
      files(sourceDir); // Reject symlinks before copying.
      if (source.install !== 'vendored') continue;
      const destination = path.join(templateDir, '.codex/skills', skill.name);
      if (!check) {
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(sourceDir, destination, { recursive: true });
      }
      assertSameTree(destination, sourceDir);
    }
    if (source.install === 'vendored') {
      assert.equal(source.license, 'MIT');
      assert.equal(source.licensePath, '.codex/rstackjs-agent-skills-LICENSE');
      const license = fs.readFileSync(path.join(root, 'LICENSE'));
      assert(license.toString().startsWith('MIT License\n'));
      const destination = path.join(templateDir, source.licensePath);
      if (!check) fs.writeFileSync(destination, license);
      assert.deepEqual(fs.readFileSync(destination), license);
      assert.equal(lock.source.repository, source.repository);
      lock.source.commit = spec.commit;
    }
    source.commit = spec.commit;
  }
  const serialized = `${JSON.stringify(lock, null, 2)}\n`;
  if (check)
    assert.equal(
      fs.readFileSync(lockPath, 'utf8'),
      serialized,
      'Source pins differ',
    );
  else fs.writeFileSync(lockPath, serialized);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(
    process.env.OWNED_TEMP_DIR,
    'Run with owned-temp-dir --run public-skills -- node scripts/ultramodern-dependencies/sync-skill-sources.mjs [--check]',
  );
  const scratch = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'public-skills-'),
  );
  try {
    const roots = {};
    const identities = {};
    for (const spec of publicSources) {
      const identity = JSON.parse(
        execFileSync(
          'gh',
          ['api', `repos/${spec.repository}/commits/${spec.commit}`],
          { encoding: 'utf8' },
        ),
      );
      assert.equal(identity.sha, spec.commit);
      identities[spec.id] = identity.sha;
      const archive = path.join(scratch, `${spec.id}.tgz`);
      fs.writeFileSync(
        archive,
        execFileSync(
          'gh',
          ['api', `repos/${spec.repository}/tarball/${spec.commit}`],
          { maxBuffer: 8 * 1024 * 1024 },
        ),
      );
      const root = path.join(scratch, spec.id);
      fs.mkdirSync(root);
      execFileSync('tar', [
        '-xzf',
        archive,
        '-C',
        root,
        '--strip-components=1',
      ]);
      roots[spec.id] = root;
    }
    syncSkillSources({
      roots,
      identities,
      check: process.argv.includes('--check'),
    });
    console.log(
      'PASS: immutable public source identities, unchanged baseline availability, vendored bytes and MIT license',
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
