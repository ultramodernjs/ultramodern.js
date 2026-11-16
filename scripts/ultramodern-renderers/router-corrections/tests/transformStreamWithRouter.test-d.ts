import type { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { describe, expectTypeOf, it } from 'vitest';
import type { AnyRouter } from '../src';
import type { transformReadableStreamWithRouter } from '../src/ssr/server';
import type { transformPipeableStreamWithRouter } from '../src/ssr/server.node';

declare const router: AnyRouter;
declare const pipeable: Readable;

describe('SSR stream adapter types', () => {
  it('preserves the Node pipeable input and output', () => {
    expectTypeOf<typeof transformPipeableStreamWithRouter>().toBeCallableWith(
      router,
      pipeable,
    );
    expectTypeOf<
      ReturnType<typeof transformPipeableStreamWithRouter>
    >().toEqualTypeOf<Readable>();
  });

  it('accepts Web byte and string streams', () => {
    type Input = Parameters<typeof transformReadableStreamWithRouter>[1];
    expectTypeOf<ReadableStream<Uint8Array>>().toExtend<Input>();
    expectTypeOf<ReadableStream<string>>().toExtend<Input>();
    expectTypeOf<ReadableStream<Uint8Array | string>>().toExtend<Input>();
    expectTypeOf<ReadableStream<number>>().not.toExtend<Input>();
  });

  it('accepts Node Web streams through the portable transform', () => {
    type Input = Parameters<typeof transformReadableStreamWithRouter>[1];
    expectTypeOf<NodeReadableStream<Uint8Array>>().toExtend<Input>();
    expectTypeOf<NodeReadableStream<string>>().toExtend<Input>();
    expectTypeOf<NodeReadableStream<Uint8Array | string>>().toExtend<Input>();
  });
});
