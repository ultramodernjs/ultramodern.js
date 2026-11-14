import { logger } from '@modern-js/utils';
import { createDefaultPlugins, createServerBase, useHonoContext } from '../src';
import {
  createDefaultServer,
  getDefaultAppContext,
  getDefaultConfig,
} from './helpers';

describe('server base', () => {
  it('should support registering options handler', async () => {
    const server = createServerBase({
      config: getDefaultConfig(),
      pwd: '',
      appContext: getDefaultAppContext(),
    });

    server.options('/api/ping', c => c.body(null, 204));

    const response = await server.request('/api/ping', {
      method: 'OPTIONS',
    });

    expect(response.status).toBe(204);
    expect(response.body).toBe(null);
  });

  it.each([false, true])(
    'should return a Response for unfinalized middleware (read res: %s)',
    async readResponse => {
      const server = createDefaultServer();
      const onError = rs.fn((error, c) => c.text(error.message, 500));
      server.onError(onError);
      server.use('*', async (c, next) => {
        if (readResponse) {
          c.res.headers.get('content-type');
        }
        await next();
      });
      server.get('/unfinished', c => {
        c.status(404);
      });

      const response = await server.request('/unfinished');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('Context is not finalized');
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  it('should preserve a returned redirect response and upstream headers', async () => {
    const server = createDefaultServer();
    server.use('*', async (c, next) => {
      c.header('X-Upstream', 'preserved');
      await next();
    });
    server.get('/redirect', c => c.redirect('/target', 301));

    const response = await server.request('/redirect');

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/target');
    expect(response.headers.get('X-Upstream')).toBe('preserved');
  });

  it('should preserve a response assigned before returning void', async () => {
    const server = createDefaultServer();
    server.get('/assigned', c => {
      c.res = c.text('assigned', 429);
    });

    const response = await server.request('/assigned');

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(429);
    expect(await response.text()).toBe('assigned');
  });

  it('should preserve the default not-found response', async () => {
    const server = createDefaultServer();

    const response = await server.request('/missing');

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(404);
  });

  it('should keep request contexts isolated across concurrent handlers', async () => {
    const server = createDefaultServer();
    server.get('/:id', async c => {
      expect(useHonoContext()).toBe(c);
      await Promise.resolve();
      expect(useHonoContext()).toBe(c);
      return c.text(c.req.param('id'));
    });

    const responses = await Promise.all([
      server.request('/first'),
      server.request('/second'),
    ]);

    expect(
      await Promise.all(responses.map(response => response.text())),
    ).toEqual(['first', 'second']);
  });
});

describe('server disposal', () => {
  const createRuntime = () => {
    const server = createServerBase({
      config: getDefaultConfig(),
      pwd: '',
      appContext: getDefaultAppContext(),
    });
    server.addPlugins(createDefaultPlugins({ logger: false }));
    return server;
  };

  it('registers disposal before a later synchronous plugin setup fails', async () => {
    const server = createRuntime();
    const dispose = rstest.fn();
    const setupError = new Error('later setup failed');
    server.addPlugins([
      {
        name: 'resource',
        setup: api => {
          api.onDispose(dispose);
        },
      },
      {
        name: 'failure',
        setup: () => {
          throw setupError;
        },
      },
    ]);

    await expect(server.init()).rejects.toBe(setupError);
    expect(dispose).toHaveBeenCalledTimes(1);
    await server.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans registered resources when modifyConfig fails', async () => {
    const server = createRuntime();
    const dispose = rstest.fn();
    const configError = new Error('config failed');
    server.addPlugins([
      {
        name: 'resource',
        setup(api) {
          api.onDispose(dispose);
          api.modifyConfig(() => {
            throw configError;
          });
        },
      },
    ]);
    await expect(server.init()).rejects.toBe(configError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves an asynchronous prepare failure when cleanup also fails', async () => {
    const server = createRuntime();
    const prepareError = new Error('prepare failed');
    const cleanupError = new Error('cleanup failed');
    const errorSpy = rstest.spyOn(logger, 'error').mockImplementation(() => {});
    const dispose = rstest.fn(async () => {
      throw cleanupError;
    });
    server.addPlugins([
      {
        name: 'resource',
        setup(api) {
          api.onDispose(dispose);
          api.onPrepare(async () => {
            throw prepareError;
          });
        },
      },
    ]);
    try {
      await expect(server.init()).rejects.toBe(prepareError);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: [cleanupError],
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('attempts every resource in reverse registration order after failures', async () => {
    const server = createRuntime();
    const order: string[] = [];
    const syncError = new Error('synchronous cleanup');
    const asyncError = new Error('asynchronous cleanup');
    server.onDispose(() => {
      order.push('first');
    });
    server.onDispose(async () => {
      order.push('second');
      throw asyncError;
    });
    server.onDispose(() => {
      order.push('third');
      throw syncError;
    });

    await expect(server.dispose()).rejects.toMatchObject({
      errors: [syncError, asyncError],
    });
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('retires synchronously and shares concurrent and repeated disposal', async () => {
    const server = createRuntime();
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const dispose = rstest.fn(() => pending);
    server.onDispose(dispose);

    const first = server.dispose();
    expect(server.dispose()).toBe(first);
    expect(() => server.onDispose(() => {})).toThrow('retired server');
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(server.dispose()).toBe(first);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('allows a resource to unregister before retirement', async () => {
    const server = createRuntime();
    const dispose = rstest.fn();
    const unregister = server.onDispose(dispose);
    unregister();
    unregister();
    await server.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });
});
