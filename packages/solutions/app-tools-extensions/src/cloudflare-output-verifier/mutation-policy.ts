import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CloudflareOutputVerifierIssue,
  CloudflareOutputVerifierIssueCode,
  CloudflareOutputVerifierResult,
} from './issues';
import { addIssue } from './issues';

export interface VerifyCloudflareOutputMutationPolicyOptions {
  scanRoots: string[];
  /**
   * Absolute paths of framework-generated proof artifacts (e.g. the immutable
   * workspace validation contract) that record generated-output path literals
   * as contract data and never rewrite build output. These are exempt from the
   * app-script mutation scan; every app-author script under the scan roots is
   * still checked.
   */
  excludePaths?: string[];
}

const SOURCE_SCAN_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/u;
const SOURCE_SCAN_IGNORED_DIRECTORY_NAMES = new Set([
  '.codex',
  '.fastcontext',
  '.git',
  '.mf',
  '.modernjs',
  '.output',
  'coverage',
  'dist',
  'dist-cloudflare',
  'node_modules',
  'repos',
  'topology',
]);

const FORBIDDEN_MUTATION_PATTERNS: Array<{
  code: CloudflareOutputVerifierIssueCode;
  message: string;
  pattern: RegExp;
}> = [
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Generated Cloudflare server worker output must not be rewritten by app scripts.',
    pattern: /\.output\/server\/index\.mjs/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Generated Cloudflare server worker output must not be rewritten by app scripts.',
    pattern:
      /path\.(?:join|resolve)\(\s*['"`]\.output['"`]\s*,\s*['"`]server['"`]\s*,\s*['"`]index\.mjs['"`]\s*\)/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Generated Cloudflare BFF worker bundles must not be rewritten by app scripts.',
    pattern: /\.output\/worker\/[^'"`]*\.(?:mjs|cjs|js)/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Generated Cloudflare BFF worker bundles must not be rewritten by app scripts.',
    pattern:
      /path\.(?:join|resolve)\(\s*['"`]\.output['"`]\s*,\s*['"`]worker['"`]\s*,\s*['"`][^'"`]+\.(?:mjs|cjs|js)['"`]\s*\)/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Drizzle entityKind worker bundle markers must be fixed in the framework toolchain, not post-build scripts.',
    pattern: /replaceAll\(\s*['"`];entityKind(?:,entityKind)?;/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Effect BFF Cloudflare dispatch must not depend on duck-typed runtime helper probing in app scripts.',
    pattern:
      /(?:typeof\s+[^;\n]*dispatchEffectBffRequest|['"`]dispatchEffectBffRequest['"`]\s+in\s+|\.dispatchEffectBffRequest\b)/u,
  },
  {
    code: 'forbidden-mutation-pattern',
    message:
      'Effect BFF Cloudflare dispatch must not branch on handler.length in app scripts.',
    pattern: /\bhandler\s*\.\s*length\b/u,
  },
];

const pathExists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const walkFiles = async (root: string): Promise<string[]> => {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SOURCE_SCAN_IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (
      entry.name === 'package.json' ||
      (SOURCE_SCAN_FILE_PATTERN.test(entry.name) &&
        !DECLARATION_FILE_PATTERN.test(entry.name))
    ) {
      files.push(entryPath);
    }
  }

  return files;
};

export const verifyCloudflareOutputMutationPolicy = async (
  options: VerifyCloudflareOutputMutationPolicyOptions,
): Promise<CloudflareOutputVerifierResult> => {
  const issues: CloudflareOutputVerifierIssue[] = [];
  const excludedFiles = new Set(
    (options.excludePaths ?? []).map(entry => path.resolve(entry)),
  );
  const files = (
    await Promise.all(
      options.scanRoots.map(scanRoot => walkFiles(path.resolve(scanRoot))),
    )
  ).flat();

  for (const file of files) {
    if (excludedFiles.has(file)) {
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(file, 'utf-8');
    } catch (error) {
      // Concurrent sibling builds delete transient files (for example tsgo
      // resolved configs) between the walk and the read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    let executableSources = [source];
    if (path.basename(file) === 'package.json') {
      try {
        const manifest: unknown = JSON.parse(source);
        if (!isRecord(manifest)) {
          throw new TypeError('Package metadata must be an object.');
        }
        const scripts = Object.hasOwn(manifest, 'scripts')
          ? manifest.scripts
          : {};
        if (!isRecord(scripts)) {
          throw new TypeError('Package scripts must be an object.');
        }
        const commands = Object.values(scripts);
        if (
          !commands.every((value): value is string => typeof value === 'string')
        ) {
          throw new TypeError('Package scripts must contain only strings.');
        }
        executableSources = commands;
      } catch {
        addIssue(issues, {
          code: 'invalid-package',
          message:
            'Cannot verify executable package lifecycle scripts: invalid package metadata.',
          path: file,
        });
        continue;
      }
    }
    for (const forbidden of FORBIDDEN_MUTATION_PATTERNS) {
      if (executableSources.some(value => forbidden.pattern.test(value))) {
        addIssue(issues, {
          code: forbidden.code,
          message: forbidden.message,
          path: file,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
