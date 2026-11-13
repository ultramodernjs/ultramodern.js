import type { FileReader } from '@modern-js/runtime-utils/fileReader';
import type { ServerPluginHooks } from '@modern-js/server-core';

const cleanSSRCache = (distDir: string) => {
  Object.keys(require.cache).forEach(key => {
    if (key.startsWith(distDir)) {
      delete require.cache[key];
    }
  });
};

/**
 * Reset the dev server after the server bundle is rebuilt.
 *
 * Runtime state a rebuilt bundle keeps outside the require cache belongs to
 * the plugin that owns it and is reset by that plugin's `onReset` handler:
 * `@module-federation/modern-js-v3/server` resets the Module Federation
 * runtime on `globalThis` there (module-federation/core#5152).
 *
 * Contract: the `onReset({ event: { type: 'repack' } })` handlers run in
 * registration order and are awaited before the previous generation is purged.
 * The caller holds new requests until this promise settles, so no request
 * re-requires the bundle while a handler is still running. As with every async
 * server hook, a rejecting handler skips the handlers after it; the generation
 * is still purged and the promise rejects with that error.
 */
export const onRepack = async (
  distDir: string,
  hooks: ServerPluginHooks,
  reader: FileReader,
) => {
  try {
    await hooks.onReset.call({
      event: {
        type: 'repack',
      },
    });
  } finally {
    cleanSSRCache(distDir);
    reader.reset();
  }
};
