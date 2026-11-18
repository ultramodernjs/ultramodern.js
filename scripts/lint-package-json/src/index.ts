import { globSync } from 'node:fs';
import logger from 'consola';
import fs from 'fs-extra';
import { join } from 'path';
import { lintExportsField } from './rules/lintExportsField';
import { lintWorkspaceProtocol } from './rules/lintWorkspaceProtocol';
import { noCyclicWorkspaceDependencies } from './rules/noCyclicWorkspaceDependencies';
import { ROOT } from './utils';

export type PackageJSON = {
  path: string;
  content: {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: any;
  };
};

async function getAllPackageJson(): Promise<PackageJSON[]> {
  const files = globSync('packages/**/package.json', {
    cwd: ROOT,
    exclude: ['**/node_modules/**'],
  }).map(file => join(ROOT, file));

  const contents = await Promise.all(files.map(file => fs.readJsonSync(file)));

  return files.map((file, index) => ({
    path: file,
    content: contents[index],
  }));
}

async function run() {
  const packageJSONs = await getAllPackageJson();
  const result = [
    lintExportsField(packageJSONs),
    lintWorkspaceProtocol(packageJSONs),
    noCyclicWorkspaceDependencies(packageJSONs),
  ];

  if (result.some(Boolean)) {
    logger.fatal('Lint package.json failed, please fix the errors.');
    process.exit(1);
  } else {
    logger.success('Lint package.json passed.');
  }
}

run();
