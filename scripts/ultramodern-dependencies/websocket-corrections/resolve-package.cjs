const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Follow the selected public entry, not a guessed virtual-store directory or
// an unexported package.json subpath. Only inspect the nearest owning manifest.
function resolvePackage(from, name) {
  const entry = fs.realpathSync(from.resolve(name));
  let directory = path.dirname(entry);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `No owning manifest for ${entry}`);
    directory = parent;
  }
  const manifestPath = path.join(directory, 'package.json');
  return {
    entry,
    directory,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    require: createRequire(entry),
  };
}
module.exports = { resolvePackage };
