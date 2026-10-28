import { initHooks } from '@modern-js/plugin/runtime';
import { storage } from '@modern-js/runtime-utils/node';
import React from 'react';
import { JSX_SHELL_STREAM_END_MARK } from '../../../src/common';
import {
  getInitialContext,
  setGlobalContext,
  setGlobalInternalRuntimeContext,
} from '../../../src/core/context';
import { createReadableStreamFromElement } from '../../../src/core/server/stream/createReadableStream.worker';

const install = () => {
  setGlobalContext({ enableRsc: false });
  const hooks = initHooks<{}, ReturnType<typeof getInitialContext>>();
  setGlobalInternalRuntimeContext({ hooks });
  return hooks;
};
const options = () =>
  ({
    runtimeContext: Object.assign(getInitialContext(false), {
      initialData: {},
      __i18nData__: {},
      ssrContext: { request: { headers: {} }, reporter: {} },
    }),
    htmlTemplate: '<html><head></head><body><!--<?- html ?>--></body></html>',
    resource: {
      entryName: 'main',
      htmlTemplate: '<html></html>',
      routeManifest: {},
    },
    config: {},
    ssrConfig: {},
    entryName: 'main',
    onError: rs.fn(),
  }) as unknown as Parameters<typeof createReadableStreamFromElement>[2];
const render = (
  root: React.ReactElement,
  opts = options(),
  request = new Request('http://localhost/'),
) =>
  storage.run({}, () => createReadableStreamFromElement(request, root, opts));

test('worker orders transforms and preserves split UTF-8 shell/tail until delivered EOF', async () => {
  const hooks = install();
  const terminal = rs.fn();
  const opts = options();
  hooks.extendStreamSSR.tap(info => {
    expect(info.runtimeContext).toBe(opts.runtimeContext);
    expect(info.resource).toBe(opts.resource);
    expect(info.config).toBe(opts.config);
    expect(info.platform).toBe('web');
    return {
      streamPhase: 'body',
      modifyRootElement(root) {
        return root;
      },
      beforeReact() {},
      processReadableStream(source) {
        return source;
      },
      onTerminal: terminal,
    };
  });
  hooks.extendStreamSSR.tap(() => ({
    processReadableStream(source) {
      return source.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            for (const byte of chunk) controller.enqueue(Uint8Array.of(byte));
          },
        }),
      );
    },
  }));
  const stream = await render(
    <>
      <p>α🌐</p>
      {`${JSX_SHELL_STREAM_END_MARK}尾`}
    </>,
    opts,
  );
  expect(terminal).not.toHaveBeenCalled();
  expect(await new Response(stream).text()).toBe(
    '<html><head></head><body><p>α🌐</p></body></html>尾',
  );
  expect(terminal).toHaveBeenCalledExactlyOnceWith({ status: 'complete' });
});

test('worker seals the shell after completed route content', async () => {
  const hooks = install();
  const shells: string[] = [];
  hooks.extendStreamSSR.tap(() => ({
    completedBody(html, { phase }) {
      if (phase === 'shell') shells.push(html);
      return html;
    },
  }));
  const content = 'Route content. '.repeat(1000);
  const stream = await render(
    <>
      <div id="app">
        <React.Suspense fallback="loading">
          <main>{content}</main>
        </React.Suspense>
      </div>
      {JSX_SHELL_STREAM_END_MARK}
    </>,
  );
  await new Response(stream).text();
  expect(shells).toHaveLength(1);
  expect(shells[0]).toContain(`<main>${content}</main>`);
});

test('worker missing marker is a delivered stream error reported once', async () => {
  const hooks = install();
  const terminal = rs.fn();
  hooks.extendStreamSSR.tap(() => ({ onTerminal: terminal }));
  const opts = options();
  const stream = await render(<p>incomplete</p>, opts);
  await expect(new Response(stream).text()).rejects.toThrow(
    'ended before the shell marker',
  );
  expect(terminal).toHaveBeenCalledExactlyOnceWith({
    status: 'error',
    error: expect.any(Error),
  });
  expect(opts.onError).toHaveBeenCalledTimes(1);
});

test('request abort settles the real worker body as one cancellation', async () => {
  const hooks = install();
  const terminal = rs.fn();
  hooks.extendStreamSSR.tap(() => ({ onTerminal: terminal }));
  const never = new Promise<never>(() => {});
  const Suspend = (): never => {
    throw never;
  };
  const abort = new AbortController();
  const opts = options();
  const stream = await render(
    <>
      <React.Suspense fallback={<p>shell</p>}>
        <Suspend />
      </React.Suspense>
      {JSX_SHELL_STREAM_END_MARK}
    </>,
    opts,
    new Request('http://localhost/', { signal: abort.signal }),
  );
  const failure = new Error('request stopped');
  abort.abort(failure);
  await expect(new Response(stream).text()).rejects.toBe(failure);
  expect(terminal).toHaveBeenCalledExactlyOnceWith({
    status: 'cancelled',
    reason: failure,
  });
  expect(opts.onError).not.toHaveBeenCalled();
});

test('response transforms observe the assembled worker document before terminal completion', async () => {
  const hooks = install();
  const terminal = rs.fn();
  let response = '';
  hooks.extendStreamSSR.tap(() => ({
    onTerminal: terminal,
    processResponseStream(source) {
      const decoder = new TextDecoder();
      return source.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            expect(terminal).not.toHaveBeenCalled();
            response += decoder.decode(chunk, { stream: true });
            controller.enqueue(chunk);
          },
        }),
      );
    },
  }));
  const stream = await render(
    <>
      <main>response</main>
      {JSX_SHELL_STREAM_END_MARK}
    </>,
  );
  expect(await new Response(stream).text()).toBe(response);
  expect(response).toContain('<html><head>');
  expect(response).toContain('<body><main>response</main></body></html>');
  expect(terminal).toHaveBeenCalledExactlyOnceWith({ status: 'complete' });
});
