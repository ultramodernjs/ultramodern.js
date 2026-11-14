import { join, resolve } from 'path';
import { expect, test } from '@playwright/test';
import { build, getHrefByEntryName } from '@scripts/shared';

const fixtures = resolve(__dirname, '../');

test('externals', async ({ page }) => {
  const builder = await build({
    cwd: fixtures,
    entry: {
      main: join(fixtures, 'src/index.js'),
    },
    runServer: true,
    builderConfig: {
      output: {
        externals: {
          './aaa': 'aa',
        },
      },
      source: {
        preEntry: './src/ex.js',
      },
    },
  });

  await page.goto(getHrefByEntryName('main', builder.port));

  const test = page.locator('#test');
  await expect(test).toHaveText('Hello Builder!');

  const testExternal = page.locator('#test-external');
  await expect(testExternal).toHaveText('1');

  const externalVar = await page.evaluate(`window.aa`);

  expect(externalVar).toBeDefined();

  builder.clean();
  builder.close();
});

test('should preserve externals when target is web worker', async () => {
  const builder = await build({
    cwd: fixtures,
    entry: { index: resolve(fixtures, './src/web-worker-react.js') },
    builderConfig: {
      output: {
        target: 'web-worker',
        externals: {
          react: 'MyReact',
        },
      },
    },
  });
  try {
    const files = await builder.unwrapOutputJSON();
    const workerFile = Object.keys(files).find(
      file => file.includes('/static/js/index.') && file.endsWith('.js'),
    );
    expect(workerFile).toBeDefined();
    if (!workerFile) {
      throw new Error('Missing web worker output');
    }
    expect(files[workerFile]).toContain('MyReact');
  } finally {
    builder.clean();
  }
});

test('should bundle dependencies when a web worker has no externals', async ({
  page,
}) => {
  const builder = await build({
    cwd: fixtures,
    entry: { index: resolve(fixtures, './src/web-worker-react.js') },
    runServer: true,
    builderConfig: {
      output: {
        target: 'web-worker',
      },
    },
  });
  const files = await builder.unwrapOutputJSON();
  const workerFile = Object.keys(files).find(
    file => file.includes('/static/js/index.') && file.endsWith('.js'),
  )!;
  const workerPath = workerFile.slice(workerFile.indexOf('/static/'));
  await page.goto('about:blank');
  const workerResponse = await page.request.get(
    `http://127.0.0.1:${builder.port}${workerPath}`,
  );
  expect(workerResponse.ok()).toBe(true);
  const workerSource = await workerResponse.text();
  const workerResult = await page.evaluate(async source => {
    const workerUrl = URL.createObjectURL(
      new Blob([source], { type: 'text/javascript' }),
    );
    return await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(workerUrl);
      worker.addEventListener('message', event => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        resolve(event.data);
      });
      worker.addEventListener('error', event => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        reject(
          new Error(
            `worker failed: ${event.message || 'unknown error'} (${event.filename}:${event.lineno}:${event.colno})`,
          ),
        );
      });
    });
  }, workerSource);
  expect(workerResult).toEqual({ canCreateElement: true });

  builder.clean();
});
