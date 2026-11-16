import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const fixtureRequire = createRequire(
  new URL(
    '../../tests/integration/routes-tanstack-mf/mf-host/package.json',
    import.meta.url,
  ),
);
const require = createRequire(
  fixtureRequire.resolve('@module-federation/modern-js-v3'),
);
const packageRoot =
  process.env.ULTRAMODERN_DTS_PACKAGE_ROOT ??
  path.dirname(path.dirname(require.resolve('@module-federation/dts-plugin')));

const exposeRpcChunk = format => {
  const directory = path.join(
    packageRoot,
    format === 'esm' ? 'dist/esm' : 'dist',
  );
  const filename = fs
    .readdirSync(directory)
    .find(
      name =>
        name.startsWith('expose-rpc-') &&
        name.endsWith(format === 'esm' ? '.mjs' : '.js'),
    );
  assert.ok(filename);
  return path.join(directory, filename);
};

// The Broker chunk's `listen(server, port)`: binds and settles once
// listening, rejecting with the bind error (module-federation/core#5159).
const brokerListen = format => {
  const directory = path.join(
    packageRoot,
    format === 'esm' ? 'dist/esm' : 'dist',
  );
  const filename = fs
    .readdirSync(directory)
    .find(
      name =>
        name.startsWith('Broker-') &&
        name.endsWith(format === 'esm' ? '.mjs' : '.js'),
    );
  assert.ok(filename);
  const source = fs.readFileSync(path.join(directory, filename), 'utf8');
  const start = source.indexOf('function listen(server, port) {');
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`);
};

const getStatus = url =>
  new Promise((resolve, reject) => {
    http
      .get(url, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      })
      .on('error', reject);
  });

for (const format of ['esm', 'cjs']) {
  // Unpatched 2.9.2 probes a port with getFreePort(), closes the probe and
  // then listens on that number with no error listener. When another
  // producer binds the port in between, EADDRINUSE is thrown as an uncaught
  // exception and takes down the forked DTS worker. The stale probe is
  // simulated deterministically: getFreePort hands out a port that is
  // already bound, and the patched server must not ask for it at all.
  test(`${format} DTS type servers bind before publishing their port`, async () => {
    const source = fs.readFileSync(exposeRpcChunk(format), 'utf8');
    const start = source.indexOf('//#region src/server/createHttpServer.ts');
    assert.notEqual(start, -1);
    const end = source.indexOf('//#endregion', start);
    let takenPort;
    const getFreePort = async () => takenPort;
    const getIPV4 = () => '127.0.0.1';
    const DEFAULT_TAR_NAME = '@mf-types.zip';
    const listen = brokerListen(format);
    const createHttpServer = vm.runInNewContext(
      `${source.slice(start, end)}\ncreateHttpServer;`,
      {
        http: { ...http, default: http },
        fs: { ...fs, default: fs },
        getFreePort,
        getIPV4,
        listen,
        DEFAULT_TAR_NAME,
        require_Broker: { getFreePort, getIPV4, listen },
        require_Action: { DEFAULT_TAR_NAME },
      },
    );
    // Bind the competitor only once the chunk evaluated, so a setup failure
    // cannot leave a listener keeping the test process alive.
    const competitor = net.createServer();
    await new Promise(resolve => competitor.listen(0, resolve));
    takenPort = competitor.address().port;

    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    const servers = [];
    try {
      const typeTarPath = path.join(packageRoot, 'package.json');
      servers.push(
        ...(await Promise.all([
          createHttpServer({ typeTarPath }),
          createHttpServer({ typeTarPath }),
        ])),
      );
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(uncaught, []);
      const ports = servers.map(({ server, serverAddress }) => {
        assert.equal(server.listening, true);
        const { port } = server.address();
        assert.equal(new URL(serverAddress).port, String(port));
        return port;
      });
      assert.equal(new Set([takenPort, ...ports]).size, 3);
      for (const port of ports) {
        assert.equal(await getStatus(`http://127.0.0.1:${port}/missing`), 404);
      }
    } finally {
      process.off('uncaughtException', onUncaught);
      await Promise.all(
        [competitor, ...servers.map(({ server }) => server)].map(
          server => new Promise(resolve => server.close(() => resolve())),
        ),
      );
    }
  });

  test(`${format} DTS launches native Windows compilers without shell parsing`, () => {
    const source = fs.readFileSync(exposeRpcChunk(format), 'utf8');
    const executables = new Set([
      String.raw`C:\Program Files\Effect & TypeScript\tsc.exe`,
      String.raw`\\compiler-server\Effect TS\tsc.exe`,
    ]);
    const existsSync = filename => executables.has(filename);
    const resolveCompilerCommand = vm.runInNewContext(
      `${source.slice(source.indexOf('const getPMFromUserAgent ='), source.indexOf('const compileTs ='))}\nresolveCompilerCommand;`,
      {
        path: path.win32,
        isAbsolute: path.win32.isAbsolute,
        fs: { existsSync },
        existsSync,
        process: { platform: 'win32', env: {} },
      },
    );
    const tsconfig = String.raw`C:\My workspace\tsconfig.json`;
    for (const executable of executables) {
      const command = resolveCompilerCommand(
        { compilerInstance: executable },
        tsconfig,
      );
      assert.equal(command.executable, executable);
      assert.equal(command.shell, false);
      assert.deepEqual(Array.from(command.args), ['--project', tsconfig]);
    }
    const packageCommand = resolveCompilerCommand(
      { compilerInstance: 'vue-tsc --emitDeclarationOnly' },
      tsconfig,
    );
    assert.equal(packageCommand.executable, 'npx');
    assert.deepEqual(Array.from(packageCommand.args), [
      'vue-tsc',
      '--emitDeclarationOnly',
      '--project',
      tsconfig,
    ]);
  });
}
