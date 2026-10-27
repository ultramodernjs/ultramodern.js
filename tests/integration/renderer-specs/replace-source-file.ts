import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const retryDelays = [20, 40, 80, 160, 320];

/** Watchers must see complete source revisions, including during restoration. */
export async function replaceSourceFile(
  file: string,
  source: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (fs.readFileSync(file, 'utf8') === source) return;
  const stagingDirectory = fs.mkdtempSync(
    path.join(path.dirname(file), '.renderer-hmr-'),
  );
  try {
    const stagedFile = path.join(stagingDirectory, 'source.tmp');
    fs.writeFileSync(stagedFile, source, { mode: fs.statSync(file).mode });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(stagedFile, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          platform !== 'win32' ||
          (code !== 'EPERM' && code !== 'EBUSY') ||
          attempt >= retryDelays.length
        ) {
          throw error;
        }
        // Windows watchers can briefly hold a handle that denies replacement.
        // Retry the same atomic rename, never truncate or unlink the target.
        await delay(retryDelays[attempt]);
      }
    }
  } finally {
    fs.rmSync(stagingDirectory, {
      recursive: true,
      force: true,
      maxRetries: retryDelays.length,
      retryDelay: 20,
    });
  }
}
