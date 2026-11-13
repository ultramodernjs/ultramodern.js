const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProcessEnv,
  runCommand,
  runCommandList,
} = require('../process-kit');

const nodeArgs = script => ['-e', script];

for (const stream of ['stdout', 'stderr']) {
  test(`runCommand captures >1 MiB of ${stream} with an explicit maxBuffer`, () => {
    const output = 'x'.repeat(1024 * 1024 + 64 * 1024);
    const result = runCommand(
      process.execPath,
      nodeArgs(`process.${stream}.write('x'.repeat(${output.length}))`),
      { stdio: 'pipe', maxBuffer: 2 * 1024 * 1024 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.processStatus, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result[stream], output);
    assert.equal(result[stream === 'stdout' ? 'stderr' : 'stdout'], '');
  });

  for (const [label, options, outputBytes] of [
    ['default', {}, 1024 * 1024 + 64 * 1024],
    ['explicit smaller', { maxBuffer: 64 * 1024 }, 128 * 1024],
  ]) {
    test(`runCommand enforces the ${label} ${stream} buffer limit`, () => {
      const result = runCommand(
        process.execPath,
        nodeArgs(`process.${stream}.write('x'.repeat(${outputBytes}))`),
        { stdio: 'pipe', ...options },
      );

      assert.equal(result.error?.code, 'ENOBUFS');
      assert.equal(result.processStatus, null);
      assert.equal(result.exitCode, 1);
    });
  }
}

test('runCommand passes shell metacharacters as literal args', () => {
  const result = runCommand(
    process.execPath,
    [
      '-e',
      'process.stdout.write(process.argv[1])',
      'literal && not shell',
    ],
    { stdio: 'pipe' },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'literal && not shell');
});

test('process env removals survive Windows-style case folding and command execution', () => {
  const inheritedKeys = [
    'NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE',
    'NPM_CONFIG_TRUST_POLICY_EXCLUDE',
    'PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE',
    'PNPM_CONFIG_TRUST_POLICY_EXCLUDE',
    'npm_config_minimum_release_age_exclude',
    'npm_config_trust_policy_exclude',
    'pnpm_config_minimum_release_age_exclude',
    'pnpm_config_trust_policy_exclude',
    'NpM_Config_Minimum_Release_Age_Exclude',
    'nPm_Config_Trust_Policy_Exclude',
    'PnPm_Config_Minimum_Release_Age_Exclude',
    'pNpM_Config_Trust_Policy_Exclude',
  ];
  const inherited = Object.fromEntries(
    inheritedKeys.map(name => [name, process.env[name]]),
  );
  try {
    for (const name of inheritedKeys) {
      process.env[name] = '*';
    }
    const exactSelector = '["@bleedingdev/create@3.5.0-ultramodern.77"]';
    const env = createProcessEnv({
      NPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: undefined,
      NPM_CONFIG_TRUST_POLICY_EXCLUDE: undefined,
      PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE: undefined,
      PNPM_CONFIG_TRUST_POLICY_EXCLUDE: undefined,
      npm_config_minimum_release_age_exclude: undefined,
      npm_config_trust_policy_exclude: undefined,
      pnpm_config_minimum_release_age_exclude: exactSelector,
      pnpm_config_trust_policy_exclude: undefined,
    });
    assert.equal(
      Object.values(env).some(value => value === undefined),
      false,
    );

    const windowsEnv = new Map();
    for (const name of Object.keys(env).sort()) {
      const caseFoldedName = name.toLowerCase();
      if (!windowsEnv.has(caseFoldedName)) {
        windowsEnv.set(caseFoldedName, env[name]);
      }
    }
    assert.equal(
      windowsEnv.get('pnpm_config_minimum_release_age_exclude'),
      exactSelector,
    );
    assert.equal(
      windowsEnv.has('pnpm_config_trust_policy_exclude'),
      false,
    );
    assert.equal(
      windowsEnv.has('npm_config_minimum_release_age_exclude'),
      false,
    );
    assert.equal(windowsEnv.has('npm_config_trust_policy_exclude'), false);

    env.REMOVED_AFTER_CREATE = undefined;
    env.CASE_VARIANT = 'stale';
    env.Case_Variant = 'current';

    const result = runCommand(
      process.execPath,
      nodeArgs(
        `process.stdout.write(JSON.stringify({
          caseVariants: Object.fromEntries(
            Object.entries(process.env).filter(([name]) =>
              name.toLowerCase() === 'case_variant',
            ),
          ),
          releasePolicy: Object.fromEntries(
            Object.entries(process.env).filter(([name]) =>
              /^(?:npm|pnpm)_config_(?:minimum_release_age|trust_policy)_exclude$/iu.test(name),
            ),
          ),
          removedAfterCreate: process.env.REMOVED_AFTER_CREATE,
        }))`,
      ),
      { env, stdio: 'pipe' },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      caseVariants: { Case_Variant: 'current' },
      releasePolicy: {
        pnpm_config_minimum_release_age_exclude: exactSelector,
      },
    });
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('runCommandList stops on first failure by default', () => {
  const results = runCommandList(
    [
      { id: 'first', command: process.execPath, args: nodeArgs('process.exit(2)') },
      { id: 'second', command: process.execPath, args: nodeArgs('process.exit(0)') },
    ],
    { stdio: 'pipe' },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'first');
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].exitCode, 2);
});
