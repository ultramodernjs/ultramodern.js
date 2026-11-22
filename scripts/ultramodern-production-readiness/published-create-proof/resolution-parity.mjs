import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from './dependency-closure-audit.mjs';

function compareCodeUnits(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
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

export { scaffoldFiles };
