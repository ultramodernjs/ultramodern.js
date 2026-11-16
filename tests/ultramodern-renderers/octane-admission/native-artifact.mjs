import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u;

export const admissionTuple = Object.freeze({
  octane: '0.18.0',
  '@octanejs/tanstack-router': '0.3.4',
  '@octanejs/rspack-plugin': '0.2.10',
  '@tanstack/router-core': '1.171.39',
  '@tsrx/oxc': '0.24.0',
  typescript: '7.0.2',
  '@types/react': '19.3.0',
  '@types/node': '26.6.6',
  '@tanstack/history': '1.162.5',
  '@tanstack/store': '0.11.2',
});

async function owningProtocol(workspacePath) {
  assert(
    typeof workspacePath === 'string' && path.isAbsolute(workspacePath),
    'Pass the owning workspacePath for native descriptor verification',
  );
  return import(
    pathToFileURL(
      path.join(
        workspacePath,
        'scripts/ultramodern-renderers/native-artifacts/protocol.mjs',
      ),
    )
  );
}

/** Select only real producer requests; never synthesize an unpublished URL. */
export async function nativeAdmissionPlan({
  descriptor,
  workspacePath,
  manifest = {},
}) {
  assert(
    descriptor?.protocol,
    'Latest native acceptance is pending its typed owning native descriptor',
  );
  const { validateDescriptor, cohort } = await owningProtocol(workspacePath);
  validateDescriptor(descriptor);
  for (const [name, version] of Object.entries(cohort))
    assert.equal(
      version,
      admissionTuple[name],
      `Reviewed native cohort drift: ${name}`,
    );
  const nativeRequests = Object.fromEntries(
    Object.entries(descriptor.packages).map(([name, artifact]) => [
      name,
      artifact.request,
    ]),
  );
  const plan = {
    ...manifest,
    dependencies: { ...manifest.dependencies, ...nativeRequests },
    ultramodernAdmission: { workspacePath, nativeArtifacts: descriptor },
  };
  if (manifest.devDependencies)
    plan.devDependencies = { ...manifest.devDependencies };
  for (const block of ['dependencies', 'devDependencies'])
    for (const name of Object.keys(plan[block] ?? {}))
      if (nativeRequests[name]) plan[block][name] = nativeRequests[name];
      else if (admissionTuple[name]) plan[block][name] = admissionTuple[name];
  return plan;
}

function digest(algorithm, bytes, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageAt(require, name) {
  const entry = fs.realpathSync(require.resolve(name));
  let directory = path.dirname(entry);
  while (true) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = readJson(file);
      if (manifest.name !== undefined) {
        assert(
          manifest.name === name ||
            (name.startsWith('@modern-js/') &&
              manifest.ultramodern?.sourceName === name),
          `Package alias is forbidden without owning framework metadata: ${name}`,
        );
        return { directory, entry, manifest };
      }
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Missing package identity for ${name}`);
    directory = parent;
  }
}

function exportFiles(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value))
    value.forEach(item => exportFiles(item, result));
  else if (value && typeof value === 'object')
    Object.values(value).forEach(item => exportFiles(item, result));
  return result;
}

function installedFiles(directory, relative = '', result = new Map()) {
  for (const name of fs.readdirSync(path.join(directory, relative))) {
    if (relative === '' && name === 'node_modules') continue;
    const file = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, ...file.split('/'));
    const stat = fs.lstatSync(absolute);
    assert.ok(
      !stat.isSymbolicLink(),
      `Installed package file is a link: ${file}`,
    );
    if (stat.isDirectory()) installedFiles(directory, file, result);
    else {
      assert.ok(stat.isFile(), `Installed package has a special file: ${file}`);
      result.set(file, fs.readFileSync(absolute));
    }
  }
  return result;
}

function verifyInstalledArchive({ archive, expected, dependency, installed }) {
  assert.ok(
    archive.unpackedSize <= 256 * 1024 * 1024,
    'Native package exceeds the admission limit',
  );
  for (const target of exportFiles(archive.packageJson.exports)) {
    assert.ok(
      target.startsWith('./') && !target.includes('*'),
      `Native export is not an exact package file: ${target}`,
    );
    assert.ok(
      archive.fileContents.has(target.slice(2)),
      `Native export file is absent: ${target}`,
    );
  }
  const actualFiles = installedFiles(installed.directory);
  assert.deepEqual(
    [...actualFiles.keys()].sort(),
    [...archive.fileContents.keys()].sort(),
    'Installed native file set differs from the tarball',
  );
  const actualManifest = { ...installed.manifest };
  for (const field of ['_integrity', '_resolved', '_from']) {
    if (
      !Object.hasOwn(actualManifest, field) ||
      Object.hasOwn(archive.packageJson, field)
    )
      continue;
    const expectedMetadata =
      field === '_integrity' ? expected.integrity : dependency;
    assert.equal(
      actualManifest[field],
      expectedMetadata,
      `Installed native ${field} metadata`,
    );
    delete actualManifest[field];
  }
  assert.deepEqual(
    actualManifest,
    archive.packageJson,
    'Installed native package manifest differs from the tarball',
  );
  for (const field of ['exports', 'imports'])
    assert.equal(
      JSON.stringify(actualManifest[field]),
      JSON.stringify(archive.packageJson[field]),
      `Installed native ${field} conditions differ from the tarball`,
    );
  for (const [file, content] of archive.fileContents)
    if (file !== 'package.json')
      assert.ok(
        content.equals(actualFiles.get(file)),
        `Installed native bytes differ: ${file}`,
      );
  const relativeEntry = path
    .relative(installed.directory, installed.entry)
    .split(path.sep)
    .join('/');
  assert.ok(
    exportFiles(archive.packageJson.exports).includes(`./${relativeEntry}`),
    'Installed native root resolves outside the packed exports',
  );
}

function nativePeerResolution(packages, native) {
  const peers = [];
  const nativeRequire = createRequire(
    path.join(native.directory, 'package.json'),
  );
  const runtimeSpecifiers = Object.entries(native.manifest.exports)
    .filter(([, value]) =>
      exportFiles(value).some(target => /\.[cm]?js$/u.test(target)),
    )
    .map(([subpath]) =>
      subpath === '.' ? 'octane' : `octane/${subpath.slice(2)}`,
    );
  for (const [name, installed] of packages) {
    if (
      !installed.manifest.dependencies?.octane &&
      !installed.manifest.peerDependencies?.octane &&
      !installed.manifest.optionalDependencies?.octane
    )
      continue;
    const scopedRequire = createRequire(
      path.join(installed.directory, 'package.json'),
    );
    const resolved = packageAt(scopedRequire, 'octane');
    assert.equal(
      resolved.directory,
      native.directory,
      `${name} resolves a different Octane package`,
    );
    for (const specifier of runtimeSpecifiers)
      assert.equal(
        fs.realpathSync(scopedRequire.resolve(specifier)),
        fs.realpathSync(nativeRequire.resolve(specifier)),
        `${name} resolves a different ${specifier} export`,
      );
    peers.push({
      name,
      packageRoot: resolved.directory,
      runtimeExportsVerified: runtimeSpecifiers.length,
    });
  }
  return peers;
}

/** Live admission consumes the same authenticated four-asset producer protocol
 * as packed federation. Historical v1 receipts are not latest acceptance. */
export async function validateAdmissionPackages({
  root,
  workspacePath,
  nativeArtifacts,
  nativeArchives,
  nativeArtifact,
  nativeRouterArtifact,
  readGithub,
  fetchArtifact,
}) {
  const require = createRequire(path.join(root, 'package.json'));
  const manifest = readJson(path.join(root, 'package.json'));
  const admission = manifest.ultramodernAdmission ?? {};
  assert(
    !nativeArtifact && !nativeRouterArtifact,
    'Historical nativeArtifact/nativeRouterArtifact receipts cannot admit the latest native descriptor',
  );
  const descriptor = nativeArtifacts ?? admission.nativeArtifacts;
  workspacePath ??= admission.workspacePath;
  await nativeAdmissionPlan({ descriptor, workspacePath });
  const { authenticateDescriptor, readBytes } = await import(
    pathToFileURL(
      path.join(
        workspacePath,
        'scripts/ultramodern-renderers/native-artifacts/transport.mjs',
      ),
    )
  );
  const { inspectNpmTarball } = await import(
    pathToFileURL(
      path.join(
        workspacePath,
        'scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/release-artifacts.mjs',
      ),
    )
  );
  const archives = nativeArchives ?? admission.nativeArchives ?? {};
  const requests = { ...manifest.devDependencies, ...manifest.dependencies };
  // Reject drift before touching the network or declaring any installed package.
  for (const [name, artifact] of Object.entries(descriptor.packages)) {
    for (const block of ['dependencies', 'devDependencies']) {
      const declared = manifest[block]?.[name];
      if (declared !== undefined)
        assert.equal(
          declared,
          requests[name],
          `Conflicting live native request: ${name}`,
        );
    }
    assert(
      requests[name] === artifact.request ||
        (path.isAbsolute(archives[name] ?? '') &&
          requests[name] === `file:${archives[name]}`),
      `${name}: use the owning descriptor request or its explicit exact staged archive`,
    );
  }
  for (const name of ['@tsrx/oxc', 'typescript', '@types/react', '@types/node'])
    if (requests[name] !== undefined)
      assert.equal(
        requests[name],
        admissionTuple[name],
        `Live native tooling cohort: ${name}`,
      );
  const release = await authenticateDescriptor(descriptor, {
    readGithub,
    fetchArtifact,
  });
  const packages = new Map();
  const packageVersions = {};
  const verified = {};
  for (const [name, request] of Object.entries(requests)) {
    if (request.startsWith('workspace:')) continue; // Owning SDK, never a native archive.
    const installed = packageAt(require, name);
    packages.set(name, installed);
    packageVersions[name] = installed.manifest.version;
    const artifact = descriptor.packages[name];
    if (!artifact) {
      if (name.startsWith('@modern-js/')) {
        // Framework transport is admitted by its own packed release gate.
        // Keep it in the physical Octane peer-resolution check below.
        assert(
          request.startsWith('file:') ||
            /^npm:@bleedingdev\/[^@]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(
              request,
            ) ||
            exactVersion.test(request),
          `Owning framework package needs an exact packed request: ${name}`,
        );
        continue;
      }
      assert.match(
        request,
        exactVersion,
        `Admission requires an exact numeric pin for ${name}`,
      );
      assert.equal(
        installed.manifest.version,
        request,
        `Admission requires exact ${name}@${request}`,
      );
      continue;
    }
    const bytes = archives[name]
      ? fs.readFileSync(archives[name])
      : await readBytes(artifact.request, { fetchArtifact });
    assert(
      bytes.length <= 128 * 1024 * 1024,
      'Native tarball exceeds admission limit',
    );
    assert.equal(
      `sha512-${digest('sha512', bytes, 'base64')}`,
      artifact.integrity,
      `${name}: native archive SRI`,
    );
    const asset = release.assets.find(
      asset =>
        asset.name === new URL(artifact.request).pathname.split('/').at(-1),
    );
    assert.equal(
      asset?.digest,
      `sha256:${digest('sha256', bytes)}`,
      `${name}: GitHub asset digest`,
    );
    const archive = inspectNpmTarball(bytes);
    assert.equal(archive.packageJson.name, name);
    assert.equal(archive.packageJson.version, artifact.version);
    assert.equal(installed.manifest.version, artifact.version);
    verifyInstalledArchive({
      archive,
      expected: artifact,
      dependency: request,
      installed,
    });
    verified[name] = {
      name,
      version: artifact.version,
      dependencyURI: request,
      integrity: artifact.integrity,
      sha256: digest('sha256', bytes),
      descriptorManifestIntegrity: descriptor.manifest.integrity,
      producer: descriptor.producer,
      packageRoot: installed.directory,
      installedBytesVerified: true,
      fileCount: archive.fileCount,
      fileHashes: Object.fromEntries(
        [...archive.fileContents].map(([file, bytes]) => [
          file,
          digest('sha256', bytes),
        ]),
      ),
    };
  }
  assert.deepEqual(
    Object.keys(verified).sort(),
    Object.keys(descriptor.packages).sort(),
    'Every descriptor asset must be installed and byte-verified',
  );
  const native = packages.get('octane');
  for (const file of [
    'LICENSE',
    'dist/index.js',
    'dist/node/index.js',
    'dist/cjs/index.cjs',
    'dist/index.d.ts',
    'dist/compiler/index.js',
    'dist/hydration/streamed-signals.js',
  ])
    assert(
      verified.octane.fileHashes[file],
      `Owning emitted native file absent: ${file}`,
    );
  const router = packages.get('@octanejs/tanstack-router');
  assert.equal(
    router.manifest.peerDependencies?.['@tanstack/router-core'],
    admissionTuple['@tanstack/router-core'],
    'Adapter must bind the exact admitted shared Core',
  );
  verified.octane.peerPackageRoots = nativePeerResolution(packages, native);
  const routerRequire = createRequire(
    path.join(router.directory, 'package.json'),
  );
  for (const name of ['@tanstack/history', '@tanstack/store'])
    assert.equal(
      packageAt(routerRequire, name).manifest.version,
      admissionTuple[name],
      `Adapter must actually resolve reviewed ${name}`,
    );
  return {
    packageVersions,
    nativeDescriptor: descriptor,
    nativeArtifacts: verified,
    nativeArtifact: verified.octane,
    nativeRouterArtifact: verified['@octanejs/tanstack-router'],
  };
}
