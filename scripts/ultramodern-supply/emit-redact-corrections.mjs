// Regenerate corrected runtime artifacts, never edit emitted Redact bytes by hand.
// Type-check upstream and corrected src with the same compiler/options first;
// pass both declaration output trees so inferred public changes are included too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [upstream, corrected, baselineDeclarations, declarations, esbuildModule] =
  process.argv.slice(2).map(value => path.resolve(value));
assert.ok(
  esbuildModule,
  'Usage: node emit-redact-corrections.mjs <upstream-package> <corrected-package> <upstream-declarations> <corrected-declarations> <esbuild-module>',
);
for (const directory of [
  upstream,
  corrected,
  baselineDeclarations,
  declarations,
]) {
  assert.ok(
    fs.statSync(directory).isDirectory(),
    `Missing input: ${directory}`,
  );
}
const { transform, version } = await import(pathToFileURL(esbuildModule));
assert.equal(version, '0.28.2', 'Use the reviewed artifact emitter version');

function extensions(source, relative) {
  return source.replace(
    /(from\s*|import\s*\()(['"])(\.[^'"]+)\2/gu,
    (match, prefix, quote, specifier) => {
      const base = path.resolve(
        corrected,
        'src',
        path.dirname(relative),
        specifier,
      );
      if (fs.existsSync(`${base}.ts`))
        return `${prefix}${quote}${specifier}.js${quote}`;
      if (fs.existsSync(path.join(base, 'index.ts')))
        return `${prefix}${quote}${specifier}/index.js${quote}`;
      return match;
    },
  );
}

let modules = 0;
for (const relative of fs
  .readdirSync(path.join(corrected, 'src'), { recursive: true })
  .filter(name => name.endsWith('.ts'))) {
  const sourcePath = path.join(corrected, 'src', relative);
  const original = path.join(upstream, 'src', relative);
  const source = fs.readFileSync(sourcePath, 'utf8');
  if (fs.existsSync(original) && source === fs.readFileSync(original, 'utf8'))
    continue;
  const target = path.join(
    corrected,
    'dist',
    relative.replace(/\.ts$/u, '.js'),
  );
  const output = await transform(extensions(source, relative), {
    loader: 'ts',
    target: 'es2022',
    format: 'esm',
    sourcemap: 'external',
    sourcesContent: true,
    sourcefile: path.relative(path.dirname(target), sourcePath),
    banner:
      relative === 'server/stream.ts'
        ? '// ultramodern-redact-patch: v1'
        : undefined,
  });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${output.code}//# sourceMappingURL=${path.basename(target)}.map\n`,
  );
  fs.writeFileSync(`${target}.map`, output.map);
  modules++;
}
let publicTypes = 0;
for (const relative of fs
  .readdirSync(declarations, { recursive: true })
  .filter(name => name.endsWith('.d.ts'))) {
  const emitted = fs.readFileSync(path.join(declarations, relative), 'utf8');
  const baseline = path.join(baselineDeclarations, relative);
  if (fs.existsSync(baseline) && emitted === fs.readFileSync(baseline, 'utf8'))
    continue;
  const target = path.join(corrected, 'dist', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    extensions(emitted, relative.replace(/\.d\.ts$/u, '.ts')),
  );
  publicTypes++;
}
console.log(
  `Regenerated ${modules} runtime modules/maps and ${publicTypes} changed public declarations.`,
);
