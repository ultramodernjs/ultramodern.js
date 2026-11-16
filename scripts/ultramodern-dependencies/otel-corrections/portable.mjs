import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildEnvironment(env = process.env) {
  const allowed = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'CI',
    'LANG',
    'LC_ALL',
    'TZ',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key)),
  );
}
export async function qualifyOtel({
  workDirectory,
  toolchain = {},
  payloads,
  lifecycle,
  run = spawnSync,
  log = console.log,
}) {
  assert(
    path.isAbsolute(workDirectory) && !fs.existsSync(workDirectory),
    'fresh absolute owning workspace required',
  );
  assert.equal(process.versions.node, '26.13.1');
  fs.mkdirSync(workDirectory);
  const env = {
    ...buildEnvironment(),
    OWNED_TEMP_DIR: workDirectory,
    OTEL_PORTABLE: '1',
    OTEL_RECEIPT_FILE: path.join(workDirectory, 'receipt.json'),
    CI: 'true',
  };
  if (toolchain.storeDirectory) {
    assert(path.isAbsolute(toolchain.storeDirectory));
    env.OTEL_STORE_DIRECTORY = toolchain.storeDirectory;
  }
  if (toolchain.pnpm) {
    assert(toolchain.pnpm === 'pnpm' || path.isAbsolute(toolchain.pnpm));
    env.OTEL_PNPM_BINARY = toolchain.pnpm;
  }
  try {
    await lifecycle?.register?.({ path: workDirectory, kind: 'build' });
    if (payloads !== undefined) {
      assert(payloads instanceof Map);
      assert.deepEqual([...payloads.keys()], ['@effect/opentelemetry']);
      const bytes = payloads.get('@effect/opentelemetry');
      assert(Buffer.isBuffer(bytes));
      env.OTEL_TRANSPORT_ARCHIVE = path.join(workDirectory, 'transport.tgz');
      fs.writeFileSync(env.OTEL_TRANSPORT_ARCHIVE, bytes);
    }
    const result = await run(
      toolchain.node ?? process.execPath,
      [fileURLToPath(new URL('./qualify.mjs', import.meta.url))],
      {
        cwd: workDirectory,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    log(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.equal(result.status, 0, 'owning OTel source/packed gates failed');
    const receipt = JSON.parse(fs.readFileSync(env.OTEL_RECEIPT_FILE, 'utf8'));
    assert.deepEqual(Object.keys(receipt).sort(), [
      'builtPatchBytes',
      'licenseBytes',
      'sourceArchiveBytes',
    ]);
    return Object.fromEntries(
      Object.entries(receipt).map(([key, value]) => [
        key,
        Buffer.from(value, 'base64'),
      ]),
    );
  } finally {
    await lifecycle?.release?.({ path: workDirectory });
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}
