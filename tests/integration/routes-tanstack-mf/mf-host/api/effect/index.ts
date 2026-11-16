import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import { defineEffectBff } from '@modern-js/bff-effect/effect';
import { createRequestContextHeaders } from '@modern-js/runtime-extensions/request-context';
import * as Effect from 'effect/Effect';
import { Headers, HttpTraceContext } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { hostEffectApi } from '../../shared/effect/api';

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

type TraceHeaders = Record<string, string | undefined>;
type TraceHandlerArgs = {
  headers: TraceHeaders;
  request: {
    headers: TraceHeaders;
  };
};
type TraceQueryArgs = {
  query: {
    traceId?: string;
  };
};

const traceSpans: TraceSpanSnapshot[] = [];
const remoteOrigin = process.env.MF_REMOTE_ORIGIN ?? 'http://localhost:3010';

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

function toTraceparentHeader(span: {
  traceId: string;
  spanId: string;
  sampled: boolean;
}) {
  return `00-${span.traceId}-${span.spanId}-${span.sampled ? '01' : '00'}`;
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
  hostEffectApi,
  'greetings',
  handlers => {
    const handledHello = handlers.handle('hello', () =>
      Effect.succeed({
        message: 'Hello from host Effect API',
        runtime: 'host' as const,
      }),
    );

    const handledTraceRun = handledHello.handle(
      'traceRun',
      ({ request }: TraceHandlerArgs) => {
        const locale = request.headers['accept-language'] ?? undefined;
        const parentSpan = Option.match(
          HttpTraceContext.w3c(Headers.fromInput(request.headers)),
          {
            onNone: () => undefined,
            onSome: value => value,
          },
        );

        return Effect.gen(function* () {
          const remoteResponse = yield* Effect.gen(function* () {
            const currentSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
            const requestHeaders = createRequestContextHeaders({
              locale,
              traceparent: toTraceparentHeader(currentSpan),
            });

            return yield* Effect.tryPromise(() =>
              fetch(`${remoteOrigin}/remote-api/effect/trace/child`, {
                method: 'GET',
                headers: requestHeaders,
              }),
            ).pipe(Effect.orDie);
          }).pipe(
            Effect.withSpan('mf.host.trace.remote.call', {
              kind: 'client',
            }),
          );

          if (!remoteResponse.ok) {
            yield* Effect.die(
              new Error(
                `Remote trace call failed with status ${remoteResponse.status}`,
              ),
            );
          }

          const remoteBody = yield* Effect.tryPromise(
            () =>
              remoteResponse.json() as Promise<{
                status?: 'ok';
                locale?: string;
                traceparent?: string;
              }>,
          ).pipe(Effect.orDie);
          const remoteStatus = remoteBody.status ?? 'ok';
          const remoteLocale = remoteBody.locale;

          return {
            status: 'ok' as const,
            traceparent: remoteBody.traceparent,
            remoteStatus,
            ...(locale ? { locale } : {}),
            ...(remoteLocale ? { remoteLocale } : {}),
          };
        }).pipe(
          Effect.withSpan('mf.host.trace.run', {
            parent: parentSpan,
            kind: 'server',
          }),
        );
      },
    );

    const handledTraceSpans = handledTraceRun.handle(
      'traceSpans',
      ({ query }: TraceQueryArgs) =>
        Effect.succeed({
          spans: getTraceSpans(query.traceId),
        }),
    );

    return handledTraceSpans.handle('traceReset', () =>
      Effect.sync(() => {
        traceSpans.length = 0;
        return {
          ok: true,
        };
      }),
    );
  },
);

const layer = HttpApiBuilder.layer(hostEffectApi).pipe(
  Layer.provide(greetingsLayer),
  Layer.provide(
    NodeSdk.layer(() => ({
      spanProcessor: traceSpanProcessor,
      resource: {
        serviceName: 'modernjs-mf-host-tests',
      },
    })).pipe(Layer.orDie),
  ),
);

export default defineEffectBff({
  api: hostEffectApi,
  layer,
});
