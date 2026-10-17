import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, rstest } from '@rstest/core';
import { resolveNativeWorkerContextProfiles } from '../../src/native-composition/native-worker-context-profiles';

const directories: string[] = [];

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'worker-profiles-'),
    ),
  );
  directories.push(root);
  const appDirectory = path.join(root, 'app');
  fs.mkdirSync(appDirectory);
  const marker = path.join(root, 'profile-executed');
  const configMarker = path.join(root, 'config-executed');
  fs.writeFileSync(
    path.join(appDirectory, 'modern.config.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(configMarker)}, 'executed');
throw new Error('Configuration must not execute during profile preflight.');`,
  );
  const writeProfile = (relative: string, owner = appDirectory) => {
    const file = path.resolve(owner, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write =
      path.extname(file) === '.cjs' || path.extname(file) === '.cts'
        ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`
        : `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');`;
    fs.writeFileSync(
      file,
      `${write}\nthrow new Error('Profile must not execute during preflight.');`,
    );
    return file;
  };
  const expectNoEvaluation = () => {
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(configMarker)).toBe(false);
  };
  return { root, appDirectory, writeProfile, expectNoEvaluation };
}

afterEach(async () => {
  rstest.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map(directory =>
        fsPromises.rm(directory, { recursive: true, force: true }),
      ),
  );
});

it.each([{ value: undefined }, { value: [] }])(
  'returns frozen empty imports without filesystem work for %j',
  async ({ value }) => {
    const realpath = rstest.spyOn(fsPromises, 'realpath');
    const stat = rstest.spyOn(fsPromises, 'stat');
    const result = await resolveNativeWorkerContextProfiles(
      value,
      '/missing/application',
    );
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  },
);

it('accepts every supported source extension in declared order without evaluating code', async () => {
  const app = fixture();
  const modules = [
    'ts',
    'tsx',
    'mts',
    'cts',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'tsrx',
  ].map(extension => `./profiles/context.${extension}`);
  const expected = modules.map(module => app.writeProfile(module));
  const stat = rstest.spyOn(fsPromises, 'stat');
  const result = await resolveNativeWorkerContextProfiles(
    modules,
    app.appDirectory,
  );
  expect(result).toEqual(expected);
  expect(Object.isFrozen(result)).toBe(true);
  for (const file of expected)
    expect(stat).toHaveBeenCalledWith(file, { bigint: true });
  app.expectNoEvaluation();
});

it('canonicalizes an application-directory symlink and an internal source-file alias', async () => {
  const app = fixture();
  const original = app.writeProfile('./profiles/original.mjs');
  fs.symlinkSync(original, path.join(app.appDirectory, 'profiles/alias.ts'));
  const appAlias = path.join(app.root, 'application-link');
  fs.symlinkSync(app.appDirectory, appAlias, 'dir');
  expect(
    await resolveNativeWorkerContextProfiles(['./profiles/alias.ts'], appAlias),
  ).toEqual([original]);
  app.expectNoEvaluation();
});

it.each(
  [
    null,
    {},
    './profile.ts',
    42,
    [undefined],
    [null],
    [{}],
    new Array(1),
    [''],
    ['@example/profile'],
    ['https://example.com/profile.ts'],
    ['file:///tmp/profile.ts'],
    ['/tmp/profile.ts'],
    ['C:/profiles/context.ts'],
    ['../profile.ts'],
    ['./profiles/../context.ts'],
    ['./profiles\\context.ts'],
    ['./context.ts?mode=worker'],
    ['./context.ts#profile'],
    ['./context.json'],
    ['./context.d.ts.map'],
    ['./'],
    ['./profiles//context.ts'],
    ['./profiles/./context.ts'],
    ['./context.ts\n'],
    ['./context\u0000.ts'],
    ['./C:context.ts'],
  ].map(value => ({ value })),
)(
  'rejects malformed profile configuration %j before any filesystem work',
  async ({ value }) => {
    const app = fixture();
    const valid = './profiles/valid.mjs';
    app.writeProfile(valid);
    const realpath = rstest.spyOn(fsPromises, 'realpath');
    const stat = rstest.spyOn(fsPromises, 'stat');
    const validPrefix: unknown[] = [valid];
    const input = Array.isArray(value) ? validPrefix.concat(value) : value;
    await expect(
      resolveNativeWorkerContextProfiles(input, app.appDirectory),
    ).rejects.toThrow();
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    app.expectNoEvaluation();
  },
);

it('rejects duplicate lexical paths before filesystem work', async () => {
  const app = fixture();
  const module = './profiles/context.mjs';
  app.writeProfile(module);
  const realpath = rstest.spyOn(fsPromises, 'realpath');
  const stat = rstest.spyOn(fsPromises, 'stat');
  await expect(
    resolveNativeWorkerContextProfiles([module, module], app.appDirectory),
  ).rejects.toThrow('duplicate module');
  expect(realpath).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  app.expectNoEvaluation();
});

it('validates indexed entries even when an array iterator hides traversal', async () => {
  const app = fixture();
  const valid = './profiles/valid.mjs';
  app.writeProfile(valid);
  const modules = [valid, '../escape.mjs'];
  let iterated = false;
  modules[Symbol.iterator] = function* () {
    iterated = true;
    yield valid;
    return undefined;
  };
  const realpath = rstest.spyOn(fsPromises, 'realpath');
  const stat = rstest.spyOn(fsPromises, 'stat');
  await expect(
    resolveNativeWorkerContextProfiles(modules, app.appDirectory),
  ).rejects.toThrow('plain ./');
  expect(iterated).toBe(false);
  expect(realpath).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  app.expectNoEvaluation();
});

it('uses the bounded array length without invoking a replacement iterator', async () => {
  const app = fixture();
  const module = './profiles/valid.mjs';
  const original = app.writeProfile(module);
  const modules = [module];
  let iterated = false;
  modules[Symbol.iterator] = function* () {
    iterated = true;
    for (let index = 0; index < 33; index++)
      yield `./profiles/extra-${index}.mjs`;
    return undefined;
  };
  expect(
    await resolveNativeWorkerContextProfiles(modules, app.appDirectory),
  ).toEqual([original]);
  expect(iterated).toBe(false);
  app.expectNoEvaluation();
});

it('rejects inherited sparse entries and accessor slots without executing them', async () => {
  const app = fixture();
  const valid = './profiles/valid.mjs';
  app.writeProfile(valid);
  const modules: unknown[] = [valid];
  modules.length = 2;
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, '1', { value: valid });
  Object.setPrototypeOf(modules, prototype);
  let accessed = false;
  const accessor = [valid];
  Object.defineProperty(accessor, '0', {
    get() {
      accessed = true;
      return valid;
    },
  });
  const realpath = rstest.spyOn(fsPromises, 'realpath');
  const stat = rstest.spyOn(fsPromises, 'stat');
  await expect(
    resolveNativeWorkerContextProfiles(modules, app.appDirectory),
  ).rejects.toThrow('plain ./');
  await expect(
    resolveNativeWorkerContextProfiles(accessor, app.appDirectory),
  ).rejects.toThrow('plain ./');
  expect(accessed).toBe(false);
  expect(realpath).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  app.expectNoEvaluation();
});

it.each(['symbolic', 'hard'])(
  'rejects %s aliases of one physical module without evaluation',
  async kind => {
    const app = fixture();
    const original = app.writeProfile('./profiles/original.mjs');
    const alias = path.join(app.appDirectory, 'profiles/alias.mjs');
    if (kind === 'symbolic') fs.symlinkSync(original, alias);
    else fs.linkSync(original, alias);
    await expect(
      resolveNativeWorkerContextProfiles(
        ['./profiles/original.mjs', './profiles/alias.mjs'],
        app.appDirectory,
      ),
    ).rejects.toThrow('same physical module');
    app.expectNoEvaluation();
  },
);

it.each(['file', 'directory'])(
  'rejects a %s symlink escaping the canonical app owner',
  async kind => {
    const app = fixture();
    const sibling = path.join(app.root, 'app-shadow');
    const outside = app.writeProfile('./outside.mjs', sibling);
    fs.mkdirSync(path.join(app.appDirectory, 'profiles'));
    const module =
      kind === 'file'
        ? './profiles/escape.ts'
        : './profiles/escape/outside.mjs';
    fs.symlinkSync(
      kind === 'file' ? outside : sibling,
      path.join(
        app.appDirectory,
        'profiles/escape' + (kind === 'file' ? '.ts' : ''),
      ),
      kind === 'file' ? 'file' : 'dir',
    );
    await expect(
      resolveNativeWorkerContextProfiles([module], app.appDirectory),
    ).rejects.toThrow('escapes its application directory');
    app.expectNoEvaluation();
  },
);

it('rejects source-looking directories and aliases to non-source files', async () => {
  const app = fixture();
  fs.mkdirSync(path.join(app.appDirectory, 'directory.ts'));
  await expect(
    resolveNativeWorkerContextProfiles(['./directory.ts'], app.appDirectory),
  ).rejects.toThrow('source file');
  const nonSource = app.writeProfile('./data.json');
  fs.symlinkSync(nonSource, path.join(app.appDirectory, 'alias.ts'));
  await expect(
    resolveNativeWorkerContextProfiles(['./alias.ts'], app.appDirectory),
  ).rejects.toThrow('source module');
  fs.symlinkSync(
    app.appDirectory,
    path.join(app.appDirectory, 'root.ts'),
    'dir',
  );
  await expect(
    resolveNativeWorkerContextProfiles(['./root.ts'], app.appDirectory),
  ).rejects.toThrow('escapes its application directory');
  app.expectNoEvaluation();
});

it.each([
  'context#fragment.ts',
  ...(process.platform === 'win32'
    ? []
    : [
        'context?mode=worker.ts',
        'context\\alias.ts',
        'context\nalias.ts',
        'context:alias.ts',
      ]),
])(
  'rejects an internal alias introducing reserved canonical characters in %j',
  async filename => {
    const app = fixture();
    const target = app.writeProfile(`./profiles/${filename}`);
    fs.symlinkSync(target, path.join(app.appDirectory, 'profiles/alias.ts'));
    await expect(
      resolveNativeWorkerContextProfiles(
        ['./profiles/alias.ts'],
        app.appDirectory,
      ),
    ).rejects.toThrow('plain source-module path');
    app.expectNoEvaluation();
  },
);

it('rejects a missing later source module without evaluating an earlier profile', async () => {
  const app = fixture();
  app.writeProfile('./profiles/valid.mjs');
  await expect(
    resolveNativeWorkerContextProfiles(
      ['./profiles/valid.mjs', './profiles/missing.mjs'],
      app.appDirectory,
    ),
  ).rejects.toThrow('ENOENT');
  app.expectNoEvaluation();
});

it('requires an application directory when profiles are configured', async () => {
  const app = fixture();
  const file = app.writeProfile('./profiles/valid.mjs');
  await expect(
    resolveNativeWorkerContextProfiles(['./profile.mjs'], file),
  ).rejects.toThrow('application directory');
  app.expectNoEvaluation();
});

it('accepts 32 modules and rejects 33 or an overlong path before filesystem work', async () => {
  const app = fixture();
  const modules = Array.from(
    { length: 32 },
    (_, index) => `./profiles/profile-${index}.mjs`,
  );
  const expected = modules.map(module => app.writeProfile(module));
  expect(
    await resolveNativeWorkerContextProfiles(modules, app.appDirectory),
  ).toEqual(expected);
  const realpath = rstest.spyOn(fsPromises, 'realpath');
  const stat = rstest.spyOn(fsPromises, 'stat');
  await expect(
    resolveNativeWorkerContextProfiles(
      [...modules, './another.mjs'],
      app.appDirectory,
    ),
  ).rejects.toThrow('at most 32');
  const overlong = './' + 'a'.repeat(4092) + '.ts';
  expect(overlong.length).toBe(4097);
  await expect(
    resolveNativeWorkerContextProfiles([overlong], app.appDirectory),
  ).rejects.toThrow('4096 characters');
  expect(realpath).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
  app.expectNoEvaluation();
});

it('waits for every source stat before returning any imports', async () => {
  const app = fixture();
  const first = app.writeProfile('./profiles/first.mjs');
  const second = app.writeProfile('./profiles/second.mjs');
  let entered!: () => void;
  const inspectedSecond = new Promise<void>(resolve => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const originalStat = fsPromises.stat;
  rstest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
    if (args[0] === second) {
      entered();
      await gate;
    }
    return originalStat(...args);
  });
  let published = false;
  const result = resolveNativeWorkerContextProfiles(
    ['./profiles/first.mjs', './profiles/second.mjs'],
    app.appDirectory,
  ).then(imports => {
    published = true;
    return imports;
  });
  try {
    await inspectedSecond;
    expect(published).toBe(false);
    app.expectNoEvaluation();
    release();
    expect(await result).toEqual([first, second]);
    expect(published).toBe(true);
    app.expectNoEvaluation();
  } finally {
    release();
    await result.catch(() => undefined);
  }
});

it('finishes other metadata work before rejecting a batch with an invalid later owner', async () => {
  const app = fixture();
  const first = app.writeProfile('./profiles/first.mjs');
  const invalid = path.join(app.appDirectory, 'profiles/invalid.mjs');
  fs.mkdirSync(invalid);
  let entered!: () => void;
  const firstStat = new Promise<void>(resolve => {
    entered = resolve;
  });
  let invalidInspected!: () => void;
  const invalidStat = new Promise<void>(resolve => {
    invalidInspected = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const originalStat = fsPromises.stat;
  rstest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
    if (args[0] === first) {
      entered();
      await gate;
    }
    const stats = await originalStat(...args);
    if (args[0] === invalid) invalidInspected();
    return stats;
  });
  let settled = false;
  const outcome = resolveNativeWorkerContextProfiles(
    ['./profiles/first.mjs', './profiles/invalid.mjs'],
    app.appDirectory,
  ).then(
    value => {
      settled = true;
      return value;
    },
    error => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.all([firstStat, invalidStat]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    app.expectNoEvaluation();
    release();
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('source file'),
      }),
    );
    app.expectNoEvaluation();
  } finally {
    release();
    await outcome;
  }
});
