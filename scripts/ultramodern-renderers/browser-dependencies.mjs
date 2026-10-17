import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Resolve the installed browser dependency through its owner, never the store. */
export function resolveBrowserDependencyRoot(ownerRoot) {
  const owner = fs.realpathSync(ownerRoot);
  const request = createRequire(path.join(owner, 'package.json'));
  let manifest;
  try {
    manifest = request.resolve('playwright-core/package.json');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    try {
      const playwright = request.resolve('playwright/package.json');
      manifest = createRequire(playwright).resolve(
        'playwright-core/package.json',
      );
    } catch (cause) {
      throw new Error(
        `No installed Playwright browser dependency resolves from ${owner}; pass --browser-dependency-root with its existing installed owner`,
        { cause },
      );
    }
  }
  manifest = fs.realpathSync(manifest);
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(metadata.name, 'playwright-core');
  // Every downstream runner requests this public package from the returned root.
  createRequire(manifest).resolve('playwright-core');
  return path.dirname(manifest);
}
