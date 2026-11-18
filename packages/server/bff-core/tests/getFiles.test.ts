import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { API_FILE_RULES } from '../src/router/constants';
import { getFiles } from '../src/router/utils';

const writeTree = (dir: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
};

describe('getFiles', () => {
  let root: string;
  let lambdaDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-bff-routes-'));
    lambdaDir = path.join(root, 'dist', 'api', 'lambda');
    fs.mkdirSync(lambdaDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const found = (rules: string | string[]) =>
    getFiles(lambdaDir, rules)
      .map(file => path.relative(lambdaDir, file).split(path.sep).join('/'))
      .sort();

  test('returns handler files without excluded, hidden or directory entries', () => {
    writeTree(lambdaDir, {
      'index.ts': '',
      'user/[id].ts': '',
      'nested/deep/list.js': '',
      '_private.ts': '',
      '_shared/helper.ts': '',
      'user.test.ts': '',
      'types.d.ts': '',
      'node_modules/dep.js': '',
      '.hidden.ts': '',
      '.cache/cached.ts': '',
      'folder.ts/readme.md': '',
      'readme.md': '',
    });

    expect(found(API_FILE_RULES)).toEqual([
      'index.ts',
      'nested/deep/list.js',
      'user/[id].ts',
    ]);
    expect(getFiles(lambdaDir, 'index.ts')).toEqual([
      path.join(lambdaDir, 'index.ts'),
    ]);
  });

  test('applies the .gitignore files inside the API directory only', () => {
    fs.mkdirSync(path.join(root, '.git'));
    writeTree(root, { '.gitignore': 'dist/\n' });
    writeTree(lambdaDir, {
      '.gitignore': 'ignored.js\nbuild/\n',
      'index.js': '',
      'ignored.js': '',
      'nested/ignored.js': '',
      'build/out.js': '',
      'generated/.gitignore': '*.js\n!keep.js\n',
      'generated/drop.js': '',
      'generated/keep.js': '',
    });

    expect(found('**/*.js')).toEqual(['generated/keep.js', 'index.js']);
  });
});
