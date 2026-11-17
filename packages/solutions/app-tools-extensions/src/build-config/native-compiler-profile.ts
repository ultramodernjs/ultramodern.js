import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

function parseFast(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error(
    `TSRS_FAST must be true or false (or 1 or 0), received ${JSON.stringify(value)}.`,
  );
}

// The nearest package.json that declares `ultramodern.typecheck` (normally the
// workspace root) owns the project's fast setting.
function declaredFast(from: string): boolean | undefined {
  for (let directory = path.resolve(from); ; ) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const config = JSON.parse(readFileSync(manifestPath, 'utf8'))?.ultramodern
        ?.typecheck;
      if (config !== undefined) {
        const fast = config?.fast;
        if (fast !== undefined && typeof fast !== 'boolean') {
          throw new Error(
            `${manifestPath} "ultramodern.typecheck".fast must be true or false, received ${JSON.stringify(fast)}.`,
          );
        }
        return fast;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The environment for every UltraModern native compiler run that writes a
 * workspace's project outputs: the installed typecheck command and the build
 * type checker.
 *
 * tsrs records its performance profile (`TSRS_FAST` and the checker
 * assignment) in each tsbuildinfo and treats one written under another profile
 * as absent. One profile keeps references prepared by either writer current
 * for the other, so concurrent app checks reuse already prepared shared
 * declarations. Precedence: `TSRS_FAST`, then `ultramodern.typecheck.fast`, then the
 * fast preset. An explicit `TSRS_CHECKER_ASSIGNMENT` is kept; otherwise the
 * fast preset uses its own work stealing and `fast: false` uses `locality`.
 * Effect-Go ignores these variables.
 */
export function resolveNativeCompilerEnvironment(
  from: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const fast = parseFast(nonEmpty(env.TSRS_FAST)) ?? declaredFast(from) ?? true;
  const result: NodeJS.ProcessEnv = { ...env, TSRS_FAST: fast ? '1' : '0' };
  const assignment = nonEmpty(env.TSRS_CHECKER_ASSIGNMENT);
  if (assignment) result.TSRS_CHECKER_ASSIGNMENT = assignment;
  else if (fast) delete result.TSRS_CHECKER_ASSIGNMENT;
  else result.TSRS_CHECKER_ASSIGNMENT = 'locality';
  return result;
}
