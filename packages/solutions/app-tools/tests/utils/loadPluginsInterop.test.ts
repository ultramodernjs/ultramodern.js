import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInternalPlugins } from '../../src/utils/loadPlugins';

const withPlugin = async (
  fileName: string,
  source: string,
  run: (directory: string, plugin: string) => Promise<void>,
) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-plugin #'));
  const plugin = path.join(directory, fileName);
  try {
    fs.writeFileSync(plugin, source);
    await run(directory, plugin);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

it('loads async ESM CLI plugins from paths containing URL delimiters', () =>
  withPlugin(
    'async-plugin.mjs',
    'await Promise.resolve(); export default { name: "async-plugin" };',
    async (directory, plugin) => {
      await expect(
        loadInternalPlugins(directory, {
          'async-plugin': { path: plugin, forced: true },
        }),
      ).resolves.toEqual([{ name: 'async-plugin' }]);
    },
  ));

it('surfaces the original error of a CJS plugin that throws', () =>
  withPlugin(
    'broken-plugin.cjs',
    // Count evaluations: a retry through another loader would report `#2`.
    'globalThis.__brokenPluginRuns = (globalThis.__brokenPluginRuns ?? 0) + 1;' +
      'throw new Error("broken plugin #" + globalThis.__brokenPluginRuns);',
    async (directory, plugin) => {
      await expect(
        loadInternalPlugins(directory, {
          'broken-plugin': { path: plugin, forced: true },
        }),
      ).rejects.toThrow('broken plugin #1');
      expect((globalThis as any).__brokenPluginRuns).toBe(1);
    },
  ));
