import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudflareWorkerServiceBindingConfig } from '@modern-js/app-tools-extensions/config';
import {
  findWorkspaceRoot,
  REFERENCE_TOPOLOGY_PATH,
} from '@modern-js/app-tools-extensions/workspace-topology';
import { loadUltramodernConfigMetadata } from './config-metadata';
import type { NativeWorkerFederationLocaleConfig } from './native-worker-federation-config';

/** Resolve remote URL policy through its actual config and analyzed entry hooks. */
export async function loadNativeWorkerFederationPolicies(options: {
  appDirectory: string;
  services: readonly CloudflareWorkerServiceBindingConfig[];
  env: string;
}): Promise<Readonly<Record<string, NativeWorkerFederationLocaleConfig>>> {
  const remotes = [
    ...new Set(
      options.services.flatMap(
        service => service.fragments?.map(fragment => fragment.remote) ?? [],
      ),
    ),
  ];
  if (!remotes.length) return {};
  const workspace = findWorkspaceRoot(options.appDirectory);
  if (!workspace)
    throw new Error(
      'Native Worker federation locale admission requires the remote configuration in its declared workspace.',
    );
  const topology: unknown = JSON.parse(
    await fs.readFile(path.join(workspace, REFERENCE_TOPOLOGY_PATH), 'utf8'),
  );
  if (
    !topology ||
    typeof topology !== 'object' ||
    !('verticals' in topology) ||
    !Array.isArray(topology.verticals)
  )
    throw new Error(
      'Native Worker federation requires its declared remote topology.',
    );
  const verticals = topology.verticals;
  const workspaceOwner = await fs.realpath(workspace);
  const owners = await Promise.all(
    remotes.map(async remote => {
      const selected = verticals.filter(
        app => app && typeof app === 'object' && app.id === remote,
      );
      if (selected.length !== 1 || typeof selected[0].path !== 'string')
        throw new Error(
          `Native Worker federation remote ${remote} requires one declared configuration owner.`,
        );
      const appDirectory = path.resolve(workspace, selected[0].path);
      const relative = path.relative(workspace, appDirectory);
      if (
        path.isAbsolute(selected[0].path) ||
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error(
          `Native Worker federation remote ${remote} has an unsafe configuration path.`,
        );
      const canonicalDirectory = await fs.realpath(appDirectory);
      const canonicalRelative = path.relative(
        workspaceOwner,
        canonicalDirectory,
      );
      if (
        !canonicalRelative ||
        path.isAbsolute(canonicalRelative) ||
        canonicalRelative === '..' ||
        canonicalRelative.startsWith(`..${path.sep}`)
      )
        throw new Error(
          `Native Worker federation remote ${remote} has an unsafe configuration path.`,
        );
      return { remote, appDirectory: canonicalDirectory };
    }),
  );
  const policies: Record<string, NativeWorkerFederationLocaleConfig> = {};
  for (const { remote, appDirectory } of owners) {
    const entries = await loadUltramodernConfigMetadata({
      appDirectory,
      command: 'metadata',
      env: options.env,
      analyzeServerRoutes: true,
    });
    if (
      !('entryBasePaths' in entries) ||
      !entries.entryBasePaths ||
      typeof entries.entryBasePaths !== 'object' ||
      Array.isArray(entries.entryBasePaths)
    )
      throw new Error(
        `Native Worker federation remote ${remote} requires public analyzed entry prefixes.`,
      );
    const prefixes = [
      ...new Set(
        Object.values(entries.entryBasePaths).map(prefix => {
          if (typeof prefix !== 'string')
            throw new Error(
              `Native Worker federation remote ${remote} has an invalid analyzed entry prefix.`,
            );
          return prefix;
        }),
      ),
    ];
    if (prefixes.length !== 1)
      throw new Error(
        `Native Worker federation remote ${remote} requires one analyzed public entry prefix.`,
      );
    policies[remote] = {
      i18n: entries.i18n,
      basePath: prefixes[0],
    };
  }
  return policies;
}
