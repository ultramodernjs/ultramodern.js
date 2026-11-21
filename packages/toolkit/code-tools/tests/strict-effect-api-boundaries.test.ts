import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runOxlintRules } from '../src/cli/oxlint';
import { createStrictEffectApiBoundariesRule } from '../src/oxlint-plugin/rules/strict-effect-api-boundaries';

const messages = (filename: string, source: string): string[] => {
  const output: string[] = [];
  createStrictEffectApiBoundariesRule()
    .create({
      filename,
      getSourceCode: () => ({ text: source }),
      report: descriptor => output.push(descriptor.message),
    })
    .Program({ type: 'Program' });
  return output;
};

test('matches legacy Effect imports by path segment', () => {
  expect(
    messages('src/component.ts', "import { x } from './api/effectual';"),
  ).toEqual([]);
  expect(
    messages('src/component.ts', "import { x } from './shared/effects';"),
  ).toEqual([]);
  expect(
    messages('src/component.ts', "import { x } from './api/effect.ts';").join(
      '\n',
    ),
  ).toContain('Import API code');
  expect(
    messages(
      'src/component.ts',
      "import { x } from './shared/effect/private';",
    ).join('\n'),
  ).toContain('Import API code');
  expect(
    messages(
      'verticals/catalog/api/effect/index.ts',
      'export const x = 1;',
    ).join('\n'),
  ).toContain('api/effect, api/lambda');
});

const schemaDiagnostic =
  'API modules must use concrete request, response and error schemas; Schema.UnknownFromJsonString, Schema.Unknown and Schema.Any are forbidden in UltraModern API code.';

/** Runs the real Oxlint AST through the rule, so type positions parse as Oxlint parses them. */
const lintApiModules = (sources: Readonly<Record<string, string>>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'um-strict-boundaries-'));
  try {
    const modules = path.join(root, 'verticals/fixture/api/modules');
    fs.mkdirSync(modules, { recursive: true });
    for (const [name, source] of Object.entries(sources))
      fs.writeFileSync(path.join(modules, name), source);
    const result = runOxlintRules({
      cwd: root,
      targets: ['verticals/fixture'],
      rules: { 'ultramodern/strict-effect-api-boundaries': 'error' },
    });
    const output = stripVTControlCharacters(result.stdout + result.stderr);
    expect(output).not.toMatch(/Error running JS plugin/u);
    return { exitCode: result.exitCode, output };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('allows type-only Schema.Unknown references and rejects runtime Schema.Unknown-family access', () => {
  const typeOnly = lintApiModules({
    'type-only.ts': `import { Schema } from 'effect';
type Unparsed = typeof Schema.Unknown.Type;
type Loose = typeof Schema.Any;
export const keep = (value: Unparsed, loose: Loose) => [value, loose];
// Schema.Unknown in a comment, and 'Schema.Any' in a string, are not access.
export const label = 'Schema.Any';
`,
  });
  expect(typeOnly.output).not.toContain(schemaDiagnostic);
  expect(typeOnly.exitCode).toBe(0);

  const runtime: Record<string, string> = {
    'any.ts': 'export const schema = Schema.Any;\n',
    'computed.ts': "export const schema = Schema['Unknown'];\n",
    'template.ts': 'export const schema = Schema[`Any`];\n',
    'json.ts': 'export const schema = Schema.UnknownFromJsonString;\n',
    'optional.ts': 'export const schema = Schema?.Unknown;\n',
    'typeof-value.ts': 'export const kind = typeof Schema.Unknown;\n',
    'jsx.tsx': 'export const view = <Schema.Unknown />;\n',
    'import-equals.ts':
      "import { Schema } from 'effect';\nimport Loose = Schema.Any;\nexport const schema = Loose;\n",
  };
  const { exitCode, output } = lintApiModules(runtime);
  expect(exitCode).toBe(1);
  for (const name of Object.keys(runtime)) expect(output, name).toMatch(name);
  expect(output.split(schemaDiagnostic).length - 1).toBe(
    Object.keys(runtime).length,
  );
});
