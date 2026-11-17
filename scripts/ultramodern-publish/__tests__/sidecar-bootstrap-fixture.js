const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const supply = path.resolve(__dirname, '../../ultramodern-supply');
const candidates = new Map([
  [path.join(supply, 'sidecar-candidates-20261117-parser.json'), 'picomatch'],
  [
    path.join(supply, 'sidecar-candidates-20261117-picomatch-4.json'),
    'picomatch-4',
  ],
]);

// Unit tests for transport/publication do not publish real bootstrap packages.
// Profile admission and real registry preflight still require actual provenance.
function withFixtureBootstraps(t) {
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const bytes = readFile(file, ...args);
    const id = candidates.get(file instanceof URL ? fileURLToPath(file) : file);
    if (!id) return bytes;
    const recipes = JSON.parse(bytes);
    const candidate = recipes.find(recipe => recipe.id === id);
    if (!candidate || Object.hasOwn(candidate, 'provenance')) return bytes;
    const offset = id === 'picomatch' ? 0 : 2;
    candidate.provenance = {
      grandfatheredVersions: ['0.0.0-stage', '0.0.0-bootstrap'].map(
        (version, index) => ({
          version,
          publishedAt: `2026-11-18T08:0${index + offset}:00.000Z`,
          integrity: `sha512-${'ABCD'[index + offset].repeat(86)}==`,
        }),
      ),
    };
    const result = JSON.stringify(recipes);
    return Buffer.isBuffer(bytes) ? Buffer.from(result) : result;
  });
}
module.exports = { withFixtureBootstraps };
