import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as OpenTelemetry from '@effect/opentelemetry';
import * as NodeSdk from '@effect/opentelemetry/NodeSdk';
import * as WebSdk from '@effect/opentelemetry/WebSdk';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import * as Effect from 'effect/Effect';
import * as Metric from 'effect/Metric';

class Spans extends InMemorySpanExporter {
  snapshot: ReturnType<InMemorySpanExporter['getFinishedSpans']> = [];
  shutdowns = 0;
  override shutdown() {
    this.snapshot = [...this.getFinishedSpans()];
    this.shutdowns++;
    return super.shutdown();
  }
}
class Logs extends InMemoryLogRecordExporter {
  snapshot: ReturnType<InMemoryLogRecordExporter['getFinishedLogRecords']> = [];
  shutdowns = 0;
  override shutdown() {
    this.snapshot = [...this.getFinishedLogRecords()];
    this.shutdowns++;
    return super.shutdown();
  }
}
class Metrics extends InMemoryMetricExporter {
  snapshot: ReturnType<InMemoryMetricExporter['getMetrics']> = [];
  shutdowns = 0;
  override shutdown() {
    this.snapshot = [...this.getMetrics()];
    this.shutdowns++;
    return super.shutdown();
  }
}
class SpanProcessor extends SimpleSpanProcessor {
  flushes = 0;
  override forceFlush() {
    this.flushes++;
    return super.forceFlush();
  }
}
class LogProcessor extends SimpleLogRecordProcessor {
  flushes = 0;
  override forceFlush() {
    this.flushes++;
    return super.forceFlush();
  }
}
assert.equal(
  'NodeSdk' in OpenTelemetry,
  false,
  'current BFF OpenTelemetry.NodeSdk consumer needs migration to explicit subpath',
);
assert(process.env.BFF_TELEMETRY_SOURCE);
const batchTelemetry = await import(
  pathToFileURL(process.env.BFF_TELEMETRY_SOURCE).href
);
assert.equal(
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  ),
  true,
);
try {
  for (const platform of ['node', 'web']) {
    const spans = new Spans();
    const logs = new Logs();
    const metrics = new Metrics(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter: metrics,
      exportIntervalMillis: 60000,
    });
    const spanProcessor = new SpanProcessor({ exporter: spans });
    const logRecordProcessor = new LogProcessor({ exporter: logs });
    const counter = Metric.counter(`otel.compat.${platform}.requests`);
    const configuration = () => ({
      resource: { serviceName: `otel-compat-${platform}` },
      spanProcessor,
      logRecordProcessor,
      metricReader: reader,
      loggerMergeWithExisting: false,
    });
    const layer =
      platform === 'node'
        ? NodeSdk.layer(configuration)
        : WebSdk.layer(configuration);
    let childContext:
      | ReturnType<
          NonNullable<ReturnType<typeof trace.getActiveSpan>>['spanContext']
        >
      | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Metric.update(counter, 2);
        yield* Effect.log('latest-tuple-log');
        yield* Effect.promise(async () => {
          const before = trace.getActiveSpan();
          assert(
            before,
            'Effect child span visible through the OTel API singleton',
          );
          await Promise.resolve();
          assert.equal(
            trace.getActiveSpan(),
            before,
            'async context retains the exact span object',
          );
          childContext = before.spanContext();
          let observed = false;
          batchTelemetry.emitDataBatchTransportEvent(
            () => {
              observed = true;
            },
            {
              type: 'flush',
              endpoint: '/api/batch',
              batchId: 'latest-tuple',
              size: 2,
            },
          );
          assert.equal(observed, true);
        });
        yield* Effect.promise(() => reader.forceFlush());
      }).pipe(
        Effect.withSpan('latest-tuple-child'),
        Effect.withSpan('latest-tuple-parent'),
        Effect.provide(layer),
      ),
    );
    assert.equal(spans.snapshot.length, 2);
    const child = spans.snapshot.find(
      span => span.name === 'latest-tuple-child',
    );
    const parent = spans.snapshot.find(
      span => span.name === 'latest-tuple-parent',
    );
    assert(child && parent && childContext);
    assert.deepEqual(child.spanContext(), childContext);
    assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId);
    assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
    assert.equal(child.events[0]?.name, 'modernjs.data.batch');
    assert.equal(
      child.resource.attributes['service.name'],
      `otel-compat-${platform}`,
    );
    assert.equal(logs.snapshot.length, 1);
    assert.equal(logs.snapshot[0]?.body, 'latest-tuple-log');
    assert.equal(logs.snapshot[0]?.spanContext?.spanId, childContext.spanId);
    const exported = metrics.snapshot.flatMap(item =>
      item.scopeMetrics.flatMap(scope => scope.metrics),
    );
    const metric = exported.find(
      item => item.descriptor.name === `otel.compat.${platform}.requests`,
    );
    assert(metric);
    assert.equal(metric.dataPoints[0]?.value, 2);
    assert.equal(spanProcessor.flushes, 1);
    assert.equal(logRecordProcessor.flushes, 1);
    assert.equal(spans.shutdowns, 1);
    assert.equal(logs.shutdowns, 1);
    assert.equal(metrics.shutdowns, 1);
    await assert.rejects(reader.collect(), /shutdown/i);
    console.log(
      JSON.stringify({
        platform,
        spans: spans.snapshot.length,
        logs: logs.snapshot.length,
        metricValue: metric.dataPoints[0]?.value,
        spanFlushes: spanProcessor.flushes,
        logFlushes: logRecordProcessor.flushes,
        shutdowns: [spans.shutdowns, logs.shutdowns, metrics.shutdowns],
        contextIdentity: true,
      }),
    );
  }
} finally {
  context.disable();
}

const directExporter = new Metrics(AggregationTemporality.CUMULATIVE);
const directReader = new PeriodicExportingMetricReader({
  exporter: directExporter,
  exportIntervalMillis: 60000,
});
const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({ 'service.name': 'direct-latest-meter' }),
  readers: [directReader],
});
meterProvider.getMeter('compat').createCounter('direct.counter').add(3);
await meterProvider.forceFlush();
await meterProvider.shutdown();
const directCounter = directExporter.snapshot
  .flatMap(item => item.scopeMetrics.flatMap(scope => scope.metrics))
  .find(metric => metric.descriptor.name === 'direct.counter');
assert(directCounter);
assert.equal(directCounter.dataPoints[0]?.value, 3);
assert.equal(directExporter.shutdowns, 1);
console.log(
  'PASS direct latest MeterProvider construction/export/flush/shutdown',
);

// Exercise the real latest OTLP HTTP serializers and transports, not a mocked exporter.
const { createServer } = await import('node:http');
const { OTLPTraceExporter } = await import(
  '@opentelemetry/exporter-trace-otlp-http'
);
const { OTLPLogExporter } = await import(
  '@opentelemetry/exporter-logs-otlp-http'
);
const { OTLPMetricExporter } = await import(
  '@opentelemetry/exporter-metrics-otlp-http'
);
const received: Array<{ path: string; body: string }> = [];
const collector = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => {
    body += chunk;
  });
  request.on('end', () => {
    received.push({ path: request.url ?? '', body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
try {
  const address = collector.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: 60000,
  });
  const layer = NodeSdk.layer(() => ({
    resource: { serviceName: 'latest-real-otlp' },
    loggerMergeWithExisting: false,
    spanProcessor: new SimpleSpanProcessor({
      exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    }),
    logRecordProcessor: new SimpleLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
    }),
    metricReader,
  }));
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Metric.update(Metric.counter('otlp.actual.counter'), 3);
      yield* Effect.log('otlp-actual-log');
      yield* Effect.promise(() => metricReader.forceFlush());
    }).pipe(Effect.withSpan('otlp-actual-span'), Effect.provide(layer)),
  );
  for (const [url, property, expected] of [
    ['/v1/traces', 'resourceSpans', 'otlp-actual-span'],
    ['/v1/logs', 'resourceLogs', 'otlp-actual-log'],
    ['/v1/metrics', 'resourceMetrics', 'otlp.actual.counter'],
  ]) {
    const request = received.find(item => item.path === url);
    assert(request);
    assert(property in JSON.parse(request.body));
    assert(request.body.includes(expected));
    assert(request.body.includes('latest-real-otlp'));
  }
  console.log(
    'PASS real latest OTLP HTTP traces/logs/metrics serialization and export',
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    collector.close(error => (error ? reject(error) : resolve())),
  );
}
