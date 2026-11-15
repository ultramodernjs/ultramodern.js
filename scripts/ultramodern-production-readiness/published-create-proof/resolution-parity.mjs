import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from './release-age-audit.mjs';

// The published lanes rebuild nothing. They scaffold and resolve the published
// cohort the way a consumer would and prove both the generated source and the
// resolved closure are the ones the source lane already built, ran and
// accepted. Any difference means npm now serves something that was never
// accepted, so it fails and names every file or package that moved.

function compareCodeUnits(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function versionsByName(closureIdentities) {
  const byName = new Map();
  for (const { name, version, integrity } of closureIdentities) {
    const versions = byName.get(name) ?? new Map();
    versions.set(version, integrity);
    byName.set(name, versions);
  }
  return byName;
}

function versionList(versions) {
  return [...versions.keys()].sort(compareCodeUnits).join(', ');
}

function resolutionDrift(accepted, observed) {
  const acceptedByName = versionsByName(accepted);
  const observedByName = versionsByName(observed);
  const names = [
    ...new Set([...acceptedByName.keys(), ...observedByName.keys()]),
  ].sort(compareCodeUnits);
  const drift = [];
  for (const name of names) {
    const acceptedVersions = acceptedByName.get(name);
    const observedVersions = observedByName.get(name);
    if (!acceptedVersions) {
      drift.push(
        `${name}: not in the accepted closure, now resolves ${versionList(observedVersions)}`,
      );
    } else if (!observedVersions) {
      drift.push(
        `${name}: accepted ${versionList(acceptedVersions)}, no longer resolved`,
      );
    } else if (
      versionList(acceptedVersions) !== versionList(observedVersions)
    ) {
      drift.push(
        `${name}: accepted ${versionList(acceptedVersions)}, now resolves ${versionList(observedVersions)}`,
      );
    } else {
      for (const [version, integrity] of acceptedVersions) {
        if (observedVersions.get(version) !== integrity) {
          drift.push(
            `${name}@${version}: accepted integrity ${integrity}, now ${observedVersions.get(version)}`,
          );
        }
      }
    }
  }
  return drift;
}

// Every file the generator wrote, except Git metadata and installed packages.
function scaffoldFiles(root) {
  const workspaceFiles = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, entryPath);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') {
          walk(entryPath);
        }
      } else if (entry.isSymbolicLink()) {
        workspaceFiles.push({
          path: entryPath,
          sha256: sha256(`symlink:${fs.readlinkSync(absolute)}`),
        });
      } else if (entry.isFile()) {
        workspaceFiles.push({
          path: entryPath,
          sha256: sha256(fs.readFileSync(absolute)),
        });
      } else {
        throw new Error(
          `Generated workspace contains special file ${entryPath}`,
        );
      }
    }
  };
  walk('');
  workspaceFiles.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    workspaceFiles,
    workspaceSha256: sha256(canonicalJson(workspaceFiles)),
  };
}

// The create CLI resolves its own dependencies through `pnpm dlx` when it
// runs, outside the workspace lock. If one of them moved between the lanes and
// changed what it generates, the published scaffold is source the source lane
// never built.
function assertScaffoldParity(accepted, observed, { lane }) {
  for (const [label, scaffold] of [
    ['Accepted source scaffold', accepted],
    [`${lane} scaffold`, observed],
  ]) {
    if (
      !Array.isArray(scaffold?.workspaceFiles) ||
      scaffold.workspaceFiles.length === 0 ||
      scaffold.workspaceSha256 !==
        sha256(canonicalJson(scaffold.workspaceFiles))
    ) {
      throw new Error(
        `${label} files do not match its workspaceSha256; the evidence was altered or produced by an older schema.`,
      );
    }
  }
  if (observed.workspaceSha256 === accepted.workspaceSha256) {
    return {
      fileCount: observed.workspaceFiles.length,
      workspaceSha256: observed.workspaceSha256,
    };
  }
  const acceptedByPath = new Map(
    accepted.workspaceFiles.map(file => [file.path, file.sha256]),
  );
  const observedByPath = new Map(
    observed.workspaceFiles.map(file => [file.path, file.sha256]),
  );
  const drift = [
    ...new Set([...acceptedByPath.keys(), ...observedByPath.keys()]),
  ]
    .sort(compareCodeUnits)
    .flatMap(file => {
      if (!observedByPath.has(file)) {
        return [`${file}: accepted, no longer generated`];
      }
      if (!acceptedByPath.has(file)) {
        return [`${file}: not in the accepted scaffold, now generated`];
      }
      return acceptedByPath.get(file) === observedByPath.get(file)
        ? []
        : [`${file}: content differs`];
    });
  throw new Error(
    [
      `${lane} scaffold differs from the workspace the source lane built (${drift.length} file(s)):`,
      ...drift.map(line => `  - ${line}`),
      'The create package resolves its own dependencies through pnpm dlx at run time; one of them moved between the lanes and changed the generated source. Release the next version from a new reviewed source commit so its source lane builds today\u2019s scaffold; an already-published source commit cannot be published under another version.',
    ].join('\n'),
  );
}

function assertResolutionDigest(resolution, label) {
  if (
    !Array.isArray(resolution?.closureIdentities) ||
    resolution.closureIdentities.length === 0 ||
    resolution.closureSha256 !==
      sha256(canonicalJson(resolution.closureIdentities))
  ) {
    throw new Error(
      `${label} closure identities do not match its closureSha256; the evidence was altered or produced by an older schema.`,
    );
  }
}

// `accepted` and `observed` are { closureIdentities, closureSha256 } as
// closureResolution() returns them.
function assertResolutionParity(accepted, observed, { lane }) {
  assertResolutionDigest(accepted, 'Accepted source resolution');
  assertResolutionDigest(observed, `${lane} resolution`);
  if (observed.closureSha256 === accepted.closureSha256) {
    return {
      closureSha256: observed.closureSha256,
      packageCount: observed.closureIdentities.length,
    };
  }
  const drift = resolutionDrift(
    accepted.closureIdentities,
    observed.closureIdentities,
  );
  throw new Error(
    [
      `${lane} resolution differs from the closure the source lane accepted (${drift.length} package(s)):`,
      ...drift.map(line => `  - ${line}`),
      'The registry now resolves dependencies the source lane never built or ran. A version change usually means a third-party release matured between the two lanes; release the next version from a new reviewed source commit so its source lane accepts today’s closure. An already-published source commit cannot be published under another version. An integrity change means the registry serves different bytes for an accepted version; investigate it before promoting anything.',
    ].join('\n'),
  );
}

export {
  assertResolutionParity,
  assertScaffoldParity,
  resolutionDrift,
  scaffoldFiles,
};
