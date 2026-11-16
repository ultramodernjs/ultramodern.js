import { createRequestSession } from '@modern-js/renderer-core/session';
import {
  getHydrationWriter,
  HydrationScript,
  renderToStream,
  ssr,
} from '@solidjs/web';
import {
  createJSONDeserializer,
  createSerializer,
  type SerovalNode,
  serializeJSON,
} from '@solidjs/web/serialization';
import {
  createComponent,
  createMemo,
  Errored,
  Loading,
  onCleanup,
} from 'solid-js';
import { nativePromiseSerializationPlugin } from '../../src/native-promise-serialization';
import { preparePublicLoaderData } from '../../src/router-binding/publicMatchData';

const key = 'promise-plugin:native-writer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function writerStream(value: unknown, signal?: AbortSignal) {
  return renderToStream(
    () => {
      const writer = getHydrationWriter();
      if (!writer) throw new Error('Expected a native hydration writer.');
      writer.write(key, value);
      return [
        createComponent(HydrationScript, {}),
        ssr('<main>native promise writer</main>'),
      ];
    },
    {
      renderId: 'promise-plugin:',
      plugins: [nativePromiseSerializationPlugin],
      signal,
    },
  );
}

/** Decode only actual native writer output in a clean, same-realm unit host.
 * Browser parser-time events remain the responsibility of admission fixtures. */
function nativeDecoder() {
  const names = ['window', 'self', 'document', '_$HY', '$R'];
  const previous = new Map(
    names.map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  if (previous.get('_$HY'))
    throw new Error('Expected a clean native hydration registry.');
  for (const name of ['window', 'self'])
    Object.defineProperty(globalThis, name, {
      value: globalThis,
      configurable: true,
    });
  Object.defineProperty(globalThis, 'document', {
    value: new EventTarget(),
    configurable: true,
  });
  return {
    write(html: string) {
      for (const script of html.matchAll(
        /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g,
      ))
        new Function(script[1])();
    },
    read(recordKey = key) {
      const registry = Object.getOwnPropertyDescriptor(
        globalThis,
        '_$HY',
      )?.value;
      const value = registry?.r?.[recordKey];
      if (!value) throw new Error('Expected the actual native writer record.');
      return value;
    },
    close() {
      for (const name of names) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('SSR native Promise serialization candidate', () => {
  test('native writer preserves aliases, fulfilled cycles, and nested native promises', async () => {
    const source = deferred<unknown>();
    const nested = Promise.resolve('native nested value');
    const value: Record<string, unknown> = {
      text: 'native fulfilled value',
      original: source.promise,
      nested,
    };
    value.cycle = value;
    const reading = new Response(
      writerStream({ first: source.promise, alias: source.promise, nested })
        .readable,
    ).text();
    source.resolve(value);
    const html = await reading;
    const decoder = nativeDecoder();
    try {
      decoder.write(html);
      const record = decoder.read();
      expect(record.first).toBeInstanceOf(Promise);
      expect(record.first === record.alias).toBe(true);
      expect(record.first.s).toBe(1);
      expect(record.first.v.cycle === record.first.v).toBe(true);
      expect(record.first.v.original === record.first).toBe(true);
      expect(record.first.v.nested === record.nested).toBe(true);
      expect(await record.nested).toBe('native nested value');
      expect((await record.first) === record.first.v).toBe(true);
      expect(Object.getOwnPropertyNames(source.promise)).toEqual([]);
    } finally {
      decoder.close();
    }
  });

  test('already rejected native writer slots are observed before consumers subscribe', async () => {
    const source = deferred<unknown>();
    const reason = {
      message: 'public rejected value',
      original: source.promise,
    };
    const reading = new Response(
      writerStream({ future: source.promise, alias: source.promise }).readable,
    ).text();
    source.reject(reason);
    const decoder = nativeDecoder();
    try {
      decoder.write(await reading);
      // The native promise is rejected before a consumer attaches. No global
      // rejection listener is installed; an unhandled event fails the runner.
      await nextTurn();
      const record = decoder.read();
      expect(record.future === record.alias).toBe(true);
      expect(record.future.s).toBe(2);
      expect(record.future.v.original === record.future).toBe(true);
      await expect(record.future).rejects.toBe(record.future.v);
      expect(Object.getOwnPropertyNames(source.promise)).toEqual([]);
    } finally {
      decoder.close();
    }
  });

  test('late native settlement keeps the exact pending promise and rejection reason', async () => {
    const source = deferred<unknown>();
    const reader = writerStream({
      future: source.promise,
    }).readable.getReader();
    const decoder = nativeDecoder();
    try {
      decoder.write(new TextDecoder().decode((await reader.read()).value));
      const promise = decoder.read().future;
      expect(promise).toBeInstanceOf(Promise);
      expect(promise.s).toBeUndefined();
      source.reject({ message: 'late native rejection' });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        decoder.write(new TextDecoder().decode(chunk.value));
      }
      await nextTurn();
      expect(decoder.read().future === promise).toBe(true);
      expect(promise.s).toBe(2);
      await expect(promise).rejects.toBe(promise.v);
      expect(promise.v).toMatchObject({ message: 'late native rejection' });
    } finally {
      source.resolve(undefined);
      decoder.close();
    }
  });

  test('two native writer keys retain one promise and one settled value', async () => {
    const source = Promise.resolve({ text: 'cross-key native value' });
    const native = renderToStream(
      () => {
        const writer = getHydrationWriter();
        if (!writer) throw new Error('Expected native writer.');
        writer.write(key, { future: source });
        writer.write(`${key}:second`, { future: source });
        return createComponent(HydrationScript, {});
      },
      {
        renderId: 'promise-plugin:',
        plugins: [nativePromiseSerializationPlugin],
      },
    );
    const decoder = nativeDecoder();
    try {
      decoder.write(await new Response(native.readable).text());
      const first = decoder.read().future;
      const second = decoder.read(`${key}:second`).future;
      expect(first === second).toBe(true);
      expect((await first) === (await second)).toBe(true);
    } finally {
      decoder.close();
    }
  });

  test('source reaction uses the intrinsic native then without reading an own getter', async () => {
    const source = Promise.resolve('intrinsic source value');
    let reads = 0;
    Object.defineProperty(source, 'then', {
      get() {
        reads += 1;
        throw new Error('Unexpected own then read.');
      },
    });
    const decoder = nativeDecoder();
    try {
      decoder.write(
        await new Response(writerStream({ future: source }).readable).text(),
      );
      expect(await decoder.read().future).toBe('intrinsic source value');
      expect(reads).toBe(0);
    } finally {
      decoder.close();
    }
  });

  test.each(['pending', 'fulfilled'])(
    'native direct memo retains %s fulfillment and Loading behavior',
    async state => {
      const source = deferred<string>();
      if (state === 'fulfilled') source.resolve('native memo value');
      const native = renderToStream(
        () => {
          const value = createMemo(() => source.promise);
          return createComponent(Loading, {
            fallback: ssr('<p>native memo loading</p>'),
            get children() {
              return ssr(['<p>', '</p>'], () => value());
            },
          });
        },
        { plugins: [nativePromiseSerializationPlugin] },
      );
      const reader = native.readable.getReader();
      let html = new TextDecoder().decode((await reader.read()).value);
      if (state === 'pending') expect(html).toContain('native memo loading');
      source.resolve('native memo value');
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        html += new TextDecoder().decode(chunk.value);
      }
      expect(html).toContain('native memo value');
    },
  );

  test('native Errored synchronous fallback still renders its own HTML', async () => {
    const native = renderToStream(
      () =>
        createComponent(Errored, {
          fallback: ssr('<p>native synchronous error fallback</p>'),
          get children(): never {
            throw new Error('native synchronous error');
          },
        }),
      { plugins: [nativePromiseSerializationPlugin] },
    );
    expect(await new Response(native.readable).text()).toContain(
      'native synchronous error fallback',
    );
  });

  test('native async memo rejection preserves baseline Errored recovery and error policy', async () => {
    const run = async (candidate: boolean) => {
      const source = deferred<string>();
      const hook = rstest.fn(() => new Error('public native fallback error'));
      const native = renderToStream(
        () =>
          createComponent(Errored, {
            fallback: ssr('<p>native error fallback</p>'),
            get children() {
              const value = createMemo(async () => await source.promise);
              return createComponent(Loading, {
                fallback: ssr('<p>native error loading</p>'),
                get children() {
                  return ssr(['<p>', '</p>'], () => value());
                },
              });
            },
          }),
        {
          plugins: candidate ? [nativePromiseSerializationPlugin] : undefined,
          onError: hook,
        },
      );
      const reader = native.readable.getReader();
      let html = new TextDecoder().decode((await reader.read()).value);
      expect(html).toContain('native error loading');
      source.reject(new Error('native async memo rejected'));
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        html += new TextDecoder().decode(chunk.value);
      }
      expect(hook).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ handling: 'fallback' }),
      );
      expect(html).toContain('public native fallback error');
      expect(html).toContain('native error fallback');
      return [...html.matchAll(/<template\b[^>]*>[\s\S]*?<\/template>/g)].map(
        match => match[0],
      );
    };
    // Compare rc22's native fallback templates with and without our serializer.
    // Eventual hydration still belongs to the owning browser fixture.
    const baseline = await run(false);
    expect(await run(true)).toEqual(baseline);
  });

  test('native cancellation releases the serializer before a source settles', async () => {
    const source = deferred<unknown>();
    const abort = new AbortController();
    const cleanup = rstest.fn();
    const native = renderToStream(
      () => {
        onCleanup(cleanup);
        const writer = getHydrationWriter();
        if (!writer) throw new Error('Expected native writer.');
        writer.write(key, { future: source.promise });
        return ssr('<p>native cancelled writer</p>');
      },
      { plugins: [nativePromiseSerializationPlugin], signal: abort.signal },
    );
    const reader = native.readable.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort(new Error('native connection cancelled'));
    await reader.cancel();
    source.reject(new Error('source rejected after native cancellation'));
    await nextTurn();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
  });

  test('the checked public owner still aborts unsafe fulfillment before native emission', async () => {
    const session = createRequestSession({
      request: new Request('https://native-promise.test/'),
      identity: {
        renderer: 'solid',
        appId: 'native-promise',
        entryName: 'main',
        protocolVersion: 1,
        buildId: 'build-a',
      },
      platform: { kind: 'node', bindings: {} },
    });
    session.resolveResponse({
      kind: 'document',
      status: 200,
      headers: [['content-type', 'text/html']],
      cache: { mode: 'public', maxAgeSeconds: 30 },
    });
    session.startRendering();
    const source = deferred<unknown>();
    const publicValue = preparePublicLoaderData(
      { future: source.promise },
      session,
    );
    const native = writerStream(publicValue, session.signal);
    const response = session.respond(native.readable);
    const reader = response.body!.getReader();
    const shell = new TextDecoder().decode((await reader.read()).value);
    let getterCalls = 0;
    const poison = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'native-private-poison-marker';
      },
    });
    source.resolve(poison);
    await expect(reader.read()).rejects.toBeInstanceOf(Error);
    expect(getterCalls).toBe(0);
    expect(shell).not.toContain('native-private-poison-marker');
    expect((await session.completion).state).toBe('failed');
    expect((await session.completion).cacheEligible).toBe(false);
    expect(Object.isFrozen(poison)).toBe(false);
  });

  test('a throwing native serializer error hook cannot leave a rejected reaction bridge', async () => {
    const source = deferred<unknown>();
    const failures: unknown[] = [];
    const done = rstest.fn();
    const serializer = createSerializer({
      globalIdentifier: 'nativePluginUnit',
      plugins: [nativePromiseSerializationPlugin],
      onData: () => undefined,
      onError(error) {
        failures.push(error);
        throw new Error('native error hook threw');
      },
      onDone: done,
    });
    serializer.write(key, { future: source.promise });
    serializer.flush();
    source.reject(() => 'unsupported native function');
    await nextTurn();
    expect(failures).toHaveLength(1);
    expect(done).toHaveBeenCalledTimes(1);
    serializer.close();
  });

  test('synchronous and asynchronous plugin parse modes fail closed', () => {
    const modes = nativePromiseSerializationPlugin.parse;
    const sync = Object.getOwnPropertyDescriptor(modes, 'sync')?.value;
    const async = Object.getOwnPropertyDescriptor(modes, 'async')?.value;
    expect(() => sync()).toThrow(/only supports streaming SSR hydration/);
    expect(() => async()).toThrow(/only supports streaming SSR hydration/);
  });

  test('the native JSON codec cannot adopt an SSR-only Promise plugin', async () => {
    const nodes: SerovalNode[] = [];
    const close = serializeJSON(
      { future: Promise.resolve('SSR-only value') },
      {
        plugins: [nativePromiseSerializationPlugin],
        onParse: node => nodes.push(node),
      },
    );
    await nextTurn();
    const decode = createJSONDeserializer({
      plugins: [nativePromiseSerializationPlugin],
    });
    expect(nodes.length).toBeGreaterThan(0);
    expect(() => decode(nodes[0])).toThrow();
    close();
  });
});
