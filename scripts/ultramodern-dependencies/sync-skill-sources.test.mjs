import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSameTree,
  publicSources,
  syncSkillSources,
} from './sync-skill-sources.mjs';

const template = fileURLToPath(
  new URL(
    '../../packages/toolkit/ultramodern-create/template-workspace/',
    import.meta.url,
  ),
);

test('sync preserves selection/private config, copies exact bytes/license, removes stale files and is idempotent', () => {
  assert(process.env.OWNED_TEMP_DIR, 'Run tests through owned-temp-dir');
  const temp = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'skill-test-'),
  );
  try {
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    const original = JSON.parse(
      fs.readFileSync(path.join(template, '.codex/skills-lock.json')),
    );
    fs.writeFileSync(
      path.join(workspace, '.codex/skills-lock.json'),
      JSON.stringify(original),
    );
    const roots = {};
    const identities = Object.fromEntries(
      publicSources.map(spec => [spec.id, spec.commit]),
    );
    const explicit = new Set(
      original.sources.flatMap(source =>
        (source.baseline ?? []).map(skill => skill.name),
      ),
    );
    for (const spec of publicSources) {
      const root = path.join(temp, spec.id);
      roots[spec.id] = root;
      const source = original.sources.find(item => item.id === spec.id);
      const baseline =
        source.baseline ??
        original.baseline.filter(skill => !explicit.has(skill.name));
      for (const skill of baseline) {
        fs.mkdirSync(path.join(root, 'skills', skill.name), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(root, 'skills', skill.name, 'SKILL.md'),
          `# ${skill.name}\n`,
        );
      }
      fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License\nfixture\n');
    }
    const args = { templateDir: workspace, roots, identities };
    assert.throws(
      () =>
        syncSkillSources({
          ...args,
          identities: { ...identities, 'rstack-agent-skills': 'wrong' },
        }),
      /identity/u,
    );
    const stale = path.join(
      workspace,
      '.codex/skills/rsbuild-best-practices/stale.txt',
    );
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'obsolete');
    syncSkillSources(args);
    assert(!fs.existsSync(stale));
    const first = fs.readFileSync(
      path.join(workspace, '.codex/skills-lock.json'),
    );
    syncSkillSources(args);
    syncSkillSources({ ...args, check: true });
    assert.deepEqual(
      fs.readFileSync(path.join(workspace, '.codex/skills-lock.json')),
      first,
    );
    const after = JSON.parse(first);
    assert.deepEqual(after.baseline, original.baseline);
    assert.deepEqual(after.excludedByDefault, original.excludedByDefault);
    assert.deepEqual(
      after.sources.find(source => source.visibility === 'private'),
      original.sources.find(source => source.visibility === 'private'),
    );
    assertSameTree(
      path.join(workspace, '.codex/skills/rsbuild-best-practices'),
      path.join(roots['rstack-agent-skills'], 'skills/rsbuild-best-practices'),
    );
    fs.appendFileSync(
      path.join(workspace, '.codex/skills/rsbuild-best-practices/SKILL.md'),
      'corrupt',
    );
    assert.throws(
      () => syncSkillSources({ ...args, check: true }),
      /Bytes differ/u,
    );

    // Exercise the real bootstrap, with an exact local Git commit and no network/private source.
    syncSkillSources(args);
    const localRepo = roots['module-federation-agent-skills'];
    const git = commands =>
      execFileSync('git', commands, {
        cwd: localRepo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git(['init']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'fixture',
    ]);
    const lock = JSON.parse(first);
    lock.sources = lock.sources.filter(
      source => source.visibility === 'public',
    );
    const mf = lock.sources.find(
      source => source.id === 'module-federation-agent-skills',
    );
    mf.repository = `file://${localRepo}`;
    mf.commit = git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(
      path.join(workspace, '.codex/skills-lock.json'),
      JSON.stringify(lock),
    );
    const script = path.join(
      temp,
      'bootstrap/scripts/bootstrap-agent-skills.mjs',
    );
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(
      path.join(template, 'scripts/bootstrap-agent-skills.mjs'),
      script,
    );
    fs.cpSync(
      path.join(template, '.codex/skills'),
      path.join(temp, 'bootstrap/.codex/skills'),
      { recursive: true },
    );
    execFileSync(process.execPath, [script, '--postinstall'], {
      cwd: workspace,
      env: {
        ...process.env,
        TMPDIR: temp,
        ULTRAMODERN_SKIP_CODEX_SKILLS: '0',
        ULTRAMODERN_CODEX_SKILLS: '1',
        ULTRAMODERN_LEFTHOOK_BIN: path.join(temp, 'absent-lefthook'),
      },
      stdio: 'pipe',
    });
    assertSameTree(
      path.join(workspace, '.codex/skills/mf'),
      path.join(localRepo, 'skills/mf'),
    );
    for (const skill of original.baseline.filter(skill => skill.name !== 'mf'))
      assertSameTree(
        path.join(workspace, '.codex/skills', skill.name),
        path.join(template, '.codex/skills', skill.name),
      );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
