import fs from 'node:fs';
import { createRequire } from 'module';
import path from 'path';
import recursive from 'recursive-readdir';

const require = createRequire(import.meta.url);

const IgnoreFiles = [
  '.nvmrc',
  '.vscode/extensions.json',
  '.vscode/settings.json',
  '.rstack/hooks/pre-commit',
  'README.md',
  'rstack.config.mts',
];

function renderTemplate(
  template: string,
  data: Record<string, unknown>,
): string {
  type ConditionalKind = 'if' | 'unless';
  const tagRegex = /\{\{(~?)(#if|#unless|\/if|\/unless)(?:\s+(\w+))?(~?)\}\}/g;

  function renderConditionals(
    startIndex: number,
    expectedClose?: ConditionalKind,
  ): {
    rendered: string;
    nextIndex: number;
  } {
    let rendered = '';
    let cursor = startIndex;
    tagRegex.lastIndex = startIndex;

    while (true) {
      const match = tagRegex.exec(template);
      if (!match) {
        return {
          rendered: rendered + template.slice(cursor),
          nextIndex: template.length,
        };
      }

      const [raw, , tag, condition, rightTrim] = match;
      const tagIndex = match.index;
      rendered += template.slice(cursor, tagIndex);
      cursor = tagIndex + raw.length;

      if (tag === '#if' || tag === '#unless') {
        const kind: ConditionalKind = tag === '#if' ? 'if' : 'unless';
        const innerResult = renderConditionals(cursor, kind);
        cursor = innerResult.nextIndex;
        tagRegex.lastIndex = cursor;

        const conditionValue = Boolean(data[condition ?? '']);
        const shouldInclude = kind === 'if' ? conditionValue : !conditionValue;
        if (shouldInclude) {
          rendered += innerResult.rendered;
        }
        continue;
      }

      if (tag === '/if' || tag === '/unless') {
        const kind: ConditionalKind = tag === '/if' ? 'if' : 'unless';
        if (expectedClose === kind) {
          let nextIndex = cursor;
          if (rightTrim === '~') {
            const trailingWhitespace = /^\s*/u.exec(template.slice(nextIndex));
            nextIndex += trailingWhitespace?.[0].length ?? 0;
          }
          return {
            rendered,
            nextIndex,
          };
        }
        rendered += raw;
      }
    }
  }

  let result = renderConditionals(0).rendered;
  const varRegex = /\{\{(\w+)\}\}/g;
  result = result.replace(varRegex, (match, key) => {
    const value = data[key];
    return value !== undefined && value !== null ? String(value) : match;
  });

  return result;
}

export async function handleTemplate(
  templatePath: string,
  data: Record<string, any> = {},
  { fileExtra, routerPrefix }: { fileExtra: string; routerPrefix: string } = {
    fileExtra: '',
    routerPrefix: '',
  },
) {
  const files: Record<string, string> = {};
  const templateFiles = await recursive(templatePath);
  templateFiles.forEach(filePath => {
    const file = filePath.replace(`${templatePath}/`, '');
    if (IgnoreFiles.includes(file)) {
      return;
    }
    if (fs.statSync(filePath).isFile()) {
      if (file.endsWith('.handlebars')) {
        files[
          `${routerPrefix}${file
            .replace('.handlebars', fileExtra)
            .replace('npmrc', '.npmrc')}`.replace('language', 'ts')
        ] = renderTemplate(fs.readFileSync(filePath, 'utf-8'), data);
      } else {
        files[`${routerPrefix}${file}`] = `${fs.readFileSync(
          filePath,
          'utf-8',
        )}`;
      }
    }
  });
  return files;
}

async function handleCodesandboxTemplate() {
  const templateDir = path.join(import.meta.dirname, 'codesandbox');
  const files: Record<string, string> = {
    ...(await handleTemplate(templateDir)),
  };

  return files;
}

function resolvePackageRoot(entryPath: string, packageName: string): string {
  let directory = path.dirname(entryPath);

  while (directory !== path.dirname(directory)) {
    const packageJsonPath = path.join(directory, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson.name === packageName) {
        return directory;
      }
    }
    directory = path.dirname(directory);
  }

  throw new Error(`Unable to resolve package root for ${packageName}.`);
}

async function handleCreateTemplate() {
  const createPackageMainPath = require.resolve('@modern-js/create');
  const createPackagePath = resolvePackageRoot(
    createPackageMainPath,
    '@modern-js/create',
  );
  const createPackageJsonPath = path.join(createPackagePath, 'package.json');

  const templateDir = path.join(createPackagePath, 'template');

  const createPackageJson = JSON.parse(
    fs.readFileSync(createPackageJsonPath, 'utf-8'),
  );
  const version = createPackageJson.version || '3.0.0';

  const files = await handleTemplate(templateDir, {
    packageName: 'modern-app',
    version,
    // Online demos omit repository-level linting and formatting tools.
    isSubproject: true,
  });

  return files;
}

async function main() {
  const codesandboxFiles = await handleCodesandboxTemplate();
  const createFiles = await handleCreateTemplate();
  const srcTemplatesDir = path.join(import.meta.dirname, '..', 'src/templates');
  const commonFiles = { ...codesandboxFiles };
  fs.writeFileSync(
    path.join(srcTemplatesDir, 'common.ts'),
    `export const commonFiles = ${JSON.stringify(commonFiles, null, 2)};`,
    'utf-8',
  );
  const mwaFiles = createFiles;
  fs.writeFileSync(
    path.join(srcTemplatesDir, 'mwa.ts'),
    `import { commonFiles } from './common';

export const MWAFiles = {
  ...commonFiles,
  ...${JSON.stringify(mwaFiles, null, 2)}
};`,
    'utf-8',
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
