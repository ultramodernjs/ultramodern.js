import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import { mergePnpmLockfileDocuments } from '../lib/pnpm-lockfile-documents.mjs';
import { createRegistryEnv } from '../ultramodern-publish/lib/source-create-proof/runtime-proof/registry.mjs';
import { createRendererAcceptanceEnv } from './acceptance-env.mjs';

const compilerVersion = '0.20.1-ts7.1.0-beta';
const compiler = `tsrs@${compilerVersion}`;
const version = '3.9.3-ultramodern.42';
const targetName = '@bleedingdev/modern-js-ultramodern-create';
const createPackage = {
  sourceName: '@modern-js/ultramodern-create',
  targetName,
  version,
  packageJson: {
    dependencies: { tsrs: compilerVersion },
    ultramodern: { frameworkVersion: version },
  },
};
const release = {
  aliases: { [createPackage.sourceName]: targetName },
  createPackage,
  dependencyGraph: { [targetName]: [] },
  packages: [createPackage],
  publishOrder: [targetName],
  release: { version },
};
const cohort = [`${targetName}@${version}`];

function fixture(t) {
  assert(process.env.OWNED_TEMP_DIR, 'Run through owned-temp-dir');
  const root = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR, 'renderer-trust-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userConfigPath = path.join(root, '.npmrc');
  fs.writeFileSync(userConfigPath, '');
  const registryEnv = createRegistryEnv({
    userConfigPath,
    cacheDir: path.join(root, 'npm-cache'),
    verifiedPackages: release.packages,
  });
  return { root, registryEnv, storeDir: path.join(root, 'store') };
}

async function pnpm(args, cwd, env) {
  const child = spawn('pnpm', args, { cwd, env });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', chunk => {
      output += chunk;
    });
  const [code] = await once(child, 'close');
  return { code, output };
}

// Match npm's real tsrs history: the bootstrap release has staged approval,
// which outranks the trusted-publisher + provenance evidence of newer releases.
// Relative times keep this regression inside trustPolicyIgnoreAfter's window.
async function registry(t, root) {
  const artifactRoot = path.join(root, 'registry-artifact');
  fs.mkdirSync(path.join(artifactRoot, 'package'), { recursive: true });
  fs.writeFileSync(
    path.join(artifactRoot, 'package/package.json'),
    JSON.stringify({ name: 'tsrs', version: compilerVersion }),
  );
  const tarballPath = path.join(artifactRoot, 'tsrs.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', artifactRoot, 'package']);
  const tarball = fs.readFileSync(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const now = Date.now();
  const metadata = {
    name: 'tsrs',
    'dist-tags': { latest: compilerVersion },
    time: {
      '0.0.0-bootstrap.0': new Date(now - 7 * 86400_000).toISOString(),
      [compilerVersion]: new Date(now - 3600_000).toISOString(),
    },
    versions: {
      '0.0.0-bootstrap.0': {
        name: 'tsrs',
        version: '0.0.0-bootstrap.0',
        _npmUser: { approver: { name: 'publisher' } },
        dist: { tarball: '', integrity },
      },
      [compilerVersion]: {
        name: 'tsrs',
        version: compilerVersion,
        _npmUser: { trustedPublisher: { id: 'github' } },
        dist: {
          tarball: '',
          integrity,
          attestations: {
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
        },
      },
    },
  };
  const server = http.createServer((request, response) => {
    if (request.url === `/tsrs/-/tsrs-${compilerVersion}.tgz`) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball);
      return;
    }
    if (request.url !== '/tsrs') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(metadata));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const manifest of Object.values(metadata.versions))
    manifest.dist.tarball = `${url}tsrs/-/tsrs-${manifest.version}.tgz`;
  return url;
}

test('renderer starter installs the exact reviewed compiler with source registry policy', async t => {
  const { root, registryEnv, storeDir } = fixture(t);
  const registryUrl = await registry(t, root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      private: true,
      packageManager: 'pnpm@12.11.2',
      dependencies: { tsrs: compilerVersion },
    }),
  );
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const policy = {
    packages: ['.'],
    minimumReleaseAge: 1440,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    minimumReleaseAgeExclude: [compiler],
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
    trustPolicyExclude: [compiler],
    blockExoticSubdeps: true,
    autoInstallPeers: false,
    strictDepBuilds: true,
  };
  fs.writeFileSync(workspacePath, JSON.stringify(policy));
  const runtimeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:npm|pnpm)_config_/iu.test(name),
    ),
  );
  const env = createRendererAcceptanceEnv(runtimeEnv, {
    mode: 'source',
    release,
    registryEnv,
    storeDir,
  });
  const args = ['install', '--registry', registryUrl];
  const cacheEnv = { XDG_CACHE_HOME: path.join(root, 'cache'), CI: 'true' };
  // The original renderer boundary forwarded only the registry's cohort list.
  // Prove the packument is rejected before testing the repaired environment.
  const rejected = await pnpm(args, root, {
    ...env,
    pnpm_config_trust_policy_exclude: undefined,
    ...registryEnv,
    ...cacheEnv,
  });
  assert.notEqual(rejected.code, 0, rejected.output);
  assert.match(rejected.output, /High-risk trust downgrade/u);
  const result = await pnpm(args, root, { ...env, ...cacheEnv });
  assert.equal(result.code, 0, result.output);
  const lock = mergePnpmLockfileDocuments(
    parseAllDocuments(
      fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
    ).map(document => document.toJS()),
  );
  assert.equal(lock.importers['.'].dependencies.tsrs.version, compilerVersion);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules/tsrs/package.json')),
    ).version,
    compilerVersion,
  );
  assert.deepEqual(parseYaml(fs.readFileSync(workspacePath, 'utf8')), policy);
});

for (const mode of ['source', 'published'])
  test(`${mode} renderer policy retains only authenticated exceptions and strict release age`, t => {
    const { registryEnv, storeDir } = fixture(t);
    const runtimeEnv = {
      PATH: '/qualified/bin',
      npm_config_registry: 'https://registry.npmjs.org/',
      PNPM_CONFIG_TRUST_POLICY: 'off',
      npm_config_trust_policy_exclude: '["*"]',
      pnpm_config_minimum_release_age: '0',
      NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: '["*"]',
      pnpm_config_pm_on_fail: 'error',
    };
    const original = { ...runtimeEnv };
    const env = createRendererAcceptanceEnv(runtimeEnv, {
      mode,
      release,
      registryEnv,
      storeDir,
    });
    assert.deepEqual(runtimeEnv, original);
    assert.equal(env.PNPM_CONFIG_TRUST_POLICY, undefined);
    assert.equal(env.PNPM_CONFIG_TRUST_POLICY_EXCLUDE, undefined);
    assert.equal(env.npm_config_trust_policy_exclude, undefined);
    assert.equal(env.NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE, undefined);
    assert.equal(env.pnpm_config_minimum_release_age, '1440');
    assert.equal(env.pnpm_config_minimum_release_age_strict, 'true');
    assert.equal(
      env.pnpm_config_minimum_release_age_ignore_missing_time,
      'false',
    );
    assert.equal(env.pnpm_config_pm_on_fail, 'error');
    assert.equal(env.npm_config_registry, runtimeEnv.npm_config_registry);
    assert.equal(env.npm_config_store_dir, storeDir);
    assert.deepEqual(JSON.parse(env.pnpm_config_minimum_release_age_exclude), [
      '@bleedingdev/modern-js-ultramodern-create@3.9.3-ultramodern.42',
      '@tsrs/darwin-arm64@0.20.1-ts7.1.0-beta',
      '@tsrs/darwin-x64@0.20.1-ts7.1.0-beta',
      '@tsrs/linux-arm64-gnu@0.20.1-ts7.1.0-beta',
      '@tsrs/linux-arm64-musl@0.20.1-ts7.1.0-beta',
      '@tsrs/linux-x64-gnu@0.20.1-ts7.1.0-beta',
      '@tsrs/linux-x64-musl@0.20.1-ts7.1.0-beta',
      '@tsrs/win32-x64@0.20.1-ts7.1.0-beta',
      'tsrs@0.20.1-ts7.1.0-beta',
    ]);
    if (mode === 'source')
      assert.deepEqual(JSON.parse(env.pnpm_config_trust_policy_exclude), [
        '@bleedingdev/modern-js-ultramodern-create@3.9.3-ultramodern.42',
        'tsrs@0.20.1-ts7.1.0-beta',
      ]);
    // Published consumers retain their generated workspace's exact exception.
    else assert.equal(env.pnpm_config_trust_policy_exclude, undefined);
  });

test('renderer policy rejects a registry exemption outside the verified source cohort', t => {
  const { registryEnv, storeDir } = fixture(t);
  for (const selectors of [cohort.slice(1), [...cohort, compiler], ['*']])
    assert.throws(
      () =>
        createRendererAcceptanceEnv(
          {},
          {
            mode: 'source',
            release,
            storeDir,
            registryEnv: {
              ...registryEnv,
              PNPM_CONFIG_TRUST_POLICY_EXCLUDE: JSON.stringify(selectors),
            },
          },
        ),
      /must equal the exact authenticated release cohort/u,
    );
});
