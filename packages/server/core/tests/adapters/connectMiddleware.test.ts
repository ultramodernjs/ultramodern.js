import { EventEmitter } from 'node:events';
import type { RequestHandler } from '@modern-js/types/server';
import {
  connectMid2HonoMid,
  connectMockMid2HonoMid,
} from '../../src/adapters/node/hono';
import { run, useHonoContext } from '../../src/context';

const createContext = () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const context = { env: { node: { req, res } }, res: undefined } as any;
  return { context, res };
};

describe.each([
  { name: 'connectMid2HonoMid', adapt: connectMid2HonoMid },
  { name: 'connectMockMid2HonoMid', adapt: connectMockMid2HonoMid },
])('$name', ({ adapt }) => {
  it('settles when a three-argument middleware answers without next', async () => {
    const { context, res } = createContext();
    const next = rstest.fn(async () => {});
    const middleware = adapt((_req, _res, _next) => {
      setTimeout(() => res.emit('finish'), 0);
    });

    await middleware(context, next);

    expect(context.finalized).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('continues the chain when the middleware calls next', async () => {
    const { context, res } = createContext();
    const next = rstest.fn(async () => {
      res.emit('finish');
    });
    const middleware = adapt((_req, _res, done) => done());

    await middleware(context, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(context.finalized).toBeUndefined();
  });

  it('rejects with the error the middleware passes to next', async () => {
    const { context } = createContext();
    const error = new Error('boom');
    const handler: RequestHandler = (_req, _res, done) => {
      queueMicrotask(() => done(error));
    };
    const middleware = adapt(handler);

    await expect(middleware(context, async () => {})).rejects.toBe(error);
  });
  it('keeps request context when compilation resumes next outside its scope', async () => {
    const { context } = createContext();
    let complete: (() => void) | undefined;
    const middleware = adapt((_req, _res, done) => {
      complete = () => done();
    });
    const next = rstest.fn(async () => {
      expect(useHonoContext()).toBe(context);
    });
    const pending = run(context, () => middleware(context, next));
    expect(complete).toBeDefined();
    expect(() => useHonoContext()).toThrow('out of server scope');
    complete?.();
    await pending;
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a late next after the response finished', async () => {
    const { context, res } = createContext();
    let complete: (() => void) | undefined;
    const middleware = adapt((_req, _res, done) => {
      complete = () => done();
    });
    const next = rstest.fn(async () => {});
    const pending = middleware(context, next);
    res.emit('finish');
    complete?.();
    await pending;
    expect(context.finalized).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});

it('two-argument mock middleware waits for its handled response without dispatching next', async () => {
  const { context, res } = createContext();
  const next = rstest.fn(async () => {});
  const middleware = connectMockMid2HonoMid((_req, _res) => {
    setImmediate(() => res.emit('finish'));
  });
  await middleware(context, next);
  expect(context.finalized).toBe(true);
  expect(next).not.toHaveBeenCalled();
});
