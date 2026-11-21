import diagnosticsChannel from 'node:diagnostics_channel';
import type { ServerContext } from '@modern-js/server-core';

/** One server bundle import, published after it settles. */
export interface RenderBundleLoadEvent {
  /** The serving application's output directory, when configured. */
  readonly distDirectory: ServerContext['distDirectory'];
  readonly filepath: string;
  readonly durationMs: number;
  readonly outcome: 'loaded' | 'failed';
  /** The request path that triggered the import, or `<startup>` for warmup. */
  readonly triggerPath: string;
}

/** One request through the server middlewares, traced from start to settle. */
export interface ServerRequestTrace {
  /** The serving application's output directory, when configured. */
  readonly distDirectory: ServerContext['distDirectory'];
  /** The request path, without its query. */
  readonly path: string;
}

/**
 * Process-wide, so every server in a process publishes here regardless of
 * which module format loaded this package. Node reports a subscriber's
 * exception as an uncaught exception.
 */
export const renderBundleLoadChannel =
  diagnosticsChannel.channel<RenderBundleLoadEvent>(
    'modern-js:server:render-bundle-load',
  );

/** Publishes `start` when a request enters and `asyncEnd` when it settles. */
export const serverRequestChannel =
  diagnosticsChannel.tracingChannel<ServerRequestTrace>(
    'modern-js:server:request',
  );
