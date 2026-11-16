#!/usr/bin/env node
const nodeVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
if (
  !nodeVersion ||
  +nodeVersion[1] < 26 ||
  (+nodeVersion[1] === 26 &&
    (+nodeVersion[2] < 13 || (+nodeVersion[2] === 13 && +nodeVersion[3] < 1)))
) {
  console.error(
    `UltraModern.js requires Node.js >=26.13.1; detected v${process.versions.node}. Legacy Node runtimes and transpiler fallbacks are unsupported.`,
  );
  process.exit(1);
}
// The CLI body lives in the compiled ESM output; a CommonJS shim keeps the
// shebang and stays executable on any Node without a loader.
const path = require('path');
import('../dist/esm-node/bundleDocs.mjs').then(m =>
  m.runBundleDocsCli(path.resolve(__dirname, '..')),
);
