import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A fresh clone has no generator dist yet. Run its one tracked preparation
// template directly, with the same workspace-root contract as generated apps.
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        '../packages/toolkit/ultramodern-create/templates/workspace-scripts/ultramodern-compiler-prepare.mjs',
        import.meta.url,
      ),
    ),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ULTRAMODERN_WORKSPACE_ROOT: fileURLToPath(
        new URL('../', import.meta.url),
      ),
    },
  },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
