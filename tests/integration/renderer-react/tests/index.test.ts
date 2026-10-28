import path from 'node:path';
import {
  acquireFixtureLock,
  type ReleaseFixtureLock,
} from '../../../utils/fixtureLock';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';
import { defineRendererSpecs } from '../../renderer-specs/specs';

setSuiteTimeout(1000 * 60 * 5);

const appDir = path.resolve(__dirname, '..');
let releaseFixture: ReleaseFixtureLock | undefined;
// The Redact Node/workerd contract builds this same app in a second test file.
beforeAll(async () => {
  releaseFixture = await acquireFixtureLock(
    process.env.RENDERER_TARGET_DIR ?? appDir,
  );
});
afterAll(async () => {
  await releaseFixture?.();
});

defineRendererSpecs({
  renderer: 'react',
  appDir,
  // The TanStack plugin renders Modern's DefaultNotFound for unmatched routes.
  notFoundMarker: '>404</div>',
});
