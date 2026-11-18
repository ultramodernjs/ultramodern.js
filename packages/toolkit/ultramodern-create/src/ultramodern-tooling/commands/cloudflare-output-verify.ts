import { createRequire } from 'node:module';
import path from 'node:path';
import { createCloudflarePublicUrlEnv } from '../../ultramodern-workspace/descriptors';
import {
  readUltramodernConfig,
  workspaceAppsFromToolingConfig,
} from '../config';
import { reportCloudflareOutputChecks } from './cloudflare-output-checks';
import type { CommandContext } from './context';
import { readOption } from './options';

interface CloudflareOutputVerifyTarget {
  label: string;
  outputDirectory: string;
  /** The app's own public URL env; `--output` targets have none. */
  publicUrlEnv?: string;
}

const REQUIRE_PUBLIC_URLS_FLAG = '--require-public-urls';

/** The deployed Worker needs a public origin, not the localhost fallback. */
const missingPublicUrl = ({
  label,
  publicUrlEnv,
}: CloudflareOutputVerifyTarget) => {
  if (!publicUrlEnv) {
    return `${REQUIRE_PUBLIC_URLS_FLAG} needs --app, not --output (${label}).`;
  }
  const names = [
    publicUrlEnv,
    'MODERN_PUBLIC_SITE_URL',
    'ULTRAMODERN_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN',
  ];
  return names.some(name => process.env[name]?.trim())
    ? undefined
    : `Cloudflare deploy for ${label} needs ${names.join(', ')}.`;
};

const resolveCloudflareOutputVerifyTargets = (
  args: string[],
  context: CommandContext,
): CloudflareOutputVerifyTarget[] => {
  const outputDirectory = readOption(args, '--output');
  const appId = readOption(args, '--app');

  if (outputDirectory && appId) {
    throw new Error('Use either --app or --output, not both.');
  }

  const targets = outputDirectory
    ? [
        {
          label: outputDirectory,
          outputDirectory: path.resolve(context.invocationCwd, outputDirectory),
        },
      ]
    : workspaceAppsFromToolingConfig(
        readUltramodernConfig(context.workspaceRoot),
        context.workspaceRoot,
      )
        .filter(app => !appId || app.id === appId)
        .map(app => ({
          label: app.id,
          outputDirectory: path.join(
            context.workspaceRoot,
            app.directory,
            '.output',
          ),
          publicUrlEnv: createCloudflarePublicUrlEnv(app),
        }));

  if (targets.length === 0) {
    throw new Error(`No generated UltraModern app matched ${appId}.`);
  }

  return targets;
};

export async function runCloudflareOutputVerify(
  args: string[],
  context: CommandContext,
) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage:
  ultramodern-create ultramodern cloudflare-output-verify [--app <id> | --output <dir>] [--require-public-urls]

Verifies generated Cloudflare output against the UltraModern worker contract.
Without --app or --output, every generated workspace app is verified.
--require-public-urls also fails an app that has no public URL to deploy to.
`);
    return 0;
  }

  const targets = resolveCloudflareOutputVerifyTargets(args, context);
  if (args.includes(REQUIRE_PUBLIC_URLS_FLAG)) {
    const missing = targets
      .map(missingPublicUrl)
      .filter((message): message is string => Boolean(message));
    if (missing.length > 0) {
      throw new Error(missing.join('\n'));
    }
  }
  const verifierRequire = createRequire(
    path.join(context.workspaceRoot, 'package.json'),
  );
  const verifierPath = verifierRequire.resolve(
    '@modern-js/app-tools-extensions/cloudflare-output-verifier',
  );
  const { verifyCloudflareOutputMutationPolicy } = verifierRequire(
    verifierPath,
  ) as typeof import('@modern-js/app-tools-extensions/cloudflare-output-verifier');
  let failed = await reportCloudflareOutputChecks(verifierPath, targets);
  const policyResult = await verifyCloudflareOutputMutationPolicy({
    scanRoots: [context.workspaceRoot],
    excludePaths: [],
  });
  if (!policyResult.ok) {
    failed = true;
    console.error('[ultramodern] generated-output mutation policy failed');
    for (const issue of policyResult.issues) {
      console.error(
        `- ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`,
      );
    }
  }
  return failed ? 1 : 0;
}
