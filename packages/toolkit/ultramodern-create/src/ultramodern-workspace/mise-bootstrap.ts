// Official v2026.11.8 release asset metadata (SHA-256 and byte length).
// Annotated release tag resolves to a4a1996f49779db556570678c81f658e5a28fe19.
export function renderMiseBootstrap() {
  return String.raw`node <<'ULTRAMODERN_MISE_BOOTSTRAP'
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assets = {
  x64: { name: 'mise-v2026.11.8-linux-x64', size: 180897216, sha256: '32b6abe844efa43d37d7ac4ed21d2ec41e9479d66feb19b0db8d2c548cd6e36d' },
  arm64: { name: 'mise-v2026.11.8-linux-arm64', size: 157476520, sha256: '0de1450dcc3f838e372e05e8c5231423760ad3f22d14275ef340bc0a250303ce' },
};
(async () => {
  if (process.platform !== 'linux' || !Object.hasOwn(assets, process.arch)) {
    throw new Error('mise bootstrap supports only Linux x64 and arm64');
  }
  if (!process.env.HOME) throw new Error('mise bootstrap requires HOME');
  const asset = assets[process.arch];
  const bin = path.join(process.env.HOME, '.local', 'bin');
  const target = path.join(bin, 'mise');
  await fs.mkdir(bin, { recursive: true });
  const rejectSymlink = async () => {
    const stat = await fs.lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error('Refusing to replace a non-regular mise destination');
    }
  };
  await rejectSymlink();
  const temporary = await fs.mkdtemp(path.join(bin, '.mise-bootstrap-'));
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('mise bootstrap interrupted'));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const staged = path.join(temporary, 'mise');
    const response = await fetch('https://github.com/jdx/mise/releases/download/v2026.11.8/' + asset.name, { signal });
    if (!response.ok || !response.body) throw new Error('mise download failed: HTTP ' + response.status);
    const hash = createHash('sha256');
    let size = 0;
    const file = await fs.open(staged, 'wx', 0o600);
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > asset.size) throw new Error('mise download size mismatch');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    if (size !== asset.size) throw new Error('mise download size mismatch');
    if (hash.digest('hex') !== asset.sha256) throw new Error('mise download SHA-256 mismatch');
    await fs.chmod(staged, 0o755);
    signal.throwIfAborted();
    const version = execFileSync(staged, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    if (!/^2026\.11\.8(?:\s|$)/u.test(version)) throw new Error('mise version mismatch: ' + version);
    await rejectSymlink();
    signal.throwIfAborted();
    await fs.rename(staged, target);
  } finally {
    try {
      await fs.rm(temporary, { recursive: true, force: true });
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
ULTRAMODERN_MISE_BOOTSTRAP`;
}
