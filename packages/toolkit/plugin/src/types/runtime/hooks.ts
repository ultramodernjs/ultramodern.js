export type HandleRequestConfig = Record<string, any>;
export type ChunkSet = {
  renderLevel: any;
  ssrScripts: string;
  jsChunk: string;
  cssChunk: string;
};
export type SSRRenderInfo<RuntimeContext = object> = {
  /** The original request context, before public or RSC projection. */
  runtimeContext: RuntimeContext;
  request: Request;
  platform: 'node' | 'web';
  mode: 'string' | 'stream';
  isRsc: boolean;
  /** Original renderer resource and configuration; interpreted by extensions. */
  resource?: object;
  config?: object;
  /** Request-scoped monitors for diagnostics an extension detects mid-render. */
  monitors: {
    error(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
};

export type SSRHeadPart = { toString(): string };
export type SSRHeadData = Record<
  | 'htmlAttributes'
  | 'bodyAttributes'
  | 'title'
  | 'base'
  | 'link'
  | 'meta'
  | 'noscript'
  | 'script'
  | 'style',
  SSRHeadPart
> & { priority?: SSRHeadPart };

export type SSRRenderTerminal =
  | { status: 'complete' }
  | { status: 'fallback'; error: unknown }
  | { status: 'error'; error: unknown }
  | { status: 'cancelled'; reason: unknown };

export type SSRRenderAsset = { url?: string; filename?: string };

export type SSRAssetGroup<T extends SSRRenderAsset> = {
  name: string;
  assets: readonly T[];
};

export type SSRAssetTransformInfo<T extends SSRRenderAsset> = {
  kind: 'style' | 'script';
  source: 'loadable' | 'template';
  template: string;
  groups: readonly SSRAssetGroup<T>[];
  createAsset: (url: string) => T;
};

export type SSRTemplateChunk = {
  name: 'styles' | 'scripts' | 'data';
  template: string;
  placeholder: string;
  content: string;
  emittedAssets?: readonly string[];
  attributes?: Readonly<Record<string, unknown>>;
};

export type SSRHtmlFormatting = {
  attributesToString: (attributes: Record<string, unknown>) => string;
  hasStylesheetLink: (template: string, href: string) => boolean | undefined;
};

export type SSRRouterData = {
  loaderData?: unknown;
  errors?: Record<string, unknown> | null;
};

export interface SSRRenderLifecycle {
  /** Native asset objects keep their identity and are formatted after this hook. */
  transformAssets?: <T extends SSRRenderAsset>(
    assets: readonly T[],
    info: SSRAssetTransformInfo<T>,
  ) => readonly T[];
  /** Runs on each prepared chunk before native placeholder substitution. */
  transformTemplateChunk?: (
    chunk: SSRTemplateChunk,
    formatting: SSRHtmlFormatting,
  ) => SSRTemplateChunk;
  /** Raw router data is serialized by the native renderer; undefined uses its fallback. */
  getRouterData?: () => SSRRouterData | undefined;
  beforeReact?: () => void;
  /** Runs before the completed body or shell's head data is read. */
  completedBody?: (
    html: string,
    info: { phase: 'complete' | 'shell' },
  ) => string;
  getHeadData?: () => SSRHeadData | undefined;
  /** Exactly one notification for this render attempt. */
  onTerminal?: (terminal: SSRRenderTerminal) => void;
}

export type Collector = SSRRenderLifecycle & {
  collect?: (component: React.ReactElement) => React.ReactElement;
  effect: () => void | Promise<void>;
};

import type React from 'react';
import type {
  AsyncHook,
  AsyncInterruptHook,
  CollectSyncHook,
  SyncHook,
} from '../hooks';

export type OnBeforeRenderFn<RuntimeContext> = (
  context: RuntimeContext,
  interrupt: (info: any) => any,
) => Promise<any> | any;

export type SSRRequestRouterResult = {
  statusCode?: number;
  errors?: Record<string, unknown> | null;
};

export type SSRRequestPreparedInfo<RuntimeContext = object> = {
  runtimeContext: RuntimeContext;
  /** Native router metadata; extensions may supply another router's result. */
  routerResult?: SSRRequestRouterResult;
};

export type OnRenderPreparedFn<RuntimeContext> = (
  info: SSRRequestPreparedInfo<RuntimeContext>,
) =>
  | SSRRequestPreparedInfo<RuntimeContext>
  | void
  | Promise<SSRRequestPreparedInfo<RuntimeContext> | void>;

export type SSRRequestTerminal =
  | { status: 'complete' }
  | { status: 'error'; error: unknown }
  | { status: 'cancelled'; reason: unknown }
  | { status: 'discarded' };

export type SSRRequestEndInfo<RuntimeContext = object> = {
  runtimeContext: RuntimeContext;
  terminal: SSRRequestTerminal;
};

export type OnRequestEndFn<RuntimeContext> = (
  info: SSRRequestEndInfo<RuntimeContext>,
) => void | Promise<void>;

export type ExtendStringSSRCollectorsFn<RuntimeContext> = (
  context: RuntimeContext,
) => Collector;

export type StringSSRCollectorsInfo<RuntimeContext = object> = {
  chunkSet: ChunkSet;
  render: SSRRenderInfo<RuntimeContext>;
};

export type StreamSSRInfo<RuntimeContext = object> =
  SSRRenderInfo<RuntimeContext> & { terminalMarker: string };

export interface StreamSSRExtender extends SSRRenderLifecycle {
  init?: (params: {
    rootElement: React.ReactElement;
    forceStream2String: boolean;
  }) => void;

  modifyRootElement?: (rootElement: React.ReactElement) => React.ReactElement;

  getStyleTags?: () => string;

  processStream?: (stream: NodeJS.ReadWriteStream) => NodeJS.ReadWriteStream;

  processReadableStream?: (
    stream: ReadableStream<Uint8Array>,
  ) => ReadableStream<Uint8Array>;

  /** Runs after document assembly; cancellation must propagate to the input. */
  processResponseStream?: (
    stream: ReadableStream<Uint8Array>,
  ) => ReadableStream<Uint8Array>;

  /** Body transforms run after all render transforms, preserving order in each phase. */
  streamPhase?: 'render' | 'body';
}

export type ExtendStreamSSRFn<RuntimeContext = object> = (
  info: StreamSSRInfo<RuntimeContext>,
) => StreamSSRExtender;

export type WrapRootFn = (
  root: React.ComponentType<any>,
) => React.ComponentType<any>;

export type ResolveComponentFn = (
  component: React.ComponentType<any>,
  options: { name: string },
) => React.ComponentType<any>;

export type PickContextFn<RuntimeContext> = (
  context: RuntimeContext,
) => RuntimeContext;

export type RuntimeContextProjection<RuntimeContext> = {
  internalContext: RuntimeContext;
  publicContext: RuntimeContext;
};

export type TransformRuntimeContextFn<RuntimeContext> = (
  projection: RuntimeContextProjection<RuntimeContext>,
  options: {
    /** Original request context, unchanged across callbacks in the pipeline. */
    context: RuntimeContext;
    /** Whether the application's RSC mode is enabled. */
    isRsc: boolean;
  },
) => RuntimeContextProjection<RuntimeContext>;

export type ConfigFn<RuntimeConfig> = () => RuntimeConfig;

export type Hooks<RuntimeConfig, RuntimeContext> = {
  onBeforeRender: AsyncInterruptHook<OnBeforeRenderFn<RuntimeContext>>;
  /** Runs after preparation and before native status/error handling. */
  onRenderPrepared: AsyncHook<OnRenderPreparedFn<RuntimeContext>>;
  /** Runs once after response completion, cancellation, discard or failure. */
  onRequestEnd: AsyncHook<OnRequestEndFn<RuntimeContext>>;
  wrapRoot: SyncHook<WrapRootFn>;
  resolveComponent: SyncHook<ResolveComponentFn>;
  pickContext: SyncHook<PickContextFn<RuntimeContext>>;
  transformRuntimeContext: SyncHook<TransformRuntimeContextFn<RuntimeContext>>;
  config: CollectSyncHook<ConfigFn<RuntimeConfig>>;
  extendStringSSRCollectors: CollectSyncHook<
    ExtendStringSSRCollectorsFn<StringSSRCollectorsInfo<RuntimeContext>>
  >;
  extendStreamSSR: CollectSyncHook<ExtendStreamSSRFn<RuntimeContext>>;
};
