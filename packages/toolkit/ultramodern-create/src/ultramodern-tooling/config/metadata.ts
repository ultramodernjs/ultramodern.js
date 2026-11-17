import fs from 'node:fs';
import path from 'node:path';
import { yaml } from '@modern-js/utils';
import {
  readNativeArtifacts,
  readSupportArtifacts,
} from '../../ultramodern-workspace/package-source';
import type { ResolvedPackageSource } from '../../ultramodern-workspace/types';
import { readOptionalJsonObject } from './json';

export function packageScopeFromRoot(workspaceRoot: string): string {
  const manifestPath = path.join(workspaceRoot, 'package.json');
  const rootPackage = readOptionalJsonObject(manifestPath);
  return typeof rootPackage.name === 'string' && rootPackage.name.length > 0
    ? rootPackage.name
    : path.basename(workspaceRoot);
}

/** Native dependency requests own the source; no application config is loaded. */
export function readWorkspacePackageSource(
  workspaceRoot: string,
): ResolvedPackageSource {
  const manifestPath = path.join(workspaceRoot, 'package.json');
  const manifest = readOptionalJsonObject(manifestPath);
  const supportArtifacts = readSupportArtifacts(manifest);
  const nativeArtifacts = readNativeArtifacts(manifest);
  const support = {
    ...(supportArtifacts ? { supportArtifacts } : {}),
    ...(nativeArtifacts ? { nativeArtifacts } : {}),
  };
  const name = '@modern-js/ultramodern-create';
  let request =
    manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];
  if (typeof request !== 'string')
    throw new Error(`Missing ${name} dependency in package.json.`);
  if (request.startsWith('catalog:')) {
    const catalogPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');
    const catalogSource = fs.readFileSync(catalogPath, 'utf8');
    const config = yaml.load(catalogSource) as Record<string, any>;
    const catalog = request.slice('catalog:'.length);
    request = (catalog ? config.catalogs?.[catalog] : config.catalog)?.[name];
    if (typeof request !== 'string')
      throw new Error(
        `Missing ${name} in pnpm catalog ${catalog || 'default'}.`,
      );
  }
  if (request.startsWith('workspace:'))
    return {
      strategy: 'workspace',
      modernPackageVersion: 'workspace:*',
      ...support,
    };
  const alias = /^npm:@([^/]+)\/([^@]+)@([^@]+)$/u.exec(request);
  if (alias) {
    const [, aliasScope, target, modernPackageVersion] = alias;
    const suffix = 'ultramodern-create';
    if (!target.endsWith(suffix))
      throw new Error(`Unsupported framework package alias: ${request}.`);
    return {
      strategy: 'install',
      ...support,
      modernPackageVersion,
      aliasScope,
      aliasPackageNamePrefix: target.slice(0, -suffix.length),
    };
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(request)) {
    throw new Error(
      `Framework dependency must use an exact version or workspace source: ${request}.`,
    );
  }
  return { strategy: 'install', modernPackageVersion: request, ...support };
}
