import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The installed renderer proofs qualified this exact native CLI. Its official
// GitHub release asset digest is checked before the executable can run.
const version = '0.39.1';
const digest =
  '6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc';
assert.equal(process.platform, 'linux', 'Renderer acceptance requires Linux');
assert.equal(process.arch, 'x64', 'Renderer acceptance requires Linux x64');
assert(
  path.isAbsolute(process.env.RUNNER_TEMP ?? ''),
  'RUNNER_TEMP must name the actual job temporary directory',
);
assert(process.env.GITHUB_PATH && process.env.GITHUB_OUTPUT);
const directory = fs.mkdtempSync(
  path.join(
    fs.realpathSync(process.env.RUNNER_TEMP),
    'renderer-agent-browser-',
  ),
);
try {
  const response = await fetch(
    `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-x64`,
    { signal: AbortSignal.timeout(60_000) },
  );
  assert(response.ok, `Agent browser download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    digest,
    'Agent browser must match its pinned official release asset',
  );
  const executable = path.join(directory, 'agent-browser');
  fs.writeFileSync(executable, bytes, { mode: 0o700, flag: 'wx' });
  assert.equal(
    execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
    `agent-browser ${version}`,
    'Agent browser must report the qualified exact version',
  );
  assert(!/[\r\n]/u.test(directory), 'CLI path must fit one workflow line');
  fs.appendFileSync(process.env.GITHUB_PATH, `${directory}\n`);
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `executable_path=${executable}\nversion=${version}\n`,
  );
} catch (error) {
  fs.rmSync(directory, { recursive: true, force: true });
  throw error;
}
