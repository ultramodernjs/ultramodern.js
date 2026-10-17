import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const compilerRequire = createRequire(
  path.resolve(
    __dirname,
    '../../../../solutions/ultramodern-app-tools/package.json',
  ),
);

// This is a compiler timing canary, not a native owner-transfer acceptance.
// Its directory must be inside the executing operation's registered temp root.
test('actual Rspack container get loads chunks before executing the exposed graph', async () => {
  const ownedRoot = process.env.ULTRAMODERN_PROOF_WORK_DIR;
  if (!ownedRoot)
    throw new Error(
      'Register ULTRAMODERN_PROOF_WORK_DIR before running the Rspack canary.',
    );
  const root = mkdtempSync(path.join(ownedRoot, 'native-factory-timing-'));
  const sentinel = `__native_factory_timing_${process.pid}`;
  const source = path.join(root, 'exposed.js');
  const output = path.join(root, 'dist');
  writeFileSync(
    source,
    `globalThis[${JSON.stringify(sentinel)}]++; export const value = 'fresh';`,
  );
  const { rspack } = compilerRequire('@rsbuild/core');
  const runtimeRequire = createRequire(
    compilerRequire.resolve('@rsbuild/core'),
  );
  const { ModuleFederation } = runtimeRequire(
    '@module-federation/runtime-tools/runtime',
  );
  const compiler = rspack({
    context: root,
    mode: 'development',
    devtool: false,
    target: 'node',
    entry: {},
    output: {
      path: output,
      filename: '[name].cjs',
      chunkFilename: '[name].[contenthash].cjs',
      library: { type: 'commonjs-module' },
    },
    plugins: [
      // V1 produces the public container/chunk ABI. The actual enhanced
      // runtime below consumes it; the default V2 plugin requires an unrelated
      // optional peer lookup from the test compiler's execution context.
      new rspack.container.ModuleFederationPluginV1({
        name: 'native_factory_timing',
        filename: 'remote.cjs',
        library: { type: 'commonjs-module' },
        exposes: { './Widget': source },
      }),
    ],
  });
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  global[sentinel] = 0;
  try {
    const stats = await new Promise<any>((resolve, reject) =>
      compiler.run((error: Error | null, result: unknown) =>
        error ? reject(error) : resolve(result),
      ),
    );
    expect(stats.toJson({ all: false, errors: true }).errors).toEqual([]);
    const container = compilerRequire(path.join(output, 'remote.cjs'));
    expect(global[sentinel]).toBe(0);
    const stages: string[] = [];
    const remoteName = `native_timing_${path.basename(root).replace(/-/gu, '_')}`;
    const host = new ModuleFederation({
      name: `${remoteName}_host`,
      remotes: [
        {
          name: remoteName,
          entry: path.join(output, 'remote.cjs'),
          type: 'commonjs-module',
        },
      ],
      plugins: [
        {
          name: 'normal-container-transport-canary',
          // Public loadEntry transport supplies a real compiled container. No
          // factory/get hook substitutes or evaluates the exposed source.
          loadEntry() {
            stages.push('entry');
            expect(global[sentinel]).toBe(0);
            return container;
          },
          afterGetExpose() {
            stages.push('factory');
            expect(global[sentinel]).toBe(0);
          },
        },
      ],
    });
    const factory = await host.loadRemote(`${remoteName}/Widget`, {
      loadFactory: false,
    });
    expect(typeof factory).toBe('function');
    expect(global[sentinel]).toBe(0);
    expect(stages).toEqual(['entry', 'factory']);
    // The real native capability must enclose this exact synchronous call;
    // await get/init and module evaluation cannot be interchanged.
    const module = factory();
    expect(module).not.toBeInstanceOf(Promise);
    expect(module.value).toBe('fresh');
    expect(global[sentinel]).toBe(1);
    expect(factory()).toBe(module);
    expect(global[sentinel]).toBe(1);
  } finally {
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.close((error: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
    } finally {
      delete global[sentinel];
      for (const key of Object.keys(compilerRequire.cache))
        if (key.startsWith(`${root}${path.sep}`))
          delete compilerRequire.cache[key];
      rmSync(root, { recursive: true, force: true });
    }
  }
});
