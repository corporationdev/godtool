// ---------------------------------------------------------------------------
// Shared execution stack — the wiring that turns an organization into a
// runnable executor + engine. Used by the protected HTTP API (per-request)
// and the MCP session DO (per-session) so changes to the stack flow to both.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";

import { withExecutionUsageTracking } from "../api/execution-usage";
import { AutumnService } from "./autumn";
import { DeviceExecutionError, makeDeviceFirstCodeExecutor } from "./device-code-executor";
import { createScopedExecutor } from "./executor";

export const makeExecutionStack = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const executor = yield* createScopedExecutor(
      userId,
      organizationId,
      organizationName,
    ).pipe(Effect.withSpan("McpSessionDO.createScopedExecutor"));
    const autumn = yield* AutumnService;
    const hostedFallbackAllowed = yield* autumn.isFeatureAllowed(
      organizationId,
      "hosted-worker-fallback",
    );
    const fallbackCodeExecutor = hostedFallbackAllowed
      ? makeDynamicWorkerExecutor({ loader: env.LOADER })
      : {
          execute: () =>
            Effect.fail(
              new DeviceExecutionError({
                message: "Hosted worker fallback requires the Pro plan",
                status: 402,
              }),
            ),
        };
    const codeExecutor = makeDeviceFirstCodeExecutor({
      fallback: fallbackCodeExecutor,
      organizationId,
      organizationName,
      userId,
    });
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor }),
      (orgId) => Effect.runFork(autumn.trackExecution(orgId)),
    );
    return { executor, engine };
  }).pipe(Effect.withSpan("McpSessionDO.makeExecutionStack"));
