import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function compilerBootstrapFixture(
  root: string,
  options: {
    platformPackage?: string;
    compilerStatus?: number;
    compilerLog?: string;
  } = {},
) {
  const manifest = JSON.parse(
    fs.readFileSync(require.resolve('tsrs/package.json'), 'utf8'),
  );
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
      version: '0.59.0',
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
