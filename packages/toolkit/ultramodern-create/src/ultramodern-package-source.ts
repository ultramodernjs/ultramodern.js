export const WORKSPACE_PACKAGE_VERSION = 'workspace:*';
export const ULTRAMODERN_CREATE_PACKAGE = '@modern-js/ultramodern-create';
export const BLEEDINGDEV_CREATE_PACKAGE =
  '@bleedingdev/modern-js-ultramodern-create';
export const BLEEDINGDEV_PACKAGE_SCOPE = 'bleedingdev';
export const BLEEDINGDEV_PACKAGE_NAME_PREFIX = 'modern-js-';
export const ULTRAMODERN_FRAMEWORK_VERSION_ENV =
  'ULTRAMODERN_CREATE_FRAMEWORK_VERSION';

export const ULTRAMODERN_SINGLE_APP_MODERN_PACKAGES = [
  ULTRAMODERN_CREATE_PACKAGE,
  '@modern-js/code-tools',
  '@modern-js/runtime',
  '@modern-js/app-tools',
  '@modern-js/tsconfig',
  '@modern-js/plugin-i18n',
  '@modern-js/plugin-tanstack',
  '@modern-js/plugin-bff',
  '@modern-js/plugin-bff-build-extensions',
  '@modern-js/plugin-bff-extensions',
  '@modern-js/adapter-rstest',
] as const;

export const ULTRAMODERN_WORKSPACE_MODERN_PACKAGES = [
  '@modern-js/bff-effect',
  '@modern-js/boundary-debugger',
  ULTRAMODERN_CREATE_PACKAGE,
  '@modern-js/code-tools',
  '@modern-js/app-tools',
  '@modern-js/plugin-bff',
  '@modern-js/plugin-bff-build-extensions',
  '@modern-js/plugin-bff-extensions',
  '@modern-js/plugin-i18n',
  '@modern-js/i18n-integration',
  '@modern-js/plugin-tanstack',
  '@modern-js/runtime',
  '@modern-js/runtime-extensions',
  '@modern-js/runtime-renderer-extensions',
  '@modern-js/federation-runtime',
  '@modern-js/app-tools-extensions',
  '@modern-js/ultramodern-app-tools',
] as const;

export type UltramodernPackageSourceStrategy = 'workspace' | 'install';

export type ResolvedUltramodernPackageSource = {
  supportArtifacts?: import('./ultramodern-workspace/package-source').SupportArtifacts;
  nativeArtifacts?: import('./ultramodern-workspace/package-source').NativeArtifacts;
  strategy: UltramodernPackageSourceStrategy;
  modernPackageVersion: string;
  registry?: string;
  aliasScope?: string;
  aliasPackageNamePrefix?: string;
};

export function modernPackageVersion(
  packageSource: ResolvedUltramodernPackageSource,
): string {
  return packageSource.strategy === 'install'
    ? packageSource.modernPackageVersion
    : WORKSPACE_PACKAGE_VERSION;
}

function modernAliasPackageName(
  packageName: string,
  packageSource: ResolvedUltramodernPackageSource,
): string {
  if (!packageSource.aliasScope) {
    return packageName;
  }

  const scope = packageSource.aliasScope.replace(/^@/, '');
  const unscopedName = packageName.split('/').at(-1);
  return `@${scope}/${packageSource.aliasPackageNamePrefix ?? ''}${unscopedName}`;
}

export function modernPackageSpecifier(
  packageName: string,
  packageSource: ResolvedUltramodernPackageSource,
): string {
  if (packageSource.strategy !== 'install') {
    return WORKSPACE_PACKAGE_VERSION;
  }

  if (!packageSource.aliasScope) {
    return packageSource.modernPackageVersion;
  }

  return `npm:${modernAliasPackageName(packageName, packageSource)}@${
    packageSource.modernPackageVersion
  }`;
}
