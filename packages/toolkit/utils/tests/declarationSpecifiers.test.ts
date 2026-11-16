import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '..');

const relativeSpecifiers = (file: string) =>
  new Set(
    Array.from(
      readFileSync(file, 'utf8').matchAll(
        /\b(?:from\s*|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+)\1/g,
      ),
      match => match[2],
    ),
  );

describe('published declarations', () => {
  const sources = globSync('**/*.ts', { cwd: path.join(packageRoot, 'src') });

  it('cover every source module', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  // A rewritten `../compiled/chokidar/index.mjs` loads the CommonJS chokidar
  // declaration beside the ESM one, splitting FSWatcher into two nominal types.
  it.each(sources)('%s keeps the module specifiers tsgo checked', source => {
    const declaration = path.join(
      packageRoot,
      'dist/types',
      source.replace(/\.ts$/, '.d.ts'),
    );
    const checked = relativeSpecifiers(path.join(packageRoot, 'src', source));
    for (const specifier of relativeSpecifiers(declaration)) {
      expect(checked).toContain(specifier);
    }
  });
});
