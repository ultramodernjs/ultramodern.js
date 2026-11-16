import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'path';
import {
  chokidar,
  cleanRequireCache,
  compatibleRequire,
  type FSWatcher,
  tryResolve,
} from '../src';

describe('compat require', () => {
  const fixturePath = path.resolve(__dirname, './fixtures/compat-require');

  test(`should support default property`, async () => {
    expect(await compatibleRequire(path.join(fixturePath, 'esm.js'))).toEqual({
      name: 'esm',
    });
  });

  test(`should support commonjs module`, async () => {
    expect(await compatibleRequire(path.join(fixturePath, 'cjs.js'))).toEqual({
      name: 'cjs',
    });
  });

  test(`should return null`, async () => {
    expect(await compatibleRequire(path.join(fixturePath, 'empty.js'))).toEqual(
      null,
    );
  });

  test('resolves ESM packages in directories containing URL-encoded characters', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modern-RUNNER~1 % # č-'),
    );
    const previousFormat = process.env.MODERN_LIB_FORMAT;
    try {
      const packageDirectory = path.join(directory, 'node_modules/example');
      fs.mkdirSync(packageDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(packageDirectory, 'package.json'),
        JSON.stringify({ type: 'module', exports: './index.mjs' }),
      );
      const modulePath = path.join(packageDirectory, 'index.mjs');
      fs.writeFileSync(modulePath, 'export default "resolved";');
      process.env.MODERN_LIB_FORMAT = 'esm';

      const resolved = tryResolve('example', directory);
      expect(resolved).toBe(fs.realpathSync(modulePath));
      expect((await import(pathToFileURL(resolved).href)).default).toBe(
        'resolved',
      );
    } finally {
      if (previousFormat === undefined) {
        delete process.env.MODERN_LIB_FORMAT;
      } else {
        process.env.MODERN_LIB_FORMAT = previousFormat;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('should clean cache after fn', () => {
    const requirePath = require.resolve('./fixtures/compat-require/foo.js');
    const cachedModule = {
      id: requirePath,
      filename: requirePath,
      loaded: true,
      exports: { name: 'foo' },
      children: [],
      paths: [],
    } as unknown as NodeModule;

    require.cache[requirePath] = cachedModule;
    expect(require.cache[requirePath]).toBeDefined();

    cleanRequireCache([requirePath]);

    const shouldClean = process.env.MODERN_LIB_FORMAT !== 'esm';
    expect(Boolean(require.cache[requirePath])).toBe(!shouldClean);

    delete require.cache[requirePath];
  });
});

function watchEvent(watcher: FSWatcher, event: 'ready' | 'change') {
  let cancel = () => {};
  const promise = new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error(`Watcher missed ${event}`)),
      10000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      watcher.off(event, done);
      watcher.off('error', fail);
    };
    cancel = cleanup;
    const done = (filename?: string) => {
      cleanup();
      resolve(filename);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    watcher.once(event, done);
    watcher.once('error', fail);
  });
  return { promise, cancel: () => cancel() };
}

// Chokidar may retire native handles before `close()` (macOS closes its
// one-shot exact-file fallback on the first event), so closure is recorded
// from creation and every handle must be closed once shutdown completes.
async function allNativeWatchersClosed(closes: Promise<void>[]) {
  let timer: NodeJS.Timeout | undefined;
  let closed = 0;
  try {
    await Promise.race([
      Promise.all(closes.map(close => close.then(() => void closed++))),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${closes.length - closed} of ${closes.length} native watchers stayed open`,
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeFromNode(
  filename: string,
  changed: Promise<string | undefined>,
) {
  const writer = spawn(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'after');",
      filename,
    ],
    { stdio: 'ignore' },
  );
  const closed = new Promise<void>((resolve, reject) => {
    let writerError: Error | undefined;
    writer.once('error', error => {
      writerError = error;
    });
    writer.once('close', (code, signal) => {
      if (writerError) reject(writerError);
      else if (code === 0) resolve();
      else reject(new Error(`Writer failed (${signal ?? code})`));
    });
  });
  try {
    const [, result] = await Promise.all([closed, changed]);
    return result;
  } finally {
    if (writer.exitCode === null && writer.signalCode === null)
      writer.kill('SIGKILL');
    await closed.catch(() => {});
  }
}

describe('lazy compiled watcher imports', () => {
  test('source export defers Chokidar and preserves native external change/close', async () => {
    const owningRequire = createRequire(
      path.resolve(__dirname, '../package.json'),
    );
    const compiledFilename = owningRequire.resolve(
      './compiled/chokidar/index.mjs',
    );
    expect(owningRequire.cache[compiledFilename]).toBeUndefined();
    const directory = fs.mkdtempSync(
      path.join(
        process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
        'modern-lazy-source-watcher-',
      ),
    );
    const originalWatch = fs.watch;
    const nativeClosed: Promise<void>[] = [];
    let watcher: FSWatcher | undefined;
    try {
      fs.watch = new Proxy(originalWatch, {
        apply(target, receiver, args) {
          const nativeWatcher: fs.FSWatcher = Reflect.apply(
            target,
            receiver,
            args,
          );
          nativeClosed.push(
            new Promise(resolve => nativeWatcher.once('close', resolve)),
          );
          return nativeWatcher;
        },
      });
      syncBuiltinESMExports();
      const filename = path.join(directory, 'input.txt');
      fs.writeFileSync(filename, 'before');
      watcher = chokidar.watch(filename, { ignoreInitial: true });
      expect(watcher).toBeInstanceOf(chokidar.FSWatcher);
      await watchEvent(watcher, 'ready').promise;
      expect(owningRequire.cache[compiledFilename]?.loaded).toBe(true);
      expect(nativeClosed.length).toBeGreaterThan(0);
      const changed = watchEvent(watcher, 'change');
      try {
        expect(await writeFromNode(filename, changed.promise)).toBe(filename);
      } finally {
        changed.cancel();
      }
      await watcher.close();
      await allNativeWatchersClosed(nativeClosed);
      expect(watcher).toEqual(expect.objectContaining({ closed: true }));
    } finally {
      try {
        await watcher?.close();
      } finally {
        fs.watch = originalWatch;
        syncBuiltinESMExports();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test.each(['cjs', 'esm'] as const)(
    'cold public %s import defers Chokidar and observes native external changes',
    async format => {
      const directory = fs.mkdtempSync(
        path.join(
          process.env.OWNED_TEMP_DIR ?? os.tmpdir(),
          'modern-lazy-public-watcher-',
        ),
      );
      const owner = path.resolve(__dirname, '../package.json');
      // A separate normal Node process proves cold published require/import
      // conditions; this never aliases public exports to utility source files.
      const script = `
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, registerHooks, syncBuiltinESMExports } = require('node:module');
const owningRequire = createRequire(${JSON.stringify(owner)});
const directory = ${JSON.stringify(directory)};
const initialized = [];
const originalWatch = fs.watch;
const nativeClosed = [];
fs.watch = new Proxy(originalWatch, { apply(target, receiver, args) {
  const watcher = Reflect.apply(target, receiver, args);
  nativeClosed.push(new Promise(resolve => watcher.once('close', resolve)));
  return watcher;
} });
syncBuiltinESMExports();
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.includes('/compiled/chokidar/')) initialized.push(url);
  return nextLoad(url, context);
} });
const wait = (watcher, event) => {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); watcher.off(event, done); watcher.off('error', fail); };
    cancel = cleanup;
    const done = filename => { cleanup(); resolve(filename); };
    const fail = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error('Watcher missed ' + event)), 10000);
    watcher.once(event, done); watcher.once('error', fail);
  });
  return { promise, cancel: () => cancel() };
};
const allNativeWatchersClosed = async () => {
  let timer;
  let closed = 0;
  try {
    await Promise.race([
      Promise.all(nativeClosed.map(close => close.then(() => { closed++; }))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((nativeClosed.length - closed) + ' of ' + nativeClosed.length + ' native watchers stayed open')), 10000);
      }),
    ]);
  } finally { clearTimeout(timer); }
};
const writeFromNode = async (filename, changed) => {
  const writer = spawn(process.execPath, [
    '--input-type=commonjs', '-e',
    "require('node:fs').writeFileSync(process.argv[1], 'after');", filename
  ], { stdio: 'ignore' });
  const closed = new Promise((resolve, reject) => {
    let writerError;
    writer.once('error', error => { writerError = error; });
    writer.once('close', (code, signal) => {
      if (writerError) reject(writerError);
      else if (code === 0) resolve();
      else reject(new Error('Writer failed (' + (signal ?? code) + ')'));
    });
  });
  try {
    const [, result] = await Promise.all([closed, changed]);
    return result;
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
    await closed.catch(() => {});
  }
};
(async () => {
  let watcher;
  try {
    const utils = ${format === 'cjs' ? "owningRequire('@modern-js/utils')" : "await import('@modern-js/utils')"};
    assert.deepEqual(initialized, [], 'metadata import initialized Chokidar');
    assert.equal(nativeClosed.length, 0, 'metadata import started native watching');
    assert.ok(Array.isArray(utils.CONFIG_FILE_EXTENSIONS));
    assert.deepEqual(initialized, [], 'constant access initialized Chokidar');
    assert.equal(nativeClosed.length, 0, 'constant access started native watching');
    const filename = path.join(directory, 'input.txt');
    fs.writeFileSync(filename, 'before');
    watcher = utils.chokidar.watch(filename, { ignoreInitial: true });
    assert.ok(watcher instanceof utils.chokidar.FSWatcher);
    await wait(watcher, 'ready').promise;
    assert.ok(initialized.length > 0, 'watching did not initialize Chokidar');
    assert.ok(nativeClosed.length > 0, 'watching did not call native fs.watch');
    const changed = wait(watcher, 'change');
    try {
      assert.equal(await writeFromNode(filename, changed.promise), filename);
    } finally { changed.cancel(); }
    await watcher.close();
    await allNativeWatchersClosed();
    assert.equal(watcher.closed, true);
    process.stdout.write(JSON.stringify({ format: ${JSON.stringify(format)}, changed: true, closed: watcher.closed, nativeWatchers: nativeClosed.length }));
  } finally {
    try { await watcher?.close(); } finally {
      fs.watch = originalWatch;
      syncBuiltinESMExports();
      hooks.deregister();
    }
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--input-type=commonjs', '-e', script],
            {
              cwd: path.dirname(owner),
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
          child.stdout.on('data', value => {
            stdout += value;
          });
          child.stderr.on('data', value => {
            stderr += value;
          });
          child.once('error', reject);
          child.once('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else
              reject(
                new Error(`Cold ${format} watcher failed (${code}): ${stderr}`),
              );
          });
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
          format,
          changed: true,
          closed: true,
          nativeWatchers: expect.any(Number),
        });
        expect(result.nativeWatchers).toBeGreaterThan(0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
