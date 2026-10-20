/** This entry contains identity only. Select client, router or server explicitly. */
export const SOLID_RENDERER_PROFILE = {
  renderer: 'solid',
  solid: '2.0.0-rc.15',
  web: '2.0.0-rc.15',
  router: '@modern-js/renderer-solid/router@3.8.3',
  routerSource: '4fbd65c5c3b40be87a6248867c22021c1c19bba8',
  routerCore: '1.171.38',
  history: '1.162.5',
  publicRouteData: {
    containers: ['plain-record', 'null-record', 'array'],
    values: 'canonical-scalars',
    deferred: 'checked-top-level-native-promises',
    mutation: 'immutable-public-snapshot',
    unsupported: ['Date', 'RegExp', 'Map', 'Set', 'AsyncIterable'],
  },
  publicContext: {
    source: 'managed-constructor-route-context-and-before-load',
    providerOverrides: 'unsupported',
  },
  nativePromiseMetadata: {
    runtime: '2.0.0-rc.15',
    fields: ['s', 'v'],
    status: [0, 1, 2],
    handle: 'sealed-with-checked-metadata',
  },
  nativeRegistry: {
    source: 'managed-router-match-transfer',
    rawRejectedMatchInjection: 'unsupported',
  },
  nativeRequestContext: {
    scope: 'complete-native-request-handler',
    event: 'one-per-request-session',
  },
  nativeResponseHead: {
    statusText: 'fetch-response-status-text',
    terminalOutcome: 'authoritative',
    cache: 'intersect-with-session-policy',
  },
  dataHttpTransport: 'renderer-core-rich-public-data',
} as const;
