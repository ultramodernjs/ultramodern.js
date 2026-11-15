import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenComponents = new Set([
  '.git',
  '.output',
  'dist',
  'dist-cloudflare',
  'node_modules',
  '.cache',
  '.modern',
  '.wrangler',
  '.data',
  '.turbo',
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const commitPattern = /^[a-f0-9]{40}$/u;

// Retains an already accepted snapshot; the runner owns full runtime validation.
export function exportTractorAcceptanceSource({ workspace, reportPath, out }) {
  workspace = fs.realpathSync(workspace);
  out = path.resolve(out);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
  const reportBytes = fs.readFileSync(reportPath);
  const report = JSON.parse(reportBytes);
  if (report.status !== 'passed' || report.mode !== 'published') {
    throw new Error(
      'Source retention requires a passed published-mode receipt',
    );
  }
  const { baselineRevision, applicationSourceRevision } = report.tractor ?? {};
  if (
    ![baselineRevision, applicationSourceRevision].every(
      value => typeof value === 'string' && commitPattern.test(value),
    )
  ) {
    throw new Error(
      'Receipt must bind valid baselineRevision and applicationSourceRevision',
    );
  }
  if (git('rev-parse', 'HEAD') !== applicationSourceRevision) {
    throw new Error(
      'Git HEAD does not match receipt applicationSourceRevision',
    );
  }
  git(
    'merge-base',
    '--is-ancestor',
    baselineRevision,
    applicationSourceRevision,
  );
  if (applicationSourceRevision === baselineRevision) {
    throw new Error(
      'No source snapshot changes: baseline equals HEAD; cannot export an empty bundle',
    );
  }
  if (
    git('show', '-s', '--format=%P', applicationSourceRevision) !==
    baselineRevision
  ) {
    throw new Error(
      'Acceptance snapshot must have exactly one direct parent: baselineRevision',
    );
  }
  // Inspect names only, never working-tree contents or secret blob bytes.
  const names = git(
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    applicationSourceRevision,
  ).split('\0');
  for (const name of names.filter(Boolean)) {
    if (
      name
        .split('/')
        .some(
          component =>
            forbiddenComponents.has(component) ||
            (component.startsWith('.env') && component !== '.env.example') ||
            /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/iu.test(
              component,
            ),
        )
    ) {
      throw new Error(`Forbidden source snapshot path: ${name}`);
    }
  }
  // Resolve existing ancestors so symlinked output parents cannot enter Tractor.
  let ancestor = out;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalOut = path.join(
    fs.realpathSync(ancestor),
    path.relative(ancestor, out),
  );
  const relative = path.relative(workspace, canonicalOut);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  ) {
    throw new Error(
      'Source artifact output must be outside the Tractor workspace',
    );
  }
  if (fs.existsSync(out))
    throw new Error('Source artifact output already exists');
  const applicationSourceTree = git(
    'rev-parse',
    `${applicationSourceRevision}^{tree}`,
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out);
  try {
    const bundlePath = path.join(out, 'tractor-source.bundle');
    // HEAD is an advertised ref, not an unadvertised raw SHA; exclude all baseline history.
    git('bundle', 'create', bundlePath, 'HEAD', `^${baselineRevision}`);
    git('bundle', 'verify', bundlePath);
    if (
      git('bundle', 'list-heads', bundlePath) !==
      `${applicationSourceRevision} HEAD`
    ) {
      throw new Error('Bundle tip does not match the accepted source revision');
    }
    const metadata = {
      baselineRevision,
      applicationSourceRevision,
      applicationSourceTree,
      reportSha256: sha256(reportBytes),
      bundleSha256: sha256(fs.readFileSync(bundlePath)),
    };
    fs.writeFileSync(
      path.join(out, 'tractor-downstream-acceptance.json'),
      reportBytes,
      { flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(out, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: 'wx' },
    );
    return metadata;
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  exportTractorAcceptanceSource({
    workspace: path.resolve('../tractor'),
    reportPath: path.resolve(
      '.modern/production-readiness/tractor-downstream-acceptance.json',
    ),
    out: path.resolve('.modern/production-readiness/tractor-source'),
  });
}
