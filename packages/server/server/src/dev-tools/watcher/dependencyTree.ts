import nodePath from 'node:path';
import * as minimatch from 'minimatch';

export const defaultIgnores = [
  '**/coverage/**',
  '**/node_modules/**',
  '**/.*/**',
  '**/*.d.ts',
  '**/*.log',
];

export interface DependencyTreeOptions {
  root: string;
  ignore?: string[];
}

export interface TreeNode {
  module: NodeModule;
  parent: Set<TreeNode>;
  children: Set<TreeNode>;
}

/**
 * `require.cache` already is a dependency tree, however require cache's
 * `module.parent` is the module that first required. so we have to implement
 *  a new tree which revisit the cache tree to find all parent node
 */
export class DependencyTree {
  private readonly tree: Map<string, TreeNode>;

  private readonly ignore: minimatch.Minimatch[];

  constructor() {
    this.tree = new Map<string, TreeNode>();
    this.ignore = defaultIgnores.map(
      rule => new minimatch.Minimatch(rule, { dot: true }),
    );
  }

  public getNode(path: string) {
    return this.tree.get(path);
  }

  /**
   * update dependency tree
   *
   * @param cache
   */
  public update(cache: any) {
    this.tree.clear();

    // insert all module that not ignored
    Object.keys(cache).forEach(path => {
      if (!this.shouldIgnore(path)) {
        const module = cache[path];
        this.tree.set(module.filename, {
          module,
          parent: new Set<TreeNode>(),
          children: new Set<TreeNode>(),
        });
      }
    });

    // update treeNode parent and children
    for (const treeNode of this.tree.values()) {
      const { parent } = treeNode.module;
      const { children } = treeNode.module;

      if (parent) {
        const parentTreeNode = this.tree.get(parent.filename);
        if (parentTreeNode) {
          treeNode.parent.add(parentTreeNode);
        }
      }

      children?.forEach(child => {
        const childTreeNode = this.tree.get(child.filename);
        if (childTreeNode) {
          treeNode.children.add(childTreeNode);
          childTreeNode.parent.add(treeNode);
        }
      });
    }
  }

  private shouldIgnore(path: string): boolean {
    const relativePath =
      path && nodePath.isAbsolute(path)
        ? nodePath.relative(process.cwd(), path)
        : path;
    // Globstars cannot match ".." segments in paths outside the working directory.
    const matchPath =
      relativePath === '..' || relativePath.startsWith(`..${nodePath.sep}`)
        ? path
        : relativePath;
    return !matchPath || this.ignore.some(rule => rule.match(matchPath));
  }
}
