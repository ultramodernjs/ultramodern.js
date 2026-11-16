import FsBackendModule from 'i18next-fs-backend';
import type { ExtendedBackendOptions } from '../../../shared/type';
import type { I18nRuntimeInstance } from '../instance';
import { useI18nextBackendCommon } from './middleware.common';

type BackendConstructor = new (...args: any[]) => any;

export const resolveFsBackendConstructor = (
  backendModule: unknown,
): BackendConstructor => {
  const nestedDefault = (backendModule as { default?: { default?: unknown } })
    ?.default?.default;
  const nestedModuleExports = (
    backendModule as { default?: { 'module.exports'?: unknown } }
  )?.default?.['module.exports'];
  const candidates = [
    backendModule,
    (backendModule as { default?: unknown })?.default,
    (backendModule as { 'module.exports'?: unknown })?.['module.exports'],
    nestedDefault,
    nestedModuleExports,
  ];
  const Backend = candidates.find(candidate => typeof candidate === 'function');

  if (!Backend) {
    throw new Error(
      'Failed to resolve i18next-fs-backend constructor for the i18n Node backend.',
    );
  }

  return Backend as BackendConstructor;
};

const Backend = resolveFsBackendConstructor(FsBackendModule);

/**
 * Wrapper for FS backend to add a no-op save method
 * This is required for i18next-chained-backend to trigger refresh logic
 * when cacheHitMode is 'refresh' or 'refreshAndUpdateStore'
 */
export class FsBackendWithSave extends Backend {
  save(_language: string, _namespace: string, _data: unknown): void {
    // No-op: FS backend doesn't need to save in this context, but we need this method
    // to trigger i18next-chained-backend's refresh logic
  }
}

// Export as HttpBackendWithSave for consistency with browser version
// This allows utils.ts to import the same name in both environments
export const HttpBackendWithSave = FsBackendWithSave;

export const useI18nextBackend = (
  i18nInstance: I18nRuntimeInstance,
  backend?: ExtendedBackendOptions,
) => {
  return useI18nextBackendCommon(
    i18nInstance,
    FsBackendWithSave,
    Backend,
    backend,
  );
};
