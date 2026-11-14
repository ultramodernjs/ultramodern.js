import { channel } from 'node:diagnostics_channel';
import {
  chokidar,
  type FSWatcher,
  fs,
  type WatchOptions,
} from '@modern-js/utils';
import path from 'path';
import { DependencyTree } from './dependencyTree';
import { StatsCache } from './statsCache';

export type WatchEvent = 'add' | 'change' | 'unlink';

export const defaultWatchOptions = {
  // 初始化的时候不触发 add、addDir 事件
  ignoreInitial: true,
  // Shared workspace symlinks must not pull installed dependency trees into
  // the watcher and schedule runtime reloads for their file events.
  ignored: /api\/typings\/.*|(?:^|[/\\])node_modules(?:[/\\]|$)/,
};

export const getWatchedFiles = (watcher: FSWatcher) => {
  const watched = watcher.getWatched();
  const files: string[] = [];
  Object.keys(watched).forEach(dir => {
    const dirFiles = watched[dir];
    if (!dirFiles) {
      return;
    }
    dirFiles.forEach((fileName: string) => {
      files.push(path.join(dir, fileName));
    });
  });
  return files;
};

export const mergeWatchOptions = (options?: WatchOptions): WatchOptions => {
  const watchOptions = {
    ...options,
  };
  if (watchOptions) {
    const { ignored } = watchOptions;
    const finalIgnored = ignored
      ? [
          defaultWatchOptions.ignored,
          ...(Array.isArray(ignored) ? ignored : [ignored]),
        ]
      : ignored;

    if (finalIgnored) {
      watchOptions.ignored = finalIgnored;
    }
  }

  const finalWatchOptions = {
    ...defaultWatchOptions,
    ...watchOptions,
  };

  return finalWatchOptions;
};

export default class Watcher {
  private dependencyTree: DependencyTree | null = null;

  private watcher!: FSWatcher;

  public listen(
    files: string[],
    options: WatchOptions,
    callback: (changed: string, event: WatchEvent) => void,
  ) {
    const watched = files.filter(Boolean);
    const filenames = watched.map(filename => filename.replace(/\\/g, '/'));

    const cache = new StatsCache();
    const watcher = chokidar.watch(filenames, options);
    const notify = (changed: string, event: WatchEvent) => {
      channel('modern-js:dev:invalidate').publish(changed);
      callback(changed, event);
    };

    watcher.on('ready', () => {
      cache.add(getWatchedFiles(watcher));
    });

    watcher.on('change', changed => {
      if (!fs.existsSync(changed) || cache.isDiff(changed)) {
        cache.refresh(changed);
        notify(changed, 'change');
      }
    });

    watcher.on('add', changed => {
      if (!cache.has(changed)) {
        cache.add([changed]);
        notify(changed, 'add');
      }
    });

    watcher.on('unlink', changed => {
      cache.del(changed);
      notify(changed, 'unlink');
    });

    this.watcher = watcher;
  }

  public createDepTree() {
    this.dependencyTree = new DependencyTree();
  }

  public updateDepTree() {
    this.dependencyTree?.update(require.cache);
  }

  public cleanDepCache(filepath: string) {
    const node = this.dependencyTree?.getNode(filepath);
    if (node && require.cache[filepath]) {
      delete require.cache[filepath];
      for (const parentNode of node.parent.values()) {
        this.cleanDepCache(parentNode.module.filename);
      }
    }
  }

  public close() {
    return this.watcher.close();
  }
}
