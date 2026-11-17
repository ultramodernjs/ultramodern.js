import type { AppTools, BffCompilation } from '@modern-js/app-tools';
import type { CLIPluginAPI } from '@modern-js/plugin';
import {
  type SerializedServerGlobalVars,
  serializeServerGlobalVars,
} from '@modern-js/plugin-bff-extensions/server-global-vars';
import type { BffRuntimeBuildIdentity } from './runtime-build-identity';
import { transformServerGlobalVars } from './server-global-vars';

export function registerBffCompilation(api: CLIPluginAPI<AppTools>) {
  const serialized = new WeakMap<BffCompilation, SerializedServerGlobalVars>();
  api.onBeforeBffCompile(context => {
    serialized.set(
      context,
      serializeServerGlobalVars(api.getNormalizedConfig().source.globalVars),
    );
  });
  api.onAfterBffCompile(async (context, result) => {
    const globals = serialized.get(context);
    if (!globals)
      throw new Error('BFF compilation completed without its before hook.');
    serialized.delete(context);
    const appContext = api.getAppContext();
    const resolveIdentity = appContext.resolveBffRuntimeBuildIdentity;
    if (appContext.apiOnly !== true && resolveIdentity !== undefined) {
      if (appContext.appDirectory !== context.appDirectory) {
        throw new Error(
          'BFF runtime build identity provider does not belong to this application.',
        );
      }
      if (typeof resolveIdentity !== 'function') {
        throw new Error('BFF runtime build identity provider is invalid.');
      }
      const identity: BffRuntimeBuildIdentity = await resolveIdentity(context);
      if (
        identity === null ||
        typeof identity !== 'object' ||
        !Object.isFrozen(identity)
      ) {
        throw new Error('BFF runtime build identity must be immutable.');
      }
      const { buildMarker, sourceRevision } = identity;
      if (
        typeof buildMarker !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(buildMarker) ||
        typeof sourceRevision !== 'string' ||
        sourceRevision.trim().length === 0
      ) {
        throw new Error('BFF runtime build identity is not finalized.');
      }
      globals.ULTRAMODERN_BUILD_MARKER = JSON.stringify(buildMarker);
      globals.ULTRAMODERN_SOURCE_REVISION = JSON.stringify(sourceRevision);
    }
    await transformServerGlobalVars(result.emittedFiles, globals);
    if (api.getAppContext().bffRuntimeFramework !== 'effect') return;
    // Hosted APIs use the producer's compiled entry; it is not emitted by this app.
    if (api.getNormalizedConfig().bff?.isCrossProjectServer === true) return;
    const { bundleBuiltEffectEntryForNode } = await import(
      '@modern-js/plugin-bff-extensions/effect-source-loader'
    );
    await bundleBuiltEffectEntryForNode({
      appDir: context.appDirectory,
      apiDir: context.apiDirectory,
      distDir: context.distDirectory,
      effectEntry: api.getNormalizedConfig().bff?.effect?.entry,
      format: context.moduleType === 'module' ? 'esm' : 'cjs',
    });
  });
}
