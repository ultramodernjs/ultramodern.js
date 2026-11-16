import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const { scripts } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// Runs the package's `test:types` fixture programs (default i18next types and
// an application that enables selectors) as part of the unit suite.
test.each(scripts['test:types'].split(' && '))(
  'I18nInstance type contract: %s',
  (command: string) => {
    const [executable, ...args] = command.split(' ');
    const result = spawnSync(
      executable === 'node' ? process.execPath : executable,
      args,
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    if (result.status !== 0) {
      throw new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
    }
  },
);
