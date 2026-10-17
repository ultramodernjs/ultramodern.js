import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const browserFiles = {
  'solid-js': 'dist/solid.js',
  '@solidjs/web': 'dist/web.js',
  '@solidjs/signals': 'dist/prod/index.js',
};
const within = (root, file) => file.startsWith(`${root}${path.sep}`);

export function compilationModules(stats) {
  assert.equal(
    stats.schema,
    1,
    'Missing standard native build module diagnostic',
  );
  const clients = stats.compilations.filter(
    compilation => compilation.name === 'client',
  );
  assert.equal(clients.length, 1, 'Expected one actual client compilation');
  const modules = [];
  const visit = records => {
    for (const record of records ?? []) {
      if (record.nameForCondition) modules.push(record.nameForCondition);
      visit(record.modules);
    }
  };
  visit(clients[0].modules);
  assert(
    modules.length > 0,
    'Actual client compilation has no module resources',
  );
  return modules;
}

/** Prove browser conditions and one physical native owner in real build stats. */
export async function checkSolidBundleModules({ appRoot, entries }) {
  const statsFile = path.join(appRoot, 'dist/solid-consumer-modules.json');
  const resources = compilationModules(
    JSON.parse(await fs.readFile(statsFile, 'utf8')),
  );
  const requireApp = createRequire(path.join(appRoot, 'package.json'));
  const owners = {};
  for (const [name, entry] of Object.entries(browserFiles)) {
    let owner = path.dirname(await fs.realpath(requireApp.resolve(name)));
    for (;;) {
      const manifest = await fs
        .readFile(path.join(owner, 'package.json'), 'utf8')
        .then(JSON.parse, error => {
          if (error.code !== 'ENOENT') throw error;
        });
      if (manifest?.name === name) break;
      const parent = path.dirname(owner);
      assert.notEqual(parent, owner);
      owner = parent;
    }
    const pattern =
      name === 'solid-js'
        ? /[\\/]solid-js[\\/]/u
        : name === '@solidjs/web'
          ? /[\\/]@solidjs[\\/]web[\\/]/u
          : /[\\/]@solidjs[\\/]signals[\\/]/u;
    const selected = resources.filter(resource => pattern.test(resource));
    assert(selected.length > 0, `Client bundle omitted native ${name}`);
    for (const resource of selected)
      assert(
        within(owner, await fs.realpath(resource)),
        `Client bundle contains another ${name} owner: ${resource}`,
      );
    assert(
      selected.some(
        resource => path.normalize(resource) === path.join(owner, entry),
      ),
      `Client bundle selected wrong browser/production condition for ${name}`,
    );
    assert(
      !selected.some(resource =>
        /[\\/]server(?:[.\\/])|[.]dev[.]|[\\/]dev[\\/]/u.test(
          path.relative(owner, resource),
        ),
      ),
      `Client bundle contains a server/development ${name} entry`,
    );
    owners[name] = { root: owner, resources: [...new Set(selected)] };
  }
  for (const entry of entries.filter(
    file => path.basename(file) === 'index.ts',
  ))
    assert(
      resources.includes(entry),
      `Actual browser bundle omitted generated entry ${entry}`,
    );
  return { diagnostic: statsFile, owners };
}
