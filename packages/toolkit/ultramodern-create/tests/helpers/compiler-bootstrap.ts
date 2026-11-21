import fs from 'node:fs';
import path from 'node:path';

export function compilerBootstrapFixture(
  root: string,
  options: {
    platformPackage?: string;
    compilerStatus?: number;
    compilerLog?: string;
  } = {},
) {
  // Reviewed tsrs 7.1.0-beta.tsrs3 registry manifest: isolate host-selection behavior
  // from the shared checkout's (possibly not yet reinstalled) dependency tree.
  const version = '7.1.0-beta.tsrs3';
  const manifest = {
    name: 'tsrs',
    type: 'module',
    version,
    optionalDependencies: Object.fromEntries(
      [
        'darwin-arm64',
        'darwin-x64',
        'win32-x64',
        'win32-arm64',
        'linux-x64-gnu',
        'linux-x64-musl',
        'linux-arm64-gnu',
        'linux-arm64-musl',
      ].map(platform => [`@tsrs/${platform}`, version]),
    ),
  };
  const tsrsRoot = path.join(root, 'node_modules/tsrs');
  const effectRoot = path.join(root, 'node_modules/@effect/tsgo');
  const compilerLog = options.compilerLog ?? path.join(root, 'compiler.json');
  fs.mkdirSync(path.join(tsrsRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(effectRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(tsrsRoot, 'package.json'),
    JSON.stringify(manifest),
  );
  // Simulate another host through the package's own platform helper, not
  // process.platform overrides or a production bootstrap escape hatch.
  fs.writeFileSync(
    path.join(tsrsRoot, 'lib/platform.js'),
    `export const getPlatformPackageName = () => ${JSON.stringify(options.platformPackage ?? '@tsrs/darwin-arm64')};`,
  );
  fs.writeFileSync(
    path.join(effectRoot, 'package.json'),
    JSON.stringify({
      name: '@effect/tsgo',
      version: '0.73.2',
      bin: { 'effect-tsgo': 'dist/effect-tsgo.cjs' },
    }),
  );
  fs.writeFileSync(
    path.join(effectRoot, 'dist/effect-tsgo.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(compilerLog)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath
}));
if (${options.compilerStatus ?? 0} !== 0) console.error('Effect compiler readiness failed');
process.exit(${options.compilerStatus ?? 0});
`,
  );
  return { manifest, tsrsRoot, compilerLog };
}
