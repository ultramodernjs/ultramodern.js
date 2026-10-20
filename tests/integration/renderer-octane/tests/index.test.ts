import path from 'node:path';
import { setSuiteTimeout } from '../../../utils/setSuiteTimeout';
import { defineRendererSpecs } from '../../renderer-specs/specs';

setSuiteTimeout(1000 * 60 * 5);

defineRendererSpecs({
  renderer: 'octane',
  appDir: path.resolve(__dirname, '..'),
  skip: {
    'dev-hmr':
      'Counter keeps useSignal$ state, and once a streamed-signal module has run @octanejs/rspack-plugin reloads the document on every hot update, so any edit resets it',
  },
});
