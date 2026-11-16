#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const MINIMUM_NODE_VERSION = '26.13.1';

const parseNodeVersion = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match?.slice(1).map(Number);
};

export const assertSupportedNodeVersion = (
  currentVersion = process.versions.node,
) => {
  const current = parseNodeVersion(currentVersion);
  const minimum = parseNodeVersion(MINIMUM_NODE_VERSION);
  const supported =
    current &&
    current.reduce((order, part, index) => order || part - minimum[index], 0) >=
      0;

  if (!supported) {
    throw new Error(
      `UltraModern.js requires Node.js >=${MINIMUM_NODE_VERSION}; detected v${currentVersion}. Legacy Node runtimes and transpiler fallbacks are unsupported. Run "mise install", then activate the pinned runtime.`,
    );
  }
  return currentVersion;
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
