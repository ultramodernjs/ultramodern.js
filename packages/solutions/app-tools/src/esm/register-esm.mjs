import { createNativeModuleCache } from '@modern-js/app-tools-extensions/config';

let registeredPathHooks;

export const registerPathsLoader = async ({ appDir, baseUrl, paths }) => {
  const { register, registerHooks } = await import('node:module');

  if (typeof registerHooks === 'function') {
    const loader = await import('./ts-paths-loader.mjs');

    await loader.initialize({
      appDir,
      baseUrl,
      paths,
    });

    if (!registeredPathHooks) {
      const cache = createNativeModuleCache(appDir);
      const hooks = registerHooks({
        resolve: (specifier, context, nextResolve) =>
          cache.resolve(specifier, context, (value, currentContext) =>
            loader.resolve(value, currentContext, nextResolve),
          ),
        load: cache.load,
      });
      registeredPathHooks = {
        deregister() {
          hooks.deregister();
          cache.dispose();
          registeredPathHooks = undefined;
        },
      };
    }

    return registeredPathHooks;
  }

  register('./ts-paths-loader.mjs', import.meta.url, {
    data: {
      appDir,
      baseUrl,
      paths,
    },
  });
};
