import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('tsrs/package.json'));
const { default: getExePath } = await import(
  pathToFileURL(join(packageRoot, 'lib/getExePath.js')).href
);
export default getExePath;
