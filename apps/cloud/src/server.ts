import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

import { DeviceSessionDO as DeviceSessionDOBase } from "./device-session";
import { McpSessionDO as McpSessionDOBase } from "./mcp-session";

// ---------------------------------------------------------------------------
// OTEL config for the main fetch handler — `otel-cf-workers` owns the global
// TracerProvider and flushes via `ctx.waitUntil` at the end of each request.
// The DO runs in a separate isolate and uses its own self-contained WebSdk
// (see `services/telemetry.ts#DoTelemetryLive`); `instrumentDO` from
// otel-cf-workers is NOT used because it breaks `this` binding on
// `WorkerTransport`'s stream primitives and crashes every MCP request with
// DOMException "Illegal invocation".
// ---------------------------------------------------------------------------

// otel-cf-workers owns the global TracerProvider. Sentry's OTEL compat shim
// registers a ProxyTracerProvider of its own, which prevents otel-cf-workers
// from finding its WorkerTracer and breaks the whole request path with
// "global tracer is not of type WorkerTracer".
const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
  // Our DO methods (init/handleRequest/alarm) live on the prototype, not on
  // the instance. Sentry's default DO auto-wrap only visits own properties,
  // which misses prototype methods — so errors thrown inside init() never
  // reach Sentry. This flag opts into prototype-method instrumentation.
  instrumentPrototypeMethods: true,
});

// ---------------------------------------------------------------------------
// Durable Object — wrapped with Sentry so DO errors land in Sentry (inits the
// client inside the DO isolate, which plain `Sentry.captureException` cannot
// do on its own). We deliberately do NOT wrap with otel-cf-workers'
// `instrumentDO` (see note above).
// ---------------------------------------------------------------------------

export const McpSessionDO = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  McpSessionDOBase,
);

export const DeviceSessionDO = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  DeviceSessionDOBase,
);

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

// Skip OTLP wiring when no Axiom token is configured (dev without secrets).
// Otherwise the exporter ships every span with `Bearer ` (empty), which
// returns 401 on every batch and eventually drops the keep-alive socket —
// the Node http agent's unhandled `'error'` then crashes the process with
// ECONNRESET. It also registers otel-cf-workers' `WorkerTracer` as the
// global tracer; spans started outside its config ALS then die with
// "Config is undefined". Matches the gate in `DoTelemetryLive`.
// Keep the fetch path raw for now. MCP availability is more important than
// worker-level tracing, and the Effect spans already give enough local
// structure while debugging.
const rawFetch = handler.fetch;

const dispatchHandler = {
  fetch: (request: Request, env: Env, ctx: unknown) => {
    return (rawFetch as (req: Request, env: Env, ctx: unknown) => Response | Promise<Response>)(
      request,
      env,
      ctx,
    );
  },
};

export default Sentry.withSentry(sentryOptions, dispatchHandler);
