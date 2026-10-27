import type { Context, ServerEnv } from '@modern-js/server-core';
import {
  DEFAULT_RUNTIME_STATUS_ENDPOINT,
  enforceRuntimeFallbackSignalAuth,
  enforceRuntimeFallbackSignalAuthToken,
  enforceRuntimeFallbackSignalTrustPolicy,
  getRuntimeSignalErrorStatusCode,
  parseRuntimeFallbackSignalPayload,
  persistRuntimeFallbackContractGate,
  type RuntimeFallbackSignalAuthConfig,
  type RuntimeFallbackSignalConfig,
  type RuntimeSignalError,
} from '../runtimeFallbackSignal';
import type {
  TelemetryHealthMonitor,
  TelemetryRegistry,
} from '../telemetryCore';

type RuntimeStatusMiddlewareOptions = {
  registry: TelemetryRegistry;
  healthMonitor?: TelemetryHealthMonitor;
  runtimeFallbackSignalConfig?: RuntimeFallbackSignalConfig;
  runtimeStatusAuthConfig?: RuntimeFallbackSignalAuthConfig;
};

const getRequestRemoteAddress = (c: Context<ServerEnv>) => {
  const env = c.env as
    | {
        node?: {
          req?: {
            socket?: {
              remoteAddress?: string;
            };
          };
        };
      }
    | undefined;
  const remoteAddress = env?.node?.req?.socket?.remoteAddress;
  return typeof remoteAddress === 'string' && remoteAddress.trim().length > 0
    ? remoteAddress.trim()
    : undefined;
};

export const createRuntimeFallbackSignalMiddleware = (
  signalConfig: RuntimeFallbackSignalConfig,
) => ({
  name: 'telemetry-runtime-fallback-signal',
  path: signalConfig.endpoint,
  method: 'post' as const,
  order: 'pre' as const,
  handler: async (c: Context<ServerEnv>): Promise<Response> => {
    try {
      enforceRuntimeFallbackSignalAuth(c, signalConfig);
      const { payload } = await parseRuntimeFallbackSignalPayload(
        c,
        signalConfig.maxBodyBytes,
      );
      const trustResult = enforceRuntimeFallbackSignalTrustPolicy(
        payload,
        signalConfig,
        {
          remoteAddress: getRequestRemoteAddress(c),
        },
      );
      if (trustResult.deduped) {
        return c.json({ ok: true, deduped: true }, 202);
      }
      await persistRuntimeFallbackContractGate(payload, signalConfig);
      return c.json({ ok: true }, 202);
    } catch (error) {
      const signalError = error as RuntimeSignalError;
      const status = getRuntimeSignalErrorStatusCode(signalError);
      return c.json(
        {
          ok: false,
          error:
            signalError instanceof Error
              ? signalError.message
              : String(signalError),
        },
        status,
      );
    }
  },
});

export const createRuntimeStatusMiddleware = ({
  registry,
  healthMonitor,
  runtimeFallbackSignalConfig,
  runtimeStatusAuthConfig,
}: RuntimeStatusMiddlewareOptions) => ({
  name: 'telemetry-runtime-status',
  path: DEFAULT_RUNTIME_STATUS_ENDPOINT,
  method: 'get' as const,
  order: 'pre' as const,
  handler: async (c: Context<ServerEnv>): Promise<Response> => {
    try {
      // Telemetry/health/trust internals are only disclosed to
      // authenticated callers. Without a configured auth token the
      // endpoint stays bare health probe.
      if (!runtimeStatusAuthConfig?.enabled) {
        return c.json({
          ok: true,
          timestamp: Date.now(),
        });
      }

      enforceRuntimeFallbackSignalAuthToken(
        c.req.header(runtimeStatusAuthConfig.headerName),
        runtimeStatusAuthConfig,
      );

      const healthSnapshot = healthMonitor?.getStatusSnapshot();
      return c.json({
        ok: true,
        timestamp: Date.now(),
        telemetry: {
          queueStats: registry.getQueueStats(),
          exporterHealth: registry.getExporterHealth(),
        },
        health: healthSnapshot
          ? {
              enabled: true,
              ...healthSnapshot,
            }
          : { enabled: false },
        runtimeFallbackSignal: runtimeFallbackSignalConfig
          ? {
              enabled: true,
              endpoint: runtimeFallbackSignalConfig.endpoint,
              gateName: runtimeFallbackSignalConfig.gateName,
              failureHoldMs: runtimeFallbackSignalConfig.failureHoldMs,
              maxBodyBytes: runtimeFallbackSignalConfig.maxBodyBytes,
              auth: {
                enabled: runtimeFallbackSignalConfig.auth.enabled,
                headerName: runtimeFallbackSignalConfig.auth.headerName,
              },
              trustPolicy: {
                allowedApps:
                  runtimeFallbackSignalConfig.trustPolicy.allowedApps,
                allowedEntryOrigins:
                  runtimeFallbackSignalConfig.trustPolicy.allowedEntryOrigins,
                enforceRuntimeDigest:
                  runtimeFallbackSignalConfig.trustPolicy.enforceRuntimeDigest,
                expectedRuntimeDigestsCount: Object.keys(
                  runtimeFallbackSignalConfig.trustPolicy
                    .expectedRuntimeDigests,
                ).length,
                maxSignalsPerWindow:
                  runtimeFallbackSignalConfig.trustPolicy.maxSignalsPerWindow,
                windowMs: runtimeFallbackSignalConfig.trustPolicy.windowMs,
                dedupeWindowMs:
                  runtimeFallbackSignalConfig.trustPolicy.dedupeWindowMs,
              },
            }
          : { enabled: false },
      });
    } catch (error) {
      const signalError = error as RuntimeSignalError;
      return c.json(
        {
          ok: false,
          error:
            signalError instanceof Error
              ? signalError.message
              : String(signalError),
        },
        getRuntimeSignalErrorStatusCode(signalError),
      );
    }
  },
});
