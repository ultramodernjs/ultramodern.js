// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off
import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import { defineEffectBff } from '@modern-js/bff-effect/effect';
import * as Effect from 'effect/Effect';
import { HttpApiBuilder } from 'effect/http-api';
import * as Layer from 'effect/Layer';
import { bffEffectApi } from '../shared/effect-api';
import { bffRpcGroup } from '../shared/effect-rpc';

type TraceSpanProcessor = Exclude<
  NodeSdk.Configuration['spanProcessor'],
  ReadonlyArray<unknown> | undefined
>;

type FinishedSpan = Parameters<TraceSpanProcessor['onEnd']>[0];

type TraceSpanSnapshot = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

const traceSpans: TraceSpanSnapshot[] = [];

function toSpanSnapshot(span: FinishedSpan): TraceSpanSnapshot {
  const spanContext = span.spanContext();
  const parentSpanId = span.parentSpanContext?.spanId;
  return {
    name: span.name,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

function getTraceSpans(traceId?: string) {
  if (!traceId) {
    return [...traceSpans];
  }
  return traceSpans.filter(span => span.traceId === traceId);
}

const traceSpanProcessor: TraceSpanProcessor = {
  onStart: () => {},
  onEnd: (span: FinishedSpan) => {
    traceSpans.push(toSpanSnapshot(span));
  },
  forceFlush: async () => {
    await Promise.resolve();
  },
  shutdown: async () => {
    await Promise.resolve();
  },
};

const greetingsLayer = HttpApiBuilder.group(
  bffEffectApi,
  'greetings',
  handlers => {
    const handledHello = handlers.handle('hello', () =>
      Effect.succeed({
        message: 'Hello from Effect HttpApi',
        runtime: 'effect' as const,
      }),
    );

    const handledUserById = handledHello.handle(
      'userById',
      ({ params, query }) =>
        Effect.succeed({
          id: params.id,
          source: query.source ?? 'unknown',
        }),
    );

    const handledEcho = handledUserById.handle('echo', ({ payload }) =>
      Effect.succeed({
        echoed: payload.text,
      }),
    );

    const handledTraceRun = handledEcho.handle('traceRun', ({ headers }) =>
      Effect.gen(function* () {
        if (headers.traceparent) {
          yield* Effect.annotateCurrentSpan(
            'bff.traceparent',
            headers.traceparent,
          );
        }
        yield* Effect.succeed('ok').pipe(
          Effect.withSpan('bff.effect.db.query', {
            attributes: {
              'db.system': 'effect-test',
              'db.operation': 'select',
            },
            kind: 'client',
            root: false,
          }),
        );
        return {
          status: 'ok',
          traceparent: headers.traceparent,
        };
      }).pipe(Effect.withSpan('bff.effect.trace.run', { kind: 'server' })),
    );

    const handledTraceSpans = handledTraceRun.handle(
      'traceSpans',
      ({ query }) =>
        Effect.succeed({
          spans: getTraceSpans(query.traceId),
        }),
    );

    const handledTraceReset = handledTraceSpans.handle('traceReset', () =>
      Effect.sync(() => {
        traceSpans.length = 0;
        return {
          ok: true,
        };
      }),
    );

    return handledTraceReset.handle('managedFailure', () =>
      Effect.succeed({
        message: 'unreachable',
      }),
    );
  },
);

const layer = HttpApiBuilder.layer(bffEffectApi).pipe(
  Layer.provide(greetingsLayer),
  Layer.provideMerge(
    NodeSdk.layer(() => ({
      spanProcessor: traceSpanProcessor,
      resource: {
        serviceName: 'modernjs-bff-effect-tests',
      },
    })),
  ),
);

const rpcLayer = bffRpcGroup.toLayer(
  bffRpcGroup.of({
    ping: ({ name }) =>
      Effect.succeed({
        message: `Hello from Effect RPC, ${name}`,
      }).pipe(Effect.withSpan('bff.rpc.ping')),
  }),
);

const runtime = defineEffectBff({
  api: bffEffectApi,
  layer,
  interceptRequest: ({ request, next }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/managed') {
      const managedError = new Error('Managed effect error') as Error & {
        status?: number;
      };
      managedError.status = 503;
      throw managedError;
    }
    return next();
  },
  rpc: {
    group: bffRpcGroup,
    layer: rpcLayer,
    path: '/rpc',
  },
});

export default runtime;
