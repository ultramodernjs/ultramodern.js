import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Operates only on an authenticated, operation-owned source extraction.
export function port(root) {
  for (const file of [
    'src/NodeSdk.ts',
    'src/WebSdk.ts',
    'src/OtelLogger.ts',
    'src/internal/metrics.ts',
  ]) {
    const target = path.join(root, file);
    let text = fs.readFileSync(target, 'utf8');
    text = text
      .replaceAll('LoggerProviderConfig', 'LoggerProviderOptions')
      .replaceAll('TracerConfig', 'TracerProviderOptions')
      .replaceAll('@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-trace')
      .replaceAll('@opentelemetry/sdk-trace-node', '@opentelemetry/sdk-trace')
      .replaceAll('@opentelemetry/sdk-trace-web', '@opentelemetry/sdk-trace')
      .replaceAll('new NodeTracerProvider(', 'new TracerProvider(')
      .replaceAll('new WebTracerProvider(', 'new TracerProvider(')
      .replaceAll('import { NodeTracerProvider }', 'import { TracerProvider }')
      .replaceAll('import { WebTracerProvider }', 'import { TracerProvider }');
    if (file.endsWith('metrics.ts')) {
      text = text.replace(
        'import type { InstrumentDescriptor } from "@opentelemetry/sdk-metrics/build/src/InstrumentDescriptor.js"',
        'import type { MetricDescriptor } from "@opentelemetry/sdk-metrics"',
      );
      text = text.replaceAll(
        'InstrumentDescriptor',
        'MetricDescriptorWithType',
      );
      text = text.replace(
        'const sdkName =',
        'type MetricDescriptorWithType = MetricDescriptor & { readonly type: InstrumentType }\n\nconst sdkName =',
      );
      text = text.replaceAll(/,\n( +)advice: \{\}/g, '');
    }
    fs.writeFileSync(target, text);
  }
  const target = path.join(root, 'package.json');
  const p = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(p.version, '4.1.4');
  for (const key of ['peerDependencies', 'devDependencies']) {
    for (const old of [
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/sdk-trace-node',
      '@opentelemetry/sdk-trace-web',
    ])
      delete p[key][old];
    for (const name of [
      '@opentelemetry/sdk-trace',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-metrics',
      '@opentelemetry/sdk-logs',
    ])
      p[key][name] = '^3.1.1';
  }
  for (const old of [
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-trace-web',
  ])
    delete p.peerDependenciesMeta[old];
  p.peerDependenciesMeta['@opentelemetry/sdk-trace'] = { optional: true };
  p.devDependencies['@opentelemetry/context-async-hooks'] = '^3.1.1';
  for (const name of [
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/otlp-exporter-base',
  ])
    p.devDependencies[name] = '^0.301.2';
  fs.writeFileSync(target, JSON.stringify(p, null, 2) + '\n');
}
