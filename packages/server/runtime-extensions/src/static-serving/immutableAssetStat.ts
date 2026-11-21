import type { StaticAssetStat } from '@modern-js/server-core/node';
import { fs } from '@modern-js/utils';

export const IMMUTABLE_ASSET_STAT_LIMIT = 8192;

/**
 * File metadata for immutable releases. Only found regular files are kept, so
 * a missing path is looked up again by the next request. The oldest entry is
 * dropped once the limit is reached.
 */
export function createImmutableAssetStat(): StaticAssetStat {
  const stats = new Map<string, ReturnType<StaticAssetStat>>();
  const forget = (filename: string, pending: ReturnType<StaticAssetStat>) => {
    if (stats.get(filename) === pending) {
      stats.delete(filename);
    }
  };
  return filename => {
    const cached = stats.get(filename);
    if (cached) {
      return cached;
    }
    const pending: ReturnType<StaticAssetStat> = fs.stat(filename).then(
      stat => {
        if (!stat.isFile()) {
          forget(filename, pending);
        }
        return stat;
      },
      () => {
        forget(filename, pending);
        return null;
      },
    );
    if (stats.size >= IMMUTABLE_ASSET_STAT_LIMIT) {
      stats.delete(stats.keys().next().value!);
    }
    stats.set(filename, pending);
    return pending;
  };
}
