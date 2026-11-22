import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditDependencyClosure,
  verifyStrictInstallInputs,
} from '../published-create-proof/dependency-closure-audit.mjs';

const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

test('arbitrary freshly published dependencies install without age approvals and remain integrity-bound', async t => {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'immediate-release-'),
  );
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const lock = {
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          'arbitrary-third-party': { specifier: '42.7.9', version: '42.7.9' },
        },
      },
    },
    packages: { 'arbitrary-third-party@42.7.9': { resolution: { integrity } } },
    snapshots: { 'arbitrary-third-party@42.7.9': {} },
  };
  const policy = {
    minimumReleaseAge: 0,
    trustPolicy: 'no-downgrade',
    trustPolicyIgnoreAfter: 1440,
  };
  fs.writeFileSync(
    path.join(projectDir, 'pnpm-lock.yaml'),
    JSON.stringify(lock),
  );
  fs.writeFileSync(
    path.join(projectDir, 'pnpm-workspace.yaml'),
    JSON.stringify(policy),
  );
  const release = {
    packages: [],
    targetScope: 'bleedingdev',
    manifestSha256: 'a'.repeat(64),
  };
  let registryIntegrity = integrity;
  const options = {
    projectDir,
    release,
    registryUrl: 'https://registry.npmjs.org/',
    parseYamlImpl: JSON.parse,
    verifyYamlTool: false,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        versions: { '42.7.9': { dist: { integrity: registryIntegrity } } },
        time: { '42.7.9': new Date().toISOString() },
      }),
    }),
  };
  const audit = await auditDependencyClosure(options);
  assert.equal(audit.closureCount, 1);
  assert.equal(audit.closureIdentities[0].version, '42.7.9');
  assert.ok(!Object.hasOwn(audit.digests, 'exceptionPolicySha256'));
  assert.doesNotThrow(() =>
    verifyStrictInstallInputs(projectDir, audit, { parseYamlImpl: JSON.parse }),
  );
  registryIntegrity = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;
  await assert.rejects(auditDependencyClosure(options), /integrity mismatch/);
  fs.appendFileSync(path.join(projectDir, 'pnpm-lock.yaml'), ' ');
  assert.throws(
    () =>
      verifyStrictInstallInputs(projectDir, audit, {
        parseYamlImpl: JSON.parse,
      }),
    /differs from the audited/,
  );
  fs.writeFileSync(
    path.join(projectDir, 'pnpm-workspace.yaml'),
    JSON.stringify({ ...policy, trustPolicy: 'off' }),
  );
  await assert.rejects(auditDependencyClosure(options), /no-downgrade/);
});
